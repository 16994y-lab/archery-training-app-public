package app.gongxingji.training.debug;

import java.net.URI;

/** Exact destinations for the test APK's account and score-backup bridge. */
final class CommunityTestNetworkPolicy {
    private static final String AUTH_HOST="auth-4.example.invalid";
    private static final String SCORE_BACKUP_HOST="service-3.example.invalid";
    private static final String API_ALIAS_HOST="service-1.example.invalid";
    // The server caps the score document at 2 MiB; reserve 1 KiB for JSON wrapping.
    static final int SCORE_BACKUP_HTTP_MAX_BYTES=2*1024*1024+1024;
    static final int MANUAL_BACKUP_REQUEST_MAX_BYTES=4000000;
    // Bounded read buffer margin only; web/client and server still enforce 4,000,000 JSON bytes.
    static final int MANUAL_BACKUP_HTTP_MAX_BYTES=4000000+1024;

    private CommunityTestNetworkPolicy(){}

    static boolean isTeamMemberRequest(String method,String path){
        String id="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
        if("/api/team/me".equals(path))return "GET".equals(method);
        if("/api/team/rewards/me".equals(path)||"/api/team/registration/me".equals(path))return "GET".equals(method);
        if("/api/team/registration/complete".equals(path))return "POST".equals(method);
        if(path.matches("/api/team/rewards/(?:claim|requests/read)"))return "POST".equals(method);
        if(path.matches("/api/team/operations/(?:feedback/(?:create|search)|donations/(?:create|search)|incidents/create|announcements/read|requests/read)"))return "POST".equals(method);
        if("/api/team/invitations/accept".equals(path))return "POST".equals(method);
        if(path.matches("/api/team/member/teams/"+id+"/sharing"))return "GET".equals(method)||"PUT".equals(method)||"DELETE".equals(method);
        return path.matches("/api/team/member/teams/"+id+"/sessions/[A-Za-z0-9_-]{1,128}")&&("GET".equals(method)||"PUT".equals(method));
    }

    static boolean isPasswordPut(String method,String path){
        return "PUT".equals(method)&&("/auth/v1/user".equals(path)||"/api/auth/native-session/user".equals(path));
    }

    static boolean isPublicNews(String target,String method) throws Exception {
        URI uri=new URI(target);
        return "https".equals(uri.getScheme())&&API_ALIAS_HOST.equals(uri.getHost())
            &&uri.getPort()==-1&&uri.getRawUserInfo()==null&&uri.getRawFragment()==null
            &&uri.getRawQuery()==null&&"GET".equals(method)
            &&("/news-feed.v1.json".equals(uri.getRawPath())||"/api/news/publication.v1.json".equals(uri.getRawPath()));
    }

    static boolean isPublicContributionPolicy(String target,String method)throws Exception{
        URI uri=new URI(target);
        return "GET".equals(method)&&"https".equals(uri.getScheme())
            &&(API_ALIAS_HOST.equals(uri.getHost())||SCORE_BACKUP_HOST.equals(uri.getHost()))
            &&uri.getPort()==-1&&uri.getRawUserInfo()==null&&uri.getRawQuery()==null&&uri.getRawFragment()==null
            &&"/api/photo-contributions/policy".equals(uri.getRawPath());
    }

    /** Shared with the native HTTP bridge so admitted account routes are not rejected again. */
    static boolean isAccountPost(String method,String path){
        return "POST".equals(method)&&("/api/auth/phone-binding/start".equals(path)
            ||"/api/auth/native-session/password".equals(path)
            ||"/api/auth/native-session/refresh".equals(path)
            ||"/api/auth/native-session/phone-otp".equals(path)
            ||"/api/auth/native-session/phone-verify".equals(path)
            ||"/api/auth/registration-rewards/prepare".equals(path)
            ||"/api/auth/registration-rewards/read".equals(path)
            ||"/api/auth/phone-binding/verify".equals(path)
            ||"/api/auth/email-security/start".equals(path)
            ||"/api/auth/email-security/verify".equals(path)
            ||"/api/auth/email-binding/start".equals(path)
            ||"/api/auth/email-binding/verify".equals(path)
            ||"/api/auth/email-enrollment/start".equals(path)
            ||"/api/auth/email-enrollment/status".equals(path)
            ||"/api/auth/email-enrollment/resend".equals(path)
            ||"/api/auth/email-enrollment/verify".equals(path)
            ||"/api/auth/channel-change/target-check".equals(path)
            ||"/api/auth/channel-change/begin".equals(path)
            ||"/api/auth/channel-change/old-start".equals(path)
            ||"/api/auth/channel-change/old-verify".equals(path)
            ||"/api/auth/channel-change/request".equals(path)
            ||"/api/auth/channel-change/verify".equals(path)
            ||"/api/auth/channel-change/cancel".equals(path)
            ||"/api/auth/channel-change/reconcile".equals(path)
            ||"/api/auth/invitations/me".equals(path)
            ||"/api/auth/invitations/attribute".equals(path));
    }

    /** Returns true only for the score-only backup route, after validating the full URL. */
    static boolean requireAllowed(String target,String method) throws Exception {
        URI uri=new URI(target);
        boolean authHost=AUTH_HOST.equalsIgnoreCase(uri.getHost());
        boolean backupHost=SCORE_BACKUP_HOST.equalsIgnoreCase(uri.getHost())||API_ALIAS_HOST.equalsIgnoreCase(uri.getHost());
        if(!"https".equalsIgnoreCase(uri.getScheme())||(!authHost&&!backupHost)
            ||uri.getPort()!=-1||uri.getRawUserInfo()!=null||uri.getRawFragment()!=null)
            throw new Exception("此测试版仅连接核定的账号及成绩备份服务");
        String path=uri.getRawPath(),query=uri.getRawQuery();
        boolean allowedAuth=authHost&&(("GET".equals(method)&&"/auth/v1/user".equals(path)&&query==null)
            ||("PUT".equals(method)&&"/auth/v1/user".equals(path)&&query==null)
            ||("POST".equals(method)&&"/auth/v1/token".equals(path)
                &&("grant_type=password".equals(query)||"grant_type=refresh_token".equals(query)))
            ||("POST".equals(method)&&"/auth/v1/logout".equals(path)&&"scope=local".equals(query))
            ||("POST".equals(method)&&query==null
                &&("/auth/v1/signup".equals(path)||"/auth/v1/otp".equals(path)||"/auth/v1/verify".equals(path)||"/auth/v1/recover".equals(path))));
        boolean allowedBackup=backupHost&&"/api/score-backup".equals(path)&&query==null
            &&("GET".equals(method)||"PUT".equals(method));
        boolean allowedManualBackup=backupHost&&"/api/mobile-document".equals(path)&&query==null
            &&("GET".equals(method)||"PUT".equals(method));
        boolean allowedAccount=backupHost&&query==null&&(("GET".equals(method)&&("/api/auth/native-session/user".equals(path)||"/api/auth/status".equals(path)||"/api/auth/email-security/status".equals(path)||"/api/auth/email-binding/status".equals(path)||"/api/auth/channel-change/status".equals(path)||"/api/auth/invitations/me".equals(path)))
            ||isAccountPost(method,path)||("PUT".equals(method)&&"/api/auth/native-session/user".equals(path)));
        boolean allowedTeam=backupHost&&query==null&&isTeamMemberRequest(method,path);
        if(!allowedAuth&&!allowedBackup&&!allowedManualBackup&&!allowedAccount&&!allowedTeam&&!isPublicNews(target,method)&&!isPublicContributionPolicy(target,method))throw new Exception("此请求不属于已核定的账号、手动备份或本人团队服务");
        return allowedBackup;
    }
}
