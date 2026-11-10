package app.gongxingji.training.debug;

import java.net.URI;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Small, independent allowlist for the community-only native HTTP bridge. */
final class CommunityRequestPolicy {
    private static final String TEST_ORIGIN="https://service-3.example.invalid";
    private static final String UUID="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
    private static final String POST="/api/community/posts/"+UUID;
    private static final String COMMENT="/api/community/comments/"+UUID;
    private static final String POST_COMMENTS=POST+"/comments";

    private CommunityRequestPolicy(){}

    static void requireCurrentSession(String expected,String current) throws Exception {
        if(expected==null||!expected.matches("[a-f0-9]{64}")||!expected.equals(current))
            throw new Exception("社区登录会话已变化；旧请求未发送");
    }

    static String origin(URI uri) throws Exception {
        if(!"https".equalsIgnoreCase(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null
            ||uri.getRawFragment()!=null||uri.getPort()>65535||uri.getPort()<-1)
            throw new Exception("社区请求只允许核定 HTTPS 来源");
        return new URI("https",null,uri.getHost().toLowerCase(Locale.ROOT),uri.getPort()==443?-1:uri.getPort(),null,null,null).toString();
    }

    private static boolean route(String path,String method){
        if(path.equals("/api/community/profile"))return method.equals("GET")||method.equals("PUT");
        if(path.equals("/api/community/posts"))return method.equals("GET")||method.equals("POST");
        if(path.matches(POST))return method.equals("GET")||method.equals("DELETE");
        if(path.matches(POST_COMMENTS))return method.equals("GET")||method.equals("POST");
        if(path.matches(COMMENT))return method.equals("DELETE");
        if(path.equals("/api/community/reports"))return method.equals("POST");
        if(path.equals("/api/community/moderation/reports"))return method.equals("GET");
        // Android's HttpURLConnection does not support PATCH. Moderator decisions
        // remain unavailable from this bridge until an approved service contract exists.
        return false;
    }

    private static void query(String raw,String path,String method) throws Exception {
        if(raw==null)return;
        if(!method.equals("GET")||!(path.equals("/api/community/posts")||path.matches(POST_COMMENTS)))
            throw new Exception("社区请求参数未获准");
        Set<String> seen=new HashSet<>();
        for(String entry:raw.split("&",-1)){
            String[] pair=entry.split("=",-1);
            if(pair.length!=2||!seen.add(pair[0]))throw new Exception("社区请求参数未获准");
            if(pair[0].equals("cursor")&&!pair[1].matches("[A-Za-z0-9_-]{1,256}"))throw new Exception("社区翻页标识无效");
            if(pair[0].equals("limit")&&!pair[1].matches("(?:[1-9]|[1-4][0-9]|50)"))throw new Exception("社区页数无效");
            if(!pair[0].equals("cursor")&&!pair[0].equals("limit"))throw new Exception("社区请求参数未获准");
        }
    }

    static URI validate(String target,String method,Map<String,String> headers,String body,String approvedOrigin) throws Exception {
        if(target==null||target.length()>4096||method==null||headers==null||body==null||approvedOrigin==null)
            throw new Exception("社区请求缺少必要字段");
        URI endpoint=new URI(target),approved=new URI(approvedOrigin);
        if(!TEST_ORIGIN.equals(approvedOrigin)||!origin(endpoint).equals(approvedOrigin)||!origin(approved).equals(approvedOrigin)
            ||!(approved.getRawPath()==null||approved.getRawPath().isEmpty())||approved.getRawQuery()!=null)
            throw new Exception("社区服务来源与登录账号不符");
        String path=endpoint.getRawPath();
        if(path==null||!route(path,method))throw new Exception("社区请求路径或方法未获准");
        query(endpoint.getRawQuery(),path,method);
        for(String key:headers.keySet()){
            String normalized=key.toLowerCase(Locale.ROOT);
            if(!normalized.equals("accept")&&!normalized.equals("content-type")
                &&!normalized.equals("idempotency-key")&&!normalized.equals("if-match"))
                throw new Exception("社区请求头未获准");
        }
        if(!"application/json".equals(headers.get("accept")))throw new Exception("社区响应格式无效");
        boolean writes=method.equals("POST")||method.equals("PUT")||method.equals("PATCH");
        if(writes){
            if(!"application/json".equals(headers.get("content-type"))||body.isEmpty()
                ||body.getBytes(java.nio.charset.StandardCharsets.UTF_8).length>4096)
                throw new Exception("社区请求正文无效");
        }else if(!body.isEmpty()||headers.containsKey("content-type"))throw new Exception("社区请求不应携带正文");
        boolean create=method.equals("POST")&&(path.equals("/api/community/posts")||path.matches(POST_COMMENTS));
        String key=headers.get("idempotency-key");
        if(create?(key==null||!key.matches("[A-Za-z0-9_-]{8,128}")):key!=null)throw new Exception("社区请求标识无效");
        String revision=headers.get("if-match");
        if(method.equals("DELETE")?(revision==null||!revision.matches("[1-9][0-9]*")):revision!=null)
            throw new Exception("社区内容修订号无效");
        return endpoint;
    }
}
