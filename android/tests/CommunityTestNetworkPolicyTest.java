package app.gongxingji.training.debug;

/** Standalone checks for the account and score-backup bridge; no network is opened. */
public final class CommunityTestNetworkPolicyTest {
    private static final String AUTH="https://auth-4.example.invalid";
    private static final String BACKUP="https://service-3.example.invalid/api/score-backup";
    private static int checks;

    private static void pass(String target,String method)throws Exception{
        if(CommunityTestNetworkPolicy.requireAllowed(target,method))throw new AssertionError("Misclassified backup: "+target);
        checks++;
    }
    private static void passBackup(String target,String method)throws Exception{
        if(!CommunityTestNetworkPolicy.requireAllowed(target,method))throw new AssertionError("Misclassified account: "+target);
        checks++;
    }
    private static void reject(String target,String method){
        try{CommunityTestNetworkPolicy.requireAllowed(target,method);throw new AssertionError("Accepted: "+target);}
        catch(AssertionError error){throw error;}catch(Exception expected){checks++;}
    }
    public static void main(String[] args)throws Exception{
        final String team="https://service-1.example.invalid/api/team";
        final String tid="22222222-2222-4222-8222-222222222222";
        for(String endpoint:new String[]{"rewards/me","registration/me","registration/complete","rewards/claim","rewards/requests/read","operations/feedback/create","operations/feedback/search","operations/donations/create","operations/donations/search","operations/incidents/create","operations/announcements/read","operations/requests/read"}){
            String method=endpoint.endsWith("/me")?"GET":"POST";
            pass(team+"/"+endpoint,method);
            if(!CommunityTestNetworkPolicy.isTeamMemberRequest(method,"/api/team/"+endpoint))throw new AssertionError("Bridge route missing");checks++;
            for(String wrong:new String[]{"GET","POST","PUT","DELETE","PATCH"})if(!wrong.equals(method))reject(team+"/"+endpoint,wrong);
            for(String suffix:new String[]{"?owner=other","/extra","/","#part"})reject(team+"/"+endpoint+suffix,method);
            reject(AUTH+"/api/team/"+endpoint,method);
        }
        for(String endpoint:new String[]{"rewards/claims/issue","rewards/sources/revoke","operations/feedback/update","operations/announcements/publish"})reject(team+"/admin/"+endpoint,"POST");
        for(String action:new String[]{"prepare","read"}){
            String path="/api/auth/registration-rewards/"+action;
            pass("https://service-1.example.invalid"+path,"POST");
            if(!CommunityTestNetworkPolicy.isAccountPost("POST",path))throw new AssertionError("Registration bridge missing");checks++;
            for(String wrong:new String[]{"GET","PUT","DELETE","PATCH"})reject("https://service-1.example.invalid"+path,wrong);
            reject("https://service-1.example.invalid"+path+"?owner=other","POST");
        }
        pass(team+"/me","GET");
        pass(team+"/invitations/accept","POST");
        pass(team+"/member/teams/"+tid+"/sharing","GET");
        pass(team+"/member/teams/"+tid+"/sharing","PUT");
        pass(team+"/member/teams/"+tid+"/sharing","DELETE");
        pass(team+"/member/teams/"+tid+"/sessions/session-a","GET");
        pass(team+"/member/teams/"+tid+"/sessions/session-a","PUT");
        reject(team+"/admin/coaches","GET");
        reject(team+"/coach/teams","GET");
        reject(team+"/me?owner=other","GET");
        reject(team+"/member/teams/"+tid+"/sharing","POST");
        reject(team+"/member/teams/"+tid+"/sessions/session-a","DELETE");
        reject(team+"/member/teams/"+tid+"/sessions/../sharing","PUT");
        String alias="https://service-1.example.invalid";
        for(String action:new String[]{"start","status","resend","verify"}){
            String path="/api/auth/email-enrollment/"+action;
            for(String host:new String[]{alias,"https://service-3.example.invalid"}){
                pass(host+path,"POST");
                for(String method:new String[]{"GET","PUT","DELETE","PATCH"})reject(host+path,method);
                for(String suffix:new String[]{"?email=other","#part","/","/extra"})reject(host+path+suffix,"POST");
            }
            if(!CommunityTestNetworkPolicy.isAccountPost("POST",path))throw new AssertionError("Enrollment bridge missing");checks++;
            reject(AUTH+path,"POST");reject("https://evil.example"+path,"POST");
        }
        pass(alias+"/news-feed.v1.json","GET");
        for(String method:new String[]{"POST","PUT","DELETE","HEAD"})reject(alias+"/news-feed.v1.json",method);
        for(String suffix:new String[]{"?v=1","#item","/extra","/"})reject(alias+"/news-feed.v1.json"+suffix,"GET");
        reject("https://service-3.example.invalid/news-feed.v1.json","GET");
        reject(alias+"/news-feed.v2.json","GET");
        for(String path:new String[]{"/api/auth/status","/api/auth/email-security/status","/api/auth/email-binding/status"}){
            pass(alias+path,"GET");reject(alias+path,"POST");reject(alias+path+"?owner=other","GET");
        }
        for(String scope:new String[]{"phone-binding","email-security","email-binding"}){
            for(String action:new String[]{"start","verify"}){
                String path="/api/auth/"+scope+"/"+action;
                pass(alias+path,"POST");reject(alias+path,"GET");reject(alias+path+"/extra","POST");
            }
        }
        passBackup(alias+"/api/score-backup","GET");passBackup(alias+"/api/score-backup","PUT");
        for(String host:new String[]{"http://service-1.example.invalid","https://service-1.example.invalid:443","https://user@service-1.example.invalid","https://service-1.example.invalid.evil.example","https://other.gongxingji.com","https://gongxingji.com"})
            reject(host+"/api/auth/email-binding/status","GET");
        reject(alias+"/auth/v1/user","GET");
        for(String host:new String[]{alias,"https://service-3.example.invalid"}){
            for(String method:new String[]{"GET","PUT"})pass(host+"/api/mobile-document",method);
            for(String method:new String[]{"POST","DELETE","PATCH","HEAD"})reject(host+"/api/mobile-document",method);
            for(String suffix:new String[]{"?owner=other","#part","/","/extra"})reject(host+"/api/mobile-document"+suffix,"GET");
            reject(host+"/api/%6dobile-document","PUT");
        }
        reject(AUTH+"/api/mobile-document","PUT");
        reject("https://evil.example/api/mobile-document","GET");
        if(CommunityTestNetworkPolicy.MANUAL_BACKUP_HTTP_MAX_BYTES!=4001024)throw new AssertionError("Archive response buffer drift");checks++;
        if(CommunityTestNetworkPolicy.MANUAL_BACKUP_REQUEST_MAX_BYTES!=4000000)throw new AssertionError("Archive request limit drift");checks++;
        if(CommunityTestNetworkPolicy.MANUAL_BACKUP_HTTP_MAX_BYTES>=4500000)throw new AssertionError("Archive buffer exceeds hosted ceiling");checks++;
        reject(alias+"/api/auth/email-binding/%73tart","POST");reject(alias+"/api/auth/email-binding/start#part","POST");
        for(String scope:new String[]{"phone-binding","email-security","email-binding"}){
            for(String action:new String[]{"start","verify"}){
                String path="/api/auth/"+scope+"/"+action;
                if(!CommunityTestNetworkPolicy.isAccountPost("POST",path))throw new AssertionError("Native bridge rejects: "+path);
                checks++;
                for(String method:new String[]{"GET","PUT","DELETE"}){
                    if(CommunityTestNetworkPolicy.isAccountPost(method,path))throw new AssertionError("Native bridge accepts wrong method");
                    checks++;
                }
                for(String extra:new String[]{"/","/extra","?owner=other"}){
                    if(CommunityTestNetworkPolicy.isAccountPost("POST",path+extra))throw new AssertionError("Native bridge accepts wrong path");
                    checks++;
                }
            }
            if(CommunityTestNetworkPolicy.isAccountPost("POST","/api/auth/"+scope+"/status"))throw new AssertionError("Native bridge accepts status POST");
            checks++;
        }
        if(CommunityTestNetworkPolicy.SCORE_BACKUP_HTTP_MAX_BYTES!=2*1024*1024+1024)throw new AssertionError("Backup HTTP byte limit changed");
        checks++;
        pass(AUTH+"/auth/v1/token?grant_type=password","POST");
        pass(AUTH+"/auth/v1/token?grant_type=refresh_token","POST");
        pass(AUTH+"/auth/v1/user","GET");
        pass(AUTH+"/auth/v1/user","PUT");
        pass("https://service-3.example.invalid/api/auth/status","GET");
        pass("https://service-3.example.invalid/api/auth/phone-binding/start","POST");
        pass("https://service-3.example.invalid/api/auth/phone-binding/verify","POST");
        pass(AUTH+"/auth/v1/logout?scope=local","POST");
        pass(AUTH+"/auth/v1/signup","POST");
        pass(AUTH+"/auth/v1/otp","POST");
        pass(AUTH+"/auth/v1/verify","POST");
        pass(AUTH+"/auth/v1/recover","POST");
        pass("https://service-3.example.invalid/api/auth/email-security/status","GET");
        pass("https://service-3.example.invalid/api/auth/email-security/start","POST");
        pass("https://service-3.example.invalid/api/auth/email-security/verify","POST");
        pass("https://service-3.example.invalid/api/auth/email-binding/status","GET");
        pass("https://service-3.example.invalid/api/auth/email-binding/start","POST");
        pass("https://service-3.example.invalid/api/auth/email-binding/verify","POST");
        reject("https://service-3.example.invalid/api/auth/email-binding/status","POST");
        reject("https://service-3.example.invalid/api/auth/email-binding/start","GET");
        reject("https://service-3.example.invalid/api/auth/email-binding/verify","PUT");
        reject("https://service-3.example.invalid/api/auth/email-binding/verify?owner=other","POST");
        reject("https://service-3.example.invalid/api/auth/email-binding/start/extra","POST");
        passBackup(BACKUP,"GET");
        passBackup(BACKUP,"PUT");
        reject(BACKUP,"POST");
        reject(BACKUP,"DELETE");
        reject(BACKUP+"?all=true","GET");
        reject(BACKUP+"?","GET");
        reject(BACKUP+"#fragment","GET");
        reject(BACKUP+"/extra","GET");
        reject("https://service-3.example.invalid/api/%73core-backup","GET");
        reject("http://service-3.example.invalid/api/score-backup","GET");
        reject("https://service-3.example.invalid:443/api/score-backup","GET");
        reject("https://user@service-3.example.invalid/api/score-backup","GET");
        reject("https://service-3.example.invalid.evil.example/api/score-backup","GET");
        reject("https://preview-service-3.example.invalid/api/score-backup","GET");
        reject("https://service-3.example.invalid/api/mobile-document","DELETE");
        reject(AUTH+"/api/score-backup","GET");
        reject(AUTH+"/api/mobile-document","GET");
        reject(AUTH+"/api/mobile-document","PUT");
        reject(AUTH+"/auth/v1/signup?next=/api/mobile-document","POST");
        reject(AUTH+"/auth/v1/verify?type=signup","POST");
        reject(AUTH+"/auth/v1/otp?channel=sms","POST");
        reject(AUTH+"/auth/v1/otp","GET");
        reject(AUTH+"/auth/v1/signup","GET");
        reject(AUTH+"/auth/v1/resend","POST");
        reject(AUTH+"/auth/v1/recover?email=other","POST");
        reject("https://service-3.example.invalid/api/auth/email-security/verify?owner=other","POST");
        reject("https://service-3.example.invalid/api/auth/email-security/start","GET");
        reject("https://service-3.example.invalid/api/auth/email-security/verify","PUT");
        reject(AUTH+"/auth/v1/user?phone=1","PUT");
        reject("https://service-3.example.invalid/api/auth/phone-binding/start","PUT");
        reject("https://service-3.example.invalid/api/auth/phone-binding/verify?owner=other","POST");
        reject("https://auth-2.example.invalid/auth/v1/user","GET");
        reject("https://service-3.example.invalid/api/mobile-document","PATCH");
        reject("https://auth-4.example.invalid.evil.example/auth/v1/user","GET");
        reject("https://user@auth-4.example.invalid/auth/v1/user","GET");
        reject(AUTH+"/auth/v1/%75ser","GET");
        reject(AUTH+"/auth/v1/user#fragment","GET");
        System.out.println("CommunityTestNetworkPolicy: "+checks+" checks passed");
    }
}
