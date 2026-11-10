package app.gongxingji.training.debug;

import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import javax.net.ssl.HttpsURLConnection;

/** One bounded transfer. Only temporary clones enter its private cache directory. */
final class PrivateMediaBridge {
    interface Sessions { String token(String scope,String owner,String pin)throws Exception; }
    interface Events { void send(JSONObject value,Runnable guard)throws Exception; }
    interface Connections { HttpsURLConnection open(URI uri)throws Exception; }
    private static PrivateMediaBridge previous;
    private final File directory;
    private final ExecutorService worker;
    private final Sessions sessions,contributionSessions;
    private final Events events;
    private final boolean enabled,archiveEnabled,contributionEnabled;
    private final Connections connections;
    private final long durationMillis;
    private final java.util.concurrent.ScheduledThreadPoolExecutor deadlines=new java.util.concurrent.ScheduledThreadPoolExecutor(1);
    private boolean closed;
    private Transfer active;
    private Transfer delivering;
    private File blockedCleanup;
    private static final class Transfer {
        final String id,method,json,scope,owner,pin,sha256;
        final URI endpoint;
        final Map<String,String> headers;
        final int expected;
        final boolean archive,contribution;
        final long startedAt=System.nanoTime();
        File file;FileOutputStream output;volatile HttpsURLConnection connection;
        volatile boolean cancelled;boolean started;int written,sequence;
        final java.security.MessageDigest digest;
        java.util.concurrent.ScheduledFuture<?> deadline;
        Transfer(String id,URI endpoint,String method,Map<String,String> headers,String json,String scope,String owner,String pin,int bytes,String sha256,boolean archive,boolean contribution)throws Exception{
            this.archive=archive;this.contribution=contribution;this.id=id;this.endpoint=endpoint;this.method=method;this.headers=headers;this.json=json;
            this.scope=scope;this.owner=owner;this.pin=pin;this.expected=bytes;this.sha256=sha256;
            this.digest=java.security.MessageDigest.getInstance("SHA-256");
        }
    }
    PrivateMediaBridge(File cache,ExecutorService worker,Sessions sessions,Events events,boolean enabled)throws Exception{
        this(cache,worker,sessions,events,enabled,false);
    }
    PrivateMediaBridge(File cache,ExecutorService worker,Sessions sessions,Events events,boolean enabled,boolean archiveEnabled)throws Exception{
        this(cache,worker,sessions,events,enabled,archiveEnabled,uri->(HttpsURLConnection)uri.toURL().openConnection(),120000);
    }
    PrivateMediaBridge(File cache,ExecutorService worker,Sessions sessions,Events events,boolean enabled,boolean archiveEnabled,Sessions contributionSessions,boolean contributionEnabled)throws Exception{
        this(cache,worker,sessions,events,enabled,archiveEnabled,contributionSessions,contributionEnabled,uri->(HttpsURLConnection)uri.toURL().openConnection(),120000);
    }
    /** Existing package tests retain their private-media-only constructor. */
    PrivateMediaBridge(File cache,ExecutorService worker,Sessions sessions,Events events,boolean enabled,Connections connections,long durationMillis)throws Exception{
        this(cache,worker,sessions,events,enabled,false,connections,durationMillis);
    }
    /** Package-private injection for bounded synthetic IO checks, never a JS option. */
    PrivateMediaBridge(File cache,ExecutorService worker,Sessions sessions,Events events,boolean enabled,boolean archiveEnabled,Connections connections,long durationMillis)throws Exception{
        this(cache,worker,sessions,events,enabled,archiveEnabled,null,false,connections,durationMillis);
    }
    PrivateMediaBridge(File cache,ExecutorService worker,Sessions sessions,Events events,boolean enabled,boolean archiveEnabled,Sessions contributionSessions,boolean contributionEnabled,Connections connections,long durationMillis)throws Exception{
        if(contributionEnabled&&contributionSessions==null)throw new IOException("贡献身份通道未就绪");
        this.contributionSessions=contributionSessions;this.contributionEnabled=contributionEnabled;
        if(durationMillis<1||durationMillis>120000)throw new IOException("媒体期限无效");
        this.worker=worker;this.sessions=sessions;this.events=events;this.enabled=enabled;this.archiveEnabled=archiveEnabled;this.connections=connections;this.durationMillis=durationMillis;
        deadlines.setRemoveOnCancelPolicy(true);
        directory=new File(cache,"gxj-private-media-transport-v1").getCanonicalFile();
        if(!directory.getParentFile().equals(cache.getCanonicalFile()))throw new IOException("媒体临时目录无效");
        synchronized(PrivateMediaBridge.class){
            if(previous!=null)previous.close();previous=this;
            if(!directory.exists()&&!directory.mkdirs())throw new IOException("媒体临时目录不可用");
            // These names are generated by this transport, never supplied by a user.
            File[] stale=directory.listFiles();if(stale==null)throw new IOException("媒体临时目录无法核对");for(File file:stale){
                if(file.getName().matches("gxj-media-[a-f0-9-]{36}\\.part")&&file.isFile()
                    &&file.getCanonicalFile().getParentFile().equals(directory)&&!file.delete())
                    throw new IOException("上次媒体临时副本尚未清理，原媒体保留");
            }
        }
    }
    private String session(Transfer t)throws Exception{return (t.contribution?contributionSessions:sessions).token(t.scope,t.owner,t.pin);}
    private void check(Transfer t)throws Exception{
        synchronized(this){if(t.cancelled||active!=t||System.nanoTime()-t.startedAt>java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(durationMillis))throw new IOException("媒体操作已取消或超时；原对象保留");}
        session(t);
    }
    private Map<String,String> headers(String raw)throws Exception{
        if(raw==null||raw.length()>8192||raw.getBytes(StandardCharsets.UTF_8).length>8192)throw new IOException("媒体请求头超出容量");
        JSONObject value=new JSONObject(raw);if(value.length()>3)throw new IOException("媒体请求头数量无效");
        Map<String,String> result=new HashMap<>();Iterator<String> keys=value.keys();
        while(keys.hasNext()){
            String key=keys.next(),normalized=key.toLowerCase(Locale.ROOT);Object entry=value.get(key);
            if(!(entry instanceof String)||result.put(normalized,(String)entry)!=null)throw new IOException("媒体请求头重复或无效");
        }return result;
    }
    synchronized void begin(String id,String url,String method,String rawHeaders,String json,String scope,String owner,String pin,int bytes,String sha256)throws Exception{
        boolean contribution=url!=null&&PhotoContributionRequestPolicy.matches(new URI(url).getRawPath());
        boolean archive=url!=null&&PrivateMediaRequestPolicy.archive(new URI(url).getRawPath());
        if(closed||(contribution?!contributionEnabled:archive?!archiveEnabled:!enabled))throw new IOException("此媒体或归档通道尚未开放；本机对象保留");
        if(id==null||!id.matches("media-[a-f0-9-]{36}")||active!=null)throw new IOException("请先完成或取消当前媒体核对");
        if(blockedCleanup!=null){
            if(!blockedCleanup.getCanonicalFile().getParentFile().equals(directory)
                ||(blockedCleanup.exists()&&!blockedCleanup.delete()))throw new IOException("媒体临时副本未清理，已停止新增副本");
            blockedCleanup=null;
        }
        Map<String,String> headers;
        try{headers=headers(rawHeaders);}catch(Exception error){if(contribution)throw new IOException("照片贡献请求头未通过限定核验");throw error;}
        URI target=contribution?PhotoContributionRequestPolicy.validate(url,method,headers,json,bytes,scope):archive?PrivateMediaRequestPolicy.validateArchive(url,method,headers,json,bytes,scope):PrivateMediaRequestPolicy.validate(url,method,headers,json,bytes,scope);
        if(!json.isEmpty())new JSONObject(json);
        if(sha256==null||(bytes>0?!sha256.matches("[a-f0-9]{64}"):!sha256.isEmpty()))throw new IOException("媒体声明摘要无效");
        (contribution?contributionSessions:sessions).token(scope,owner,pin);
        Transfer t=new Transfer(id,target,method,headers,json,scope,owner,pin,bytes,sha256,archive,contribution);
        if(bytes>0){
            if(directory.getUsableSpace()<bytes+1024L*1024L)throw new IOException("媒体临时空间不足；原对象保留");
            t.file=new File(directory,"gxj-media-"+UUID.randomUUID()+".part");
            if(!t.file.createNewFile())throw new IOException("媒体临时副本创建失败");
            try{t.output=new FileOutputStream(t.file);}catch(Exception error){if(t.file.exists()&&!t.file.delete())blockedCleanup=t.file;throw error;}
        }
        active=t;
        try{t.deadline=deadlines.schedule(()->cancel(t.id),durationMillis,java.util.concurrent.TimeUnit.MILLISECONDS);}
        catch(RuntimeException error){cancel(t.id);throw error;}
    }
    synchronized void append(String id,int sequence,String encoded)throws Exception{
        Transfer t=active;
        try{
            if(t==null||!t.id.equals(id)||t.started||t.output==null||sequence!=t.sequence||encoded==null
                ||encoded.length()>4*((PrivateMediaRequestPolicy.CHUNK_BYTES+2)/3))
                throw new IOException("媒体分块顺序或编码无效");
            check(t);byte[] bytes=Base64.decode(encoded,Base64.NO_WRAP);
            if(bytes.length!=Math.min(PrivateMediaRequestPolicy.CHUNK_BYTES,t.expected-t.written)||bytes.length<1||t.written+bytes.length>t.expected
                ||!encoded.equals(Base64.encodeToString(bytes,Base64.NO_WRAP)))throw new IOException("媒体分块超出声明容量");
            if(t.contribution&&t.written==0)PhotoContributionRequestPolicy.pngSignature(bytes);
            t.output.write(bytes);t.digest.update(bytes);t.written+=bytes.length;t.sequence++;
        }catch(Exception error){if(t!=null&&t.id.equals(id))cancel(id);throw error;}
    }
    synchronized void finish(String id)throws Exception{
        Transfer t=active;if(t==null||!t.id.equals(id)||t.started)throw new IOException("媒体操作标识无效");
        try{
            check(t);if(t.written!=t.expected)throw new IOException("媒体分块尚未完整；没有发送");
            if(t.expected>0){StringBuilder hash=new StringBuilder();for(byte value:t.digest.digest())hash.append(String.format(Locale.ROOT,"%02x",value&255));if(!t.sha256.equals(hash.toString()))throw new IOException("媒体分块摘要不符；没有发送");}
            if(t.output!=null){t.output.getFD().sync();t.output.close();t.output=null;}
            t.started=true;
            try{worker.execute(()->run(t));}catch(RuntimeException error){t.started=false;throw error;}
        }catch(Exception error){cancel(id);throw error;}
    }
    private void send(Transfer t,JSONObject packet)throws Exception{
        check(t);packet.put("id",t.id);
        events.send(packet,()->{try{check(t);}catch(Exception error){throw new IllegalStateException("媒体账号或操作已变化");}});
        check(t);
    }
    private void run(Transfer t){
        boolean terminal=false;
        try{
            check(t);String token=session(t);
            HttpsURLConnection connection=connections.open(t.endpoint);t.connection=connection;
            connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
            connection.setConnectTimeout(15000);connection.setReadTimeout(15000);connection.setRequestMethod(t.method);
            for(Map.Entry<String,String> item:t.headers.entrySet())connection.setRequestProperty(item.getKey(),item.getValue());
            connection.setRequestProperty("Authorization","Bearer "+token);
            if(t.expected>0||!t.json.isEmpty()){
                connection.setDoOutput(true);byte[] json=t.json.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(t.expected>0?t.expected:json.length);
                check(t);
                try(OutputStream out=connection.getOutputStream()){
                    if(t.expected>0)try(InputStream in=new FileInputStream(t.file)){
                        byte[] buffer=new byte[PrivateMediaRequestPolicy.CHUNK_BYTES];int read;
                        while((read=in.read(buffer))!=-1){check(t);out.write(buffer,0,read);}
                    }else{check(t);out.write(json);}
                }
            }
            check(t);int status=connection.getResponseCode();
            if(status>=300&&status<400)throw new IOException("媒体服务重定向已拒绝");
            boolean binary=!t.contribution&&status>=200&&status<300&&(t.archive?PrivateMediaRequestPolicy.archiveBinary(t.method,t.endpoint.getRawPath()):(t.method.equals("GET")&&PrivateMediaRequestPolicy.content(t.endpoint.getRawPath())));
            if(t.contribution)PhotoContributionRequestPolicy.jsonResponse(connection.getContentType());
            else PrivateMediaRequestPolicy.responseType(connection.getContentType(),binary,status,t.archive);
            InputStream source=status>=400?connection.getErrorStream():connection.getInputStream();
            if(binary){
                long total=connection.getContentLengthLong();
                if(total<1||total>PrivateMediaRequestPolicy.MAX_FILE_BYTES)throw new IOException("媒体回读长度缺失或超出保护");
                send(t,new JSONObject().put("phase","binary-start").put("status",status).put("bytes",total));
                int received=0,sequence=0;
                if(source==null)throw new IOException("媒体回读为空");
                try(InputStream in=source){byte[] buffer=new byte[PrivateMediaRequestPolicy.CHUNK_BYTES];int read;
                    while((read=in.read(buffer))!=-1){
                        check(t);if(received+read>total)throw new IOException("媒体回读超过声明长度");
                        byte[] exact=java.util.Arrays.copyOf(buffer,read);
                        send(t,new JSONObject().put("phase","binary-chunk").put("sequence",sequence++)
                            .put("body",Base64.encodeToString(exact,Base64.NO_WRAP)));received+=read;
                    }
                }
                if(received!=total)throw new IOException("媒体回读不完整；未记为保存成功");
                send(t,new JSONObject().put("phase","binary-complete").put("bytes",received).put("chunks",sequence));
            }else{
                ByteArrayOutputStream output=new ByteArrayOutputStream();
                if(source!=null)try(InputStream in=source){byte[] buffer=new byte[8192];int read;
                    while((read=in.read(buffer))!=-1){check(t);if(output.size()+read>PrivateMediaRequestPolicy.MAX_JSON_BYTES)throw new IOException("媒体清单超出容量");output.write(buffer,0,read);}
                }
                send(t,new JSONObject().put("phase","json").put("status",status).put("body",output.toString("UTF-8")));
            }
            terminal=true;
        }catch(Exception error){
            try{send(t,new JSONObject().put("phase","error").put("error","媒体连接未确认；本机对象保留"));}catch(Exception ignored){}
        }finally{
            synchronized(this){if(terminal&&!t.cancelled)delivering=t;cleanup(t,true);}
        }
        if(terminal)try{
            terminalCheck(t);
            events.send(new JSONObject().put("id",t.id).put("phase","ready"),()->{
                try{terminalCheck(t);}catch(Exception error){throw new IllegalStateException("媒体终态已取消或账号已变化");}
            });
        }catch(Exception ignored){}
        finally{synchronized(this){if(delivering==t)delivering=null;}}
    }
    private void terminalCheck(Transfer t)throws Exception{
        if(t.cancelled||System.nanoTime()-t.startedAt>java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(durationMillis))throw new IOException("媒体操作终态已取消或超时");
        session(t);
    }
    private synchronized void cleanup(Transfer t,boolean release){
        if(t.deadline!=null)t.deadline.cancel(false);
        if(t.connection!=null)t.connection.disconnect();
        if(t.output!=null)try{t.output.close();}catch(Exception ignored){}
        t.output=null;
        if(t.file!=null&&t.file.getParentFile().equals(directory)){
            if(t.file.exists()&&!t.file.delete())blockedCleanup=t.file;
            else if(t.file.equals(blockedCleanup))blockedCleanup=null;
        }
        // Cancellation closes IO immediately, but cannot create another queued request
        // until the one submitted worker actually leaves its finally block.
        if(release&&active==t)active=null;
    }
    synchronized void cancel(String id){Transfer t=active;if(t!=null&&t.id.equals(id)){t.cancelled=true;cleanup(t,!t.started);}if(delivering!=null&&delivering.id.equals(id))delivering.cancelled=true;}
    synchronized void cancelAll(){if(active!=null)cancel(active.id);if(delivering!=null)delivering.cancelled=true;}
    synchronized void close(){closed=true;cancelAll();deadlines.shutdownNow();}
}
