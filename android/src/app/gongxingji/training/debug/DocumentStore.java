package app.gongxingji.training.debug;

import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

/** Atomic device-private document, revision checked before acknowledging any arrow. */
public final class DocumentStore {
    private final AtomicFile file;
    private final AtomicFile accounts;
    public DocumentStore(File directory) { file = new AtomicFile(new File(directory, "training-v1.json")); accounts=new AtomicFile(new File(directory,"local-accounts-v1.json")); }
    private boolean partitioned(){return accounts.getBaseFile().exists()||new File(accounts.getBaseFile()+".bak").exists();}
    private void legacyOnly()throws Exception{if(partitioned())throw new Exception("资料已按账号分别保存，请使用新版并登录对应账号；旧原件保留");}
    public synchronized String accountRead()throws Exception{
        String value=null;
        if(partitioned()){
            JSONObject envelope=new JSONObject(new String(accounts.readFully(),StandardCharsets.UTF_8));value=envelope.getString("payload");
            if(!digest(value).equals(envelope.getString("sha256")))throw new Exception("本机账号资料校验失败，所有原件保留，请勿卸载");
        }
        return new JSONObject().put("ok",true).put("data",value==null?JSONObject.NULL:value).put("hash",digest(value==null?"":value)).toString();
    }
    public synchronized String accountWrite(String value,String expectedHash,String expectedLegacyHash)throws Exception{
        if(value==null||value.getBytes(StandardCharsets.UTF_8).length>128*1024*1024)throw new Exception("账号资料超过容量保护，原件保留");
        JSONObject v=new JSONObject(value);if(v.getInt("version")!=1||!v.getJSONObject("accounts").has(v.getString("active")))throw new Exception("账号资料结构无效");
        JSONObject prior=new JSONObject(accountRead());String hash=digest(value);
        if(!prior.isNull("data")&&value.equals(prior.getString("data")))return hash;
        if(!prior.getString("hash").equals(expectedHash))throw new Exception("另一页面已修改账号资料，请重新打开，原件保留");
        if(prior.isNull("data")){String legacy=read();if(!digest(legacy==null?"":legacy).equals(expectedLegacyHash))throw new Exception("迁移前原记录已变化，请重新打开");}
        JSONObject envelope=new JSONObject().put("payload",value).put("sha256",hash);FileOutputStream out=null;
        try{out=accounts.startWrite();out.write(envelope.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();accounts.finishWrite(out);out=null;if(!value.equals(new JSONObject(accountRead()).getString("data")))throw new Exception("账号资料写后核对失败");}
        catch(Exception e){if(out!=null)accounts.failWrite(out);throw e;}return hash;
    }
    static String digest(String data) throws Exception {
        return digest(data.getBytes(StandardCharsets.UTF_8));
    }
    static String digest(byte[] data) throws Exception {
        byte[] result = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder text = new StringBuilder();
        for (byte value : result) text.append(String.format("%02x", value & 255));
        return text.toString();
    }
    public synchronized String read() throws Exception {
        legacyOnly();
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile()+".bak").exists()) return null;
        JSONObject envelope = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        String payload = envelope.getString("payload");
        if (!digest(payload).equals(envelope.getString("sha256"))) throw new Exception("本机文件校验失败；原文件保留，请从备份恢复，不要卸载应用");
        return payload;
    }
    public synchronized void write(String payload, int expected) throws Exception {
        legacyOnly();
        if (payload.getBytes(StandardCharsets.UTF_8).length > 24 * 1024 * 1024) throw new Exception("本机文档超过24MB保护，未覆盖原记录");
        JSONObject next = new JSONObject(payload);
        if (next.getInt("schema") != 1 || next.getInt("revision") != expected+1) throw new Exception("本机数据版本无效");
        String old = read();
        int revision = old == null ? 0 : new JSONObject(old).getInt("revision");
        if (revision == expected+1 && payload.equals(old)) return;
        if (revision != expected) throw new Exception("记录已变化，请保留未保存内容并重新打开");
        JSONObject envelope = new JSONObject().put("payload",payload).put("sha256",digest(payload));
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(envelope.toString().getBytes(StandardCharsets.UTF_8));
            stream.getFD().sync();
            file.finishWrite(stream);
            stream = null;
            if (!payload.equals(read())) throw new Exception("写入后校验失败，未确认保存成功，请保留当前记录并重试");
        } catch (Exception error) {
            if (stream != null) file.failWrite(stream);
            throw new Exception("手机保存结果尚未核实；请保留当前记录，检查可用存储后重试", error);
        }
    }
    private byte[] recoveryBytes() throws Exception {
        File source=file.getBaseFile();
        if(!source.isFile())source=new File(file.getBaseFile()+".bak");
        if(!source.isFile())throw new Exception("没有可导出的本机资料文件");
        // Recovery must not trigger AtomicFile.openRead(), which may delete .new or replace base from .bak.
        if(source.length()>128L*1024*1024)throw new Exception("损坏原件超过128MiB安全读取范围；原件保持不变");
        try(FileInputStream input=new FileInputStream(source);ByteArrayOutputStream output=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int count;
            while((count=input.read(buffer))!=-1){if(output.size()+count>128*1024*1024)throw new Exception("损坏原件超过安全读取范围；原件保持不变");output.write(buffer,0,count);}
            return output.toByteArray();
        }
    }
    public synchronized String recoveryRead() throws Exception {
        legacyOnly();
        byte[] original=recoveryBytes();
        String raw=new String(original,StandardCharsets.UTF_8);
        // raw is a text preview only; hash and the retained original are always computed from exact bytes.
        return new JSONObject().put("raw",raw).put("hash",digest(original)).toString();
    }
    private void preserveBytes(File backup,byte[] original)throws Exception{
        if(!backup.createNewFile())throw new Exception("无法保留救援前原文件");
        try(FileOutputStream out=new FileOutputStream(backup)){out.write(original);out.getFD().sync();}
        try(FileInputStream input=new FileInputStream(backup);ByteArrayOutputStream output=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1)output.write(buffer,0,count);
            if(!digest(original).equals(digest(output.toByteArray())))throw new Exception("救援前原件备份核验失败；未覆盖当前文件");
        }
    }
    public synchronized void recover(String payload,String expectedHash) throws Exception {
        legacyOnly();
        byte[] original=recoveryBytes();String originalHash=digest(original);if(expectedHash==null||!expectedHash.equals(originalHash))throw new Exception("原资料已变化，请重新读取后救援");
        if(payload.getBytes(StandardCharsets.UTF_8).length>24*1024*1024)throw new Exception("救援资料超过容量保护");
        JSONObject value=new JSONObject(payload);if(value.getInt("schema")!=1||value.getInt("revision")!=1)throw new Exception("救援资料版本无效");
        File backup=new File(file.getBaseFile().getParentFile(),"training-before-recovery-"+System.currentTimeMillis()+"-"+UUID.randomUUID()+".json");
        preserveBytes(backup,original);
        // AtomicFile may remove these sidecars when committing. Retain each exact original first.
        for(String suffix:new String[]{".bak",".new"}){
            File sidecar=new File(file.getBaseFile()+suffix);
            if(sidecar.isFile()){
                if(sidecar.length()>128L*1024*1024)throw new Exception("救援旁文件超过安全备份范围；原件保持不变");
                try(FileInputStream input=new FileInputStream(sidecar);ByteArrayOutputStream output=new ByteArrayOutputStream()){
                    byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>128*1024*1024)throw new Exception("救援旁文件超过安全备份范围；原件保持不变");output.write(buffer,0,count);}
                    preserveBytes(new File(backup+suffix),output.toByteArray());
                }
            }
        }
        JSONObject envelope=new JSONObject().put("payload",payload).put("sha256",digest(payload));FileOutputStream stream=null;
        try{stream=file.startWrite();stream.write(envelope.toString().getBytes(StandardCharsets.UTF_8));stream.getFD().sync();file.finishWrite(stream);stream=null;if(!payload.equals(read()))throw new Exception("救援写后核验失败，原文件已单独保留");}catch(Exception error){if(stream!=null)file.failWrite(stream);throw error;}
    }
}
