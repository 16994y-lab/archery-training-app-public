package app.gongxingji.training.debug;

import android.util.AtomicFile;
import android.util.Base64;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-private sync bookkeeping; account tokens are encrypted with an Android Keystore key. */
public final class AuxiliaryStore {
    private final File directory;
    private static final String KEY_ALIAS="gongxingji-cloud-session-v1";
    AuxiliaryStore(File directory){this.directory=directory;}
    private AtomicFile file(String name){return new AtomicFile(new File(directory,name));}
    private String readRaw(String name)throws Exception{AtomicFile f=file(name);if(!f.getBaseFile().exists()&&!new File(f.getBaseFile()+".bak").exists())return null;return new String(f.readFully(),StandardCharsets.UTF_8);}
    private void writeRaw(String name,String value,int limit)throws Exception{
        byte[] bytes=value.getBytes(StandardCharsets.UTF_8);if(bytes.length>limit)throw new Exception("同步资料超过容量保护；原资料已保留");
        AtomicFile f=file(name);FileOutputStream out=null;
        try{out=f.startWrite();out.write(bytes);out.getFD().sync();f.finishWrite(out);out=null;if(!value.equals(readRaw(name)))throw new Exception("同步资料写后核验失败");}
        catch(Exception e){if(out!=null)f.failWrite(out);throw e;}
    }
    public synchronized String readMeta()throws Exception{String raw=readRaw("cloud-meta-v1.json");if(raw==null)return null;JSONObject o=new JSONObject(raw);String value=o.getString("payload");if(!DocumentStore.digest(value).equals(o.getString("sha256")))throw new Exception("同步元信息校验失败，已停止自动同步；本机训练保留");return value;}
    public synchronized String readMetaResult()throws Exception{
        String value=readMeta();
        return new JSONObject().put("ok",true).put("data",value==null?JSONObject.NULL:value).put("hash",DocumentStore.digest(value==null?"":value)).toString();
    }
    public synchronized String writeMeta(String value,String expectedHash)throws Exception{
        if(value==null||value.getBytes(StandardCharsets.UTF_8).length>128*1024*1024)throw new Exception("同步资料超过128MiB容量保护；原资料已保留");
        new JSONObject(value);
        String current=readMeta(),nextHash=DocumentStore.digest(value);
        // A response may be lost after a successful durable write. Identical content is safe to acknowledge.
        if(value.equals(current))return nextHash;
        String currentHash=DocumentStore.digest(current==null?"":current);
        if(expectedHash==null||!currentHash.equals(expectedHash))throw new Exception("同步元信息已由另一窗口更新；已停止覆盖，请重新打开页面核对");
        writeRaw("cloud-meta-v1.json",new JSONObject().put("payload",value).put("sha256",nextHash).toString(),128*1024*1024);
        return nextHash;
    }
    private SecretKey key()throws Exception{
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
        if(!ks.containsAlias(KEY_ALIAS)){KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();}
        return (SecretKey)ks.getKey(KEY_ALIAS,null);
    }
    public synchronized String secureRead(String name)throws Exception{
        if(!"cloud-session".equals(name))throw new Exception("账号存储键无效");String raw=readRaw("cloud-session-v1.enc");if(raw==null)return null;JSONObject o=new JSONObject(raw);
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(o.getString("iv"),Base64.NO_WRAP)));String value=new String(c.doFinal(Base64.decode(o.getString("data"),Base64.NO_WRAP)),StandardCharsets.UTF_8);return value.isEmpty()?null:value;
    }
    public synchronized void secureWrite(String name,String value)throws Exception{
        if(!"cloud-session".equals(name))throw new Exception("账号存储键无效");if(value==null)value="";if(value.getBytes(StandardCharsets.UTF_8).length>128*1024)throw new Exception("账号会话超出容量");
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());JSONObject o=new JSONObject().put("iv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP)).put("data",Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));writeRaw("cloud-session-v1.enc",o.toString(),256*1024);
    }

    public synchronized String secureReadResult(String name)throws Exception{
        String value=secureRead(name),raw=readRaw("cloud-session-v1.enc");
        return new JSONObject().put("ok",true).put("data",value==null?JSONObject.NULL:value).put("hash",raw==null?"":DocumentStore.digest(raw)).toString();
    }
    public synchronized String secureWriteIfCurrent(String name,String value,String expectedHash)throws Exception{
        if(!"cloud-session".equals(name))throw new Exception("账号存储键无效");
        String raw=readRaw("cloud-session-v1.enc");
        // Compare ciphertext generations, including encrypted logout. Do not
        // acknowledge equal plaintext from an obsolete activity as a fresh save.
        if(!(raw==null?"":DocumentStore.digest(raw)).equals(expectedHash))throw new Exception("另一页面已改变登录状态，请重新打开；原资料保留");
        secureWrite(name,value);
        return DocumentStore.digest(readRaw("cloud-session-v1.enc"));
    }

    public synchronized JSONObject localIdentityRead()throws Exception{
        String raw=readRaw("local-identity-v1.enc"),value=null;
        if(raw!=null){JSONObject o=new JSONObject(raw);Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(o.getString("iv"),Base64.NO_WRAP)));value=new String(c.doFinal(Base64.decode(o.getString("data"),Base64.NO_WRAP)),StandardCharsets.UTF_8);}
        return new JSONObject().put("ok",true).put("data",value==null?JSONObject.NULL:value).put("hash",raw==null?"":DocumentStore.digest(raw));
    }
    public synchronized JSONObject localIdentityWrite(String value,String expectedHash)throws Exception{
        String raw=readRaw("local-identity-v1.enc");
        if(!(raw==null?"":DocumentStore.digest(raw)).equals(expectedHash))throw new Exception("另一页面已改变登录状态，请重新打开；原资料保留");
        if(value==null||value.getBytes(StandardCharsets.UTF_8).length>8192)throw new Exception("本机身份格式无效");
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());JSONObject o=new JSONObject().put("iv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP)).put("data",Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));writeRaw("local-identity-v1.enc",o.toString(),16384);
        return localIdentityRead();
    }

    private static String origin(URI uri)throws Exception{
        if(!"https".equalsIgnoreCase(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null)
            throw new Exception("社区账号服务地址无效");
        return new URI("https",null,uri.getHost().toLowerCase(java.util.Locale.ROOT),uri.getPort()==443?-1:uri.getPort(),null,null,null).toString();
    }
    private static final class PendingScope {
        final String name;
        final String associated;
        PendingScope(String name,String associated){this.name=name;this.associated=associated;}
    }
    private PendingScope pendingScope(String scope,String owner)throws Exception{
        if(scope==null||owner==null||owner.length()<1||owner.length()>128||!owner.matches("[A-Za-z0-9_-]+"))throw new Exception("社区账号标识无效");
        URI requested=new URI(scope);
        if(!origin(requested).equals(scope)||!(requested.getRawPath()==null||requested.getRawPath().isEmpty())||requested.getRawQuery()!=null||requested.getRawFragment()!=null)
            throw new Exception("社区服务范围无效");
        String raw=secureRead("cloud-session");
        if(raw==null)throw new Exception("社区暂存需先登录对应账号");
        JSONObject session=new JSONObject(raw);
        String service=session.getString("service"),currentOwner=session.getString("owner"),token=session.getString("accessToken");
        long expiresAt=session.getLong("expiresAt");
        String[] parts=service.split("\\|",-1);
        if(parts.length==2)origin(new URI(parts[1]));
        if(parts.length!=2||!owner.equals(currentOwner)||token.isEmpty()||expiresAt<=System.currentTimeMillis()
            ||!origin(new URI(parts[0])).equals(scope))
            throw new Exception("社区账号已切换或登录过期；待确认内容保留");
        String associated=service+"|"+owner;
        return new PendingScope("community-pending-v1-"+DocumentStore.digest(associated)+".enc",associated);
    }
    private String pendingRead(String name,String associated)throws Exception{
        String raw=readRaw(name);if(raw==null)return null;
        JSONObject envelope=new JSONObject(raw);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(envelope.getString("iv"),Base64.NO_WRAP)));
        cipher.updateAAD(associated.getBytes(StandardCharsets.UTF_8));
        String value=new String(cipher.doFinal(Base64.decode(envelope.getString("data"),Base64.NO_WRAP)),StandardCharsets.UTF_8);
        return value.isEmpty()?null:value;
    }
    /** A separate encrypted continuation. Never overwrites the current login or training file. */
    public synchronized String emailEnrollmentRead()throws Exception{
        String value=pendingRead("email-enrollment-v1.enc","gongxingji/email-enrollment/v1");
        return new JSONObject().put("ok",true).put("data",value==null?JSONObject.NULL:value)
            .put("hash",DocumentStore.digest(value==null?"":value)).toString();
    }
    public synchronized String emailEnrollmentWrite(String value,String expectedHash)throws Exception{
        if(value==null)value="";
        if(value.getBytes(StandardCharsets.UTF_8).length>8*1024)throw new Exception("注册进度超出容量，原内容保留");
        if(!value.isEmpty())new JSONObject(value);
        String name="email-enrollment-v1.enc",associated="gongxingji/email-enrollment/v1";
        String current=pendingRead(name,associated);if(current==null)current="";
        String nextHash=DocumentStore.digest(value);
        if(value.equals(current))return nextHash;
        if(expectedHash==null||!DocumentStore.digest(current).equals(expectedHash))throw new Exception("注册进度已变化，请重新读取；原内容保留");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        cipher.updateAAD(associated.getBytes(StandardCharsets.UTF_8));
        JSONObject envelope=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP))
            .put("data",Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));
        writeRaw(name,envelope.toString(),16*1024);
        String checked=pendingRead(name,associated);if(!value.equals(checked==null?"":checked))throw new Exception("注册进度写后核验失败，请重新读取");
        return nextHash;
    }
    public synchronized String communityPendingRead(String scope,String owner)throws Exception{
        PendingScope pending=pendingScope(scope,owner);
        return pendingRead(pending.name,pending.associated);
    }
    /** Ciphertext changes on each durable session write, including logout and same-owner login. */
    public synchronized String communitySessionFingerprint(String scope,String owner)throws Exception{
        pendingScope(scope,owner);
        return DocumentStore.digest(readRaw("cloud-session-v1.enc"));
    }
    /** A queued write cannot borrow a later session, even when the owner is unchanged. */
    public synchronized String communityAccessToken(String scope,String owner,String expectedFingerprint)throws Exception{
        pendingScope(scope,owner);
        CommunityRequestPolicy.requireCurrentSession(expectedFingerprint,DocumentStore.digest(readRaw("cloud-session-v1.enc")));
        return new JSONObject(secureRead("cloud-session")).getString("accessToken");
    }
    /** Media has an independent gate and an exact, previously accepted backend alias. */
    public synchronized String mediaSessionFingerprint(String scope,String owner)throws Exception{
        mediaSession(scope,owner);
        return DocumentStore.digest(readRaw("cloud-session-v1.enc"));
    }
    private JSONObject mediaSession(String scope,String owner)throws Exception{
        if(owner==null||!owner.matches("[A-Za-z0-9_-]{1,128}"))throw new Exception("媒体账号标识无效");
        String raw=secureRead("cloud-session");if(raw==null)throw new Exception("媒体保存需先登录对应账号");
        JSONObject session=new JSONObject(raw);
        PrivateMediaRequestPolicy.requireService(scope,session.getString("service"));
        if(!owner.equals(session.getString("owner"))||session.getString("accessToken").isEmpty()
            ||session.getLong("expiresAt")<=System.currentTimeMillis()||!session.optBoolean("phoneVerified",false))
            throw new Exception("媒体账号已切换、尚未完成注册或登录过期");
        return session;
    }
    /** Purpose-bound capability; it never grants personal backup or contribution consent. */
    public synchronized String photoContributionFingerprint(String scope,String owner)throws Exception{
        mediaSession(scope,owner);
        return PhotoContributionRequestPolicy.fingerprint(scope,owner,DocumentStore.digest(readRaw("cloud-session-v1.enc")));
    }
    public synchronized String photoContributionAccessToken(String scope,String owner,String expectedFingerprint)throws Exception{
        PrivateMediaRequestPolicy.requireSession(expectedFingerprint,photoContributionFingerprint(scope,owner));
        return mediaSession(scope,owner).getString("accessToken");
    }
    public synchronized String mediaAccessToken(String scope,String owner,String expectedFingerprint)throws Exception{
        PrivateMediaRequestPolicy.requireSession(expectedFingerprint,DocumentStore.digest(readRaw("cloud-session-v1.enc")));
        return mediaSession(scope,owner).getString("accessToken");
    }
    public synchronized void communityPendingWrite(String scope,String owner,String value)throws Exception{
        PendingScope pendingScope=pendingScope(scope,owner);
        String name=pendingScope.name,associated=pendingScope.associated;
        if(value==null)value="";
        if(value.getBytes(StandardCharsets.UTF_8).length>16*1024)throw new Exception("社区待确认内容超过容量保护");
        if(!value.isEmpty()){
            JSONObject pending=new JSONObject(value);
            if(!owner.equals(pending.optString("owner"))||!scope.equals(pending.optString("scope"))
                ||!("post".equals(pending.optString("kind"))||"comment".equals(pending.optString("kind")))
                ||pending.optString("body").isEmpty()||pending.optString("key").isEmpty())throw new Exception("社区待确认内容与当前账号不符");
            String existing=pendingRead(name,associated);
            if(existing!=null&&!existing.equals(value))throw new Exception("已有待确认发布；请先核对原请求");
        }
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        cipher.updateAAD(associated.getBytes(StandardCharsets.UTF_8));
        JSONObject envelope=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP))
            .put("data",Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));
        writeRaw(name,envelope.toString(),32*1024);
    }
}
