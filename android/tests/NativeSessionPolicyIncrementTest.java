package app.gongxingji.training.debug;

/** Only the added fixed Auth business paths; opens no network. */
public final class NativeSessionPolicyIncrementTest {
    private static void allowed(String target,String method)throws Exception {
        if(CommunityTestNetworkPolicy.requireAllowed(target,method))throw new AssertionError("Auth classified as backup");
    }
    private static void denied(String target,String method)throws Exception {
        try{CommunityTestNetworkPolicy.requireAllowed(target,method);}catch(Exception expected){return;}
        throw new AssertionError("Out-of-scope Auth request admitted");
    }
    public static void main(String[] args)throws Exception {
        String base="https://service-1.example.invalid/api/auth/native-session";
        allowed(base+"/user","GET");denied(base+"/user","POST");
        for(String action:new String[]{"password","refresh","phone-otp","phone-verify"}){
            String path="/api/auth/native-session/"+action;
            allowed("https://service-1.example.invalid"+path,"POST");
            if(!CommunityTestNetworkPolicy.isAccountPost("POST",path))throw new AssertionError("Native bridge rejected admitted path");
            denied("https://service-1.example.invalid"+path,"GET");
            denied("https://service-1.example.invalid"+path+"?owner=other","POST");
            denied("https://service-1.example.invalid"+path+"/","POST");
            denied("https://service-1.example.invalid:443"+path,"POST");
            denied("https://evil.example"+path,"POST");
        }
        denied(base+"/signup","POST");denied(base+"/proxy","POST");
        System.out.println("Fixed original Auth paths and rejection boundaries passed; network0");
    }
}
