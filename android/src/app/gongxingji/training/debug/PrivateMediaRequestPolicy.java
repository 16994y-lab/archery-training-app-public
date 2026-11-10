package app.gongxingji.training.debug;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;

/** Independent allowlist; private files cannot use the general text HTTP bridge. */
final class PrivateMediaRequestPolicy {
    static final int MAX_FILE_BYTES=50*1024*1024;
    static final int MAX_JSON_BYTES=1024*1024;
    static final int MAX_REQUEST_JSON_BYTES=65536;
    static final int CHUNK_BYTES=256*1024;
    private static final String OBJECT="/api/private-media/[a-f0-9]{32}";
    private static final String ARCHIVE="/api/media-archives/[a-f0-9]{32}";
    private PrivateMediaRequestPolicy(){}

    static String origin(URI uri)throws Exception{
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null
            ||uri.getRawFragment()!=null||(uri.getPort()!=-1&&uri.getPort()!=443))
            throw new Exception("媒体仅允许核定HTTPS来源");
        return "https://"+uri.getHost().toLowerCase(Locale.ROOT);
    }
    static boolean approved(String value){return "https://service-1.example.invalid".equals(value)
        ||"https://service-3.example.invalid".equals(value);}
    static void requireService(String scope,String persistedService)throws Exception{
        if(!approved(scope)||!"https://service-3.example.invalid|https://auth-4.example.invalid".equals(persistedService))
            throw new Exception("媒体登录项目或服务别名不符");
    }
    static boolean content(String path){return path!=null&&path.matches(OBJECT+"/content");}
    static URI validate(String url,String method,Map<String,String> headers,String json,int bytes,String scope)throws Exception{
        if(url==null||url.length()>2048||method==null||headers==null||json==null||json.length()>MAX_REQUEST_JSON_BYTES||scope==null)
            throw new Exception("媒体请求字段不完整");
        URI endpoint=new URI(url),service=new URI(scope);
        if(!approved(scope)||!scope.equals(origin(service))||service.getRawQuery()!=null
            ||!(service.getRawPath()==null||service.getRawPath().isEmpty())||!scope.equals(origin(endpoint)))
            throw new Exception("媒体来源与当前登录服务不符");
        if(endpoint.getRawQuery()!=null)throw new Exception("媒体请求参数未获准");
        String path=endpoint.getRawPath();
        boolean upload="PUT".equals(method)&&content(path);
        boolean read="GET".equals(method)&&(path.equals("/api/private-media")||content(path)||path.matches(OBJECT+"/access"));
        boolean write="POST".equals(method)&&(path.equals("/api/private-media/intents")||path.matches(OBJECT+"/training-consent"));
        if(!upload&&!read&&!write)throw new Exception("媒体路径或方法未获准");
        for(Map.Entry<String,String> item:headers.entrySet()){
            String key=item.getKey(),value=item.getValue();
            if(!key.equals(key.toLowerCase(Locale.ROOT))||value==null||value.length()>1024
                ||value.indexOf('\r')>=0||value.indexOf('\n')>=0
                ||(!key.equals("accept")&&!key.equals("content-type")&&!key.equals("x-media-access")))
                throw new Exception("媒体请求头未获准");
        }
        if(!"application/json".equals(headers.get("accept")))throw new Exception("媒体响应格式无效");
        String mime=headers.get("content-type"),access=headers.get("x-media-access");
        if(upload){
            if(bytes<1||bytes>MAX_FILE_BYTES||!json.isEmpty()
                ||!("image/png".equals(mime)||"image/jpeg".equals(mime)||"image/webp".equals(mime)||"video/mp4".equals(mime)))
                throw new Exception("媒体文件超出容量或类型保护");
        }else if(write){
            if(bytes!=0||!"application/json".equals(mime)||json.isEmpty()
                ||json.getBytes(StandardCharsets.UTF_8).length>MAX_REQUEST_JSON_BYTES)
                throw new Exception("媒体请求正文无效");
        }else if(bytes!=0||!json.isEmpty()||mime!=null)throw new Exception("媒体读取不能附带正文");
        if(read&&content(path)){
            if(access==null||!access.matches("[A-Za-z0-9_-]{16,512}"))throw new Exception("媒体访问凭据无效");
        }else if(access!=null)throw new Exception("媒体访问凭据不属于此路径");
        return endpoint;
    }
    static boolean archiveContent(String path){return path!=null&&path.matches(ARCHIVE+"/content");}
    static boolean archiveChunk(String path){return path!=null&&path.matches(ARCHIVE+"/content-chunk");}
    static boolean archiveLease(String path){return path!=null&&path.matches(ARCHIVE+"/download-lease");}
    static boolean archiveRevoke(String path){return path!=null&&path.matches(ARCHIVE+"/revoke-download");}
    static boolean archiveBinary(String method,String path){return ("GET".equals(method)&&archiveContent(path))||("POST".equals(method)&&archiveChunk(path));}
    static boolean archive(String path){return path!=null&&((path.equals("/api/media-archives")||path.equals("/api/media-archives/lookup"))
        ||path.matches(ARCHIVE)||archiveContent(path)||archiveChunk(path)||archiveLease(path)||archiveRevoke(path)||path.matches(ARCHIVE+"/verify-restore"));}
    static URI validateArchive(String url,String method,Map<String,String> headers,String json,int bytes,String scope)throws Exception{
        if(url==null||url.length()>2048||method==null||headers==null||json==null
            ||json.length()>MAX_REQUEST_JSON_BYTES||scope==null)throw new Exception("归档请求字段不完整");
        URI endpoint=new URI(url),service=new URI(scope);
        if(!approved(scope)||!scope.equals(origin(service))||service.getRawQuery()!=null
            ||!(service.getRawPath()==null||service.getRawPath().isEmpty())||!scope.equals(origin(endpoint))
            ||endpoint.getRawQuery()!=null)throw new Exception("归档来源或参数未获准");
        String path=endpoint.getRawPath();
        boolean read="GET".equals(method)&&(path.matches(ARCHIVE)||archiveContent(path));
        boolean write="POST".equals(method)&&((path.equals("/api/media-archives")||path.equals("/api/media-archives/lookup"))||archiveChunk(path)||archiveLease(path)||archiveRevoke(path)||path.matches(ARCHIVE+"/verify-restore"));
        if(!read&&!write)throw new Exception("归档路径或方法未获准");
        for(Map.Entry<String,String> item:headers.entrySet()){
            String key=item.getKey(),value=item.getValue();
            if(key==null||!key.equals(key.toLowerCase(Locale.ROOT))||value==null||value.length()>1024
                ||value.indexOf('\r')>=0||value.indexOf('\n')>=0
                ||(!key.equals("accept")&&!key.equals("content-type")))throw new Exception("归档请求头未获准");
        }
        if(!(archiveBinary(method,path)?"application/zip":"application/json").equals(headers.get("accept")))
            throw new Exception("归档响应格式与路径不符");
        if(bytes!=0)throw new Exception("归档请求不能上传二进制");
        if(write){
            if(!"application/json".equals(headers.get("content-type"))||json.isEmpty()
                ||json.getBytes(StandardCharsets.UTF_8).length>MAX_REQUEST_JSON_BYTES)throw new Exception("归档请求正文无效");
        }else if(!json.isEmpty()||headers.get("content-type")!=null)throw new Exception("归档读取不能附带正文");
        return endpoint;
    }
    static void responseType(String raw,boolean binary,int status,boolean archive)throws Exception{
        if(!archive){responseType(raw,binary,status);return;}
        if(status<200||status>=300)return;
        String mime=raw==null?"":raw.split(";",2)[0].trim().toLowerCase(Locale.ROOT);
        if(!(binary?"application/zip":"application/json").equals(mime))throw new Exception("归档响应类型与路径不符");
    }
    static void requireSession(String expected,String current)throws Exception{
        if(expected==null||!expected.matches("[a-f0-9]{64}")||!expected.equals(current))
            throw new Exception("媒体登录会话已变化；旧响应未采用");
    }
    static void responseType(String raw,boolean binary,int status)throws Exception{
        if(status<200||status>=300)return;
        String mime=raw==null?"":raw.split(";",2)[0].trim().toLowerCase(Locale.ROOT);
        if(binary?!(mime.equals("image/png")||mime.equals("image/jpeg")||mime.equals("image/webp")||mime.equals("video/mp4")):!mime.equals("application/json"))
            throw new Exception("媒体响应类型与路径不符");
    }
}
