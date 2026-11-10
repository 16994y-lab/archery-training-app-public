package app.gongxingji.training.debug;

/** New exact password route only; no phone or network. */
public final class PasswordUpdatePolicyIncrementTest {
    private static void rejected(String url,String method) throws Exception {
        try { CommunityTestNetworkPolicy.requireAllowed(url,method); }
        catch(Exception expected) { return; }
        throw new AssertionError("Unexpected route admission");
    }
    public static void main(String[] args) throws Exception {
        CommunityTestNetworkPolicy.requireAllowed("https://service-1.example.invalid/api/auth/native-session/user","PUT");
        if(!CommunityTestNetworkPolicy.isPasswordPut("PUT","/api/auth/native-session/user"))throw new AssertionError();
        rejected("https://service-1.example.invalid/api/auth/native-session/user?target=other","PUT");
        rejected("https://service-1.example.invalid/auth/v1/user","PUT");
        rejected("https://auth-4.example.invalid/api/auth/native-session/user","PUT");
        rejected("https://other.invalid/api/auth/native-session/user","PUT");
        rejected("https://service-1.example.invalid/api/auth/native-session/phone-verify","PUT");
        rejected("https://service-1.example.invalid/api/auth/native-session/user","POST");
        rejected("https://service-1.example.invalid:443/api/auth/native-session/user","PUT");
        System.out.println("PASSWORD_UPDATE_EXACT_POLICY_PASS");
    }
}
