package app.gongxingji.training.debug;

import java.io.*;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.*;

/** Bounded binary spool. A saved receipt is not proof of a durable backup. */
final class BinaryArchiveExport {
    interface Sessions { void require(String scope,String owner,String pin)throws Exception; }
    interface Events { void send(String id,String phase,Runnable guard)throws Exception; }
    interface Picker { void open(String id,String name)throws Exception; }
    interface Target { OutputStream open()throws Exception; }
    private static BinaryArchiveExport previous;
    private final File directory;
    private final ExecutorService worker;
    private final Sessions sessions;
    private final Events events;
    private final Picker picker;
    private final boolean enabled;
    private final long durationMillis;
    private final ScheduledThreadPoolExecutor deadlines=new ScheduledThreadPoolExecutor(1);
    private Transfer active;
    private File blockedCleanup;
    private boolean closed;
    private static final class Transfer {
        final String id,name,scope,owner,pin,sha256;
        final int expected;
        final long startedAt=System.nanoTime();
        final File file;
        final MessageDigest digest;
        FileOutputStream output;
        int written,sequence;
        String phase="upload";
        boolean cancelled,workScheduled;
        String terminal="cancelled";
        ScheduledFuture<?> deadline;
        Transfer(String id,String name,String scope,String owner,String pin,int bytes,String sha256,File file)throws Exception{
            this.id=id;this.name=name;this.scope=scope;this.owner=owner;this.pin=pin;
            this.expected=bytes;this.sha256=sha256;this.file=file;digest=MessageDigest.getInstance("SHA-256");
        }
    }
    BinaryArchiveExport(File cache,ExecutorService worker,Sessions sessions,Events events,Picker picker,boolean enabled)throws Exception{
        this(cache,worker,sessions,events,picker,enabled,120000);
    }
    /** Only package tests may shorten the deadline; the JS bridge cannot. */
    BinaryArchiveExport(File cache,ExecutorService worker,Sessions sessions,Events events,Picker picker,boolean enabled,long durationMillis)throws Exception{
        if(durationMillis<1||durationMillis>120000)throw new IOException("归档期限无效");
        this.worker=worker;this.sessions=sessions;this.events=events;this.picker=picker;this.enabled=enabled;this.durationMillis=durationMillis;
        deadlines.setRemoveOnCancelPolicy(true);
        directory=new File(cache,"gxj-media-archive-export-v1").getCanonicalFile();
        if(!directory.getParentFile().equals(cache.getCanonicalFile()))throw new IOException("归档临时目录无效");
        synchronized(BinaryArchiveExport.class){
            if(previous!=null){previous.close();if(previous.busy())throw new IOException("旧归档仍在取消，临时副本保留");}
            if(!directory.exists()&&!directory.mkdirs())throw new IOException("归档临时目录不可用");
            File[] files=directory.listFiles();if(files==null)throw new IOException("归档临时目录无法核对");
            // Only our own generated cache clones are candidates for stale cleanup.
            for(File file:files)if(file.getName().matches("gxj-archive-[a-f0-9-]{36}\\.part")&&file.isFile()
                &&file.getCanonicalFile().getParentFile().equals(directory)&&!file.delete())
                throw new IOException("旧归档临时副本尚未清理，原文件保留");
            previous=this;
        }
    }
    private void check(Transfer t)throws Exception{
        synchronized(this){if(closed||active!=t||t.cancelled
            ||System.nanoTime()-t.startedAt>=TimeUnit.MILLISECONDS.toNanos(durationMillis))
            throw new IOException("归档已取消、超时或页面已关闭");}
        sessions.require(t.scope,t.owner,t.pin);
    }
    synchronized void begin(String id,String name,String scope,String owner,String pin,int bytes,String sha256)throws Exception{
        if(!enabled||closed)throw new IOException("媒体归档尚未开放");
        if(active!=null)throw new IOException("请先完成或取消当前归档");
        if(id==null||!id.matches("archive-export-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
            ||name==null||name.length()>100||!name.matches("[A-Za-z0-9][A-Za-z0-9._-]*\\.zip")
            ||!PrivateMediaRequestPolicy.approved(scope)||owner==null||!owner.matches("[A-Za-z0-9_-]{1,128}")
            ||pin==null||!pin.matches("[a-f0-9]{64}")||sha256==null||!sha256.matches("[a-f0-9]{64}")
            ||bytes<1||bytes>PrivateMediaRequestPolicy.MAX_FILE_BYTES)throw new IOException("归档声明无效或超出50MiB");
        sessions.require(scope,owner,pin);
        if(blockedCleanup!=null){
            if(!blockedCleanup.getCanonicalFile().getParentFile().equals(directory)
                ||(blockedCleanup.exists()&&!blockedCleanup.delete()))throw new IOException("归档临时副本未清理，已停止新增");
            blockedCleanup=null;
        }
        if(directory.getUsableSpace()<bytes+1024L*1024L)throw new IOException("归档临时空间不足，原文件保留");
        File file=new File(directory,"gxj-archive-"+UUID.randomUUID()+".part");
        if(!file.createNewFile())throw new IOException("归档临时副本创建失败");
        Transfer t;
        try{t=new Transfer(id,name,scope,owner,pin,bytes,sha256,file);t.output=new FileOutputStream(file);}
        catch(Exception error){if(file.exists()&&!file.delete())blockedCleanup=file;throw error;}
        active=t;
        try{t.deadline=deadlines.schedule(()->stop(t,"cancelled"),durationMillis,TimeUnit.MILLISECONDS);}
        catch(RuntimeException error){stop(t,"error");throw error;}
    }
    synchronized void append(String id,int sequence,String encoded)throws Exception{
        Transfer t=active;
        try{
            if(t==null||!t.id.equals(id)||!"upload".equals(t.phase)||sequence!=t.sequence||encoded==null
                ||encoded.length()>4*((PrivateMediaRequestPolicy.CHUNK_BYTES+2)/3))throw new IOException("归档分块顺序或编码无效");
            check(t);byte[] bytes=Base64.getDecoder().decode(encoded);
            if(bytes.length!=Math.min(PrivateMediaRequestPolicy.CHUNK_BYTES,t.expected-t.written)||bytes.length<1
                ||!encoded.equals(Base64.getEncoder().encodeToString(bytes)))throw new IOException("归档分块超出声明或编码不规范");
            t.output.write(bytes);t.digest.update(bytes);t.written+=bytes.length;t.sequence++;
        }catch(Exception error){if(t!=null&&t.id.equals(id))stop(t,"error");throw error;}
    }
    synchronized void finish(String id)throws Exception{
        Transfer t=active;if(t==null||!t.id.equals(id)||!"upload".equals(t.phase))throw new IOException("归档标识无效");
        try{check(t);if(t.written!=t.expected)throw new IOException("归档分块尚未完整");t.phase="sealing";t.workScheduled=true;
            try{worker.execute(()->seal(t));}catch(RuntimeException error){t.workScheduled=false;throw error;}
        }catch(Exception error){stop(t,"error");throw error;}
    }
    private static String hex(byte[] value){StringBuilder out=new StringBuilder();for(byte item:value)out.append(String.format(Locale.ROOT,"%02x",item&255));return out.toString();}
    private void seal(Transfer t){
        boolean handed=false;
        try{
            check(t);if(!t.sha256.equals(hex(t.digest.digest())))throw new IOException("归档摘要不符");
            t.output.getFD().sync();t.output.close();t.output=null;check(t);
            synchronized(this){check(t);t.phase="ready";t.workScheduled=false;}
            picker.open(t.id,t.name);handed=true;
        }catch(Exception error){synchronized(this){t.cancelled=true;t.terminal="error";}}
        finally{if(!handed)complete(t);}
    }
    /** Called on the Activity UI thread immediately before opening its system picker. */
    synchronized void pickerLaunched(String id)throws Exception{
        Transfer t=active;if(t==null||!t.id.equals(id)||!"ready".equals(t.phase))throw new IOException("归档保存请求已过期");
        check(t);t.phase="picker";
    }
    synchronized boolean busy(){return active!=null;}
    void selected(String id,Target target){
        Transfer t;
        synchronized(this){
            t=active;if(t==null||!t.id.equals(id))return;
            try{if(!"picker".equals(t.phase)||target==null)throw new IOException("归档系统保存结果无效");check(t);
                t.phase="writing";t.workScheduled=true;
                try{worker.execute(()->write(t,target));}catch(RuntimeException error){t.workScheduled=false;throw error;}
            }catch(Exception error){stop(t,"error");}
        }
    }
    private void write(Transfer t,Target target){
        try{
            check(t);MessageDigest digest=MessageDigest.getInstance("SHA-256");int written=0;
            // Provider output is opened, written, flushed AND closed on the worker.
            try(InputStream input=new FileInputStream(t.file);OutputStream output=target.open()){
                if(output==null)throw new IOException("所选位置不可写");check(t);
                byte[] buffer=new byte[PrivateMediaRequestPolicy.CHUNK_BYTES];int read;
                while((read=input.read(buffer))!=-1){check(t);if(written+read>t.expected)throw new IOException("归档临时副本容量已变化");
                    output.write(buffer,0,read);digest.update(buffer,0,read);written+=read;}
                if(written!=t.expected||!t.sha256.equals(hex(digest.digest())))throw new IOException("归档临时副本摘要已变化");
                check(t);output.flush();
            }
            check(t);
            events.send(t.id,"saved",()->{try{check(t);}catch(Exception error){throw new IllegalStateException("归档会话已变化");}});
            synchronized(this){t.terminal="saved";}
        }catch(Exception error){synchronized(this){if(!t.cancelled){t.cancelled=true;t.terminal="error";}}}
        finally{complete(t);}
    }
    private synchronized void stop(Transfer t,String phase){
        if(active!=t)return;
        t.cancelled=true;t.terminal=phase;
        if(!t.workScheduled){t.workScheduled=true;try{worker.execute(()->complete(t));}
            catch(RuntimeException error){/* Keep the blocked slot/cache; never report success. */}}
    }
    synchronized void cancel(String id){if(active!=null&&active.id.equals(id))stop(active,"cancelled");}
    synchronized void fail(String id){if(active!=null&&active.id.equals(id))stop(active,"error");}
    synchronized void cancelAll(){if(active!=null)stop(active,"cancelled");}
    /** Only a fully sealed payload while OUR picker is outstanding may survive onPause. */
    synchronized void background(){if(active!=null&&!"picker".equals(active.phase))stop(active,"cancelled");}
    private void complete(Transfer t){
        String terminal;
        synchronized(this){if(active!=t)return;terminal=t.terminal;
            if(t.deadline!=null)t.deadline.cancel(false);
            if(t.output!=null)try{t.output.close();}catch(Exception ignored){}
            t.output=null;
            if(t.file.getParentFile().equals(directory)&&t.file.exists()&&!t.file.delete())blockedCleanup=t.file;
        }
        if(!"saved".equals(terminal))try{events.send(t.id,terminal,()->{});}catch(Exception ignored){}
        synchronized(this){if(active==t)active=null;}
    }
    synchronized void close(){closed=true;cancelAll();deadlines.shutdownNow();}
}
