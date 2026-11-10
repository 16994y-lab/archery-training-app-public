package app.gongxingji.training.debug;

import java.util.HashMap;
import java.util.Map;

/** Standalone JVM tests for the second, native-side network allowlist. */
public final class CommunityRequestPolicyTest {
    private static final String BASE="https://service-3.example.invalid";
    private static final String ID="11111111-1111-4111-8111-111111111111";
    private static int checks;

    private static Map<String,String> headers(String... values){
        Map<String,String> result=new HashMap<>();result.put("accept","application/json");
        for(int i=0;i<values.length;i+=2)result.put(values[i],values[i+1]);
        return result;
    }
    private static void pass(String url,String method,Map<String,String> headers,String body)throws Exception{
        CommunityRequestPolicy.validate(url,method,headers,body,BASE);checks++;
    }
    private static void reject(String url,String method,Map<String,String> headers,String body){
        try{CommunityRequestPolicy.validate(url,method,headers,body,BASE);throw new AssertionError("Accepted unsafe community request: "+url+" "+method);}
        catch(AssertionError error){throw error;}
        catch(Exception expected){checks++;}
    }
    public static void main(String[] args)throws Exception{
        pass(BASE+"/api/community/profile","GET",headers(),"");
        pass(BASE+"/api/community/profile","PUT",headers("content-type","application/json"),"{\"nickname\":\"test\"}");
        pass(BASE+"/api/community/posts?cursor=abc_DEF-123&limit=50","GET",headers(),"");
        pass(BASE+"/api/community/posts","POST",headers("content-type","application/json","idempotency-key","same-key-123"),"{\"body\":\"hello\"}");
        pass(BASE+"/api/community/posts/"+ID+"/comments","POST",headers("content-type","application/json","idempotency-key","same-key-456"),"{\"body\":\"hello\"}");
        pass(BASE+"/api/community/posts/"+ID,"DELETE",headers("if-match","2"),"");
        pass(BASE+"/api/community/reports","POST",headers("content-type","application/json"),"{\"reason\":\"spam\"}");
        reject("http://service-3.example.invalid/api/community/posts","GET",headers(),"");
        reject("https://other.example.test/api/community/posts","GET",headers(),"");
        reject("https://user@service-3.example.invalid/api/community/posts","GET",headers(),"");
        try{CommunityRequestPolicy.validate("https://other.example.test/api/community/posts","GET",headers(),"","https://other.example.test");throw new AssertionError("JS-selected community origin was accepted");}
        catch(AssertionError error){throw error;}catch(Exception expected){checks++;}
        reject(BASE+"/api/community/posts#fragment","GET",headers(),"");
        reject(BASE+"/api/community/%70osts","GET",headers(),"");
        reject(BASE+"/api/community/profile?limit=1","GET",headers(),"");
        reject(BASE+"/api/community/posts?cursor=a&cursor=b","GET",headers(),"");
        reject(BASE+"/api/community/posts?limit=51","GET",headers(),"");
        reject(BASE+"/api/community/profile","DELETE",headers("if-match","1"),"");
        reject(BASE+"/api/community/posts","POST",headers("content-type","application/json"),"{}");
        reject(BASE+"/api/community/posts","POST",headers("content-type","application/json","idempotency-key","same-key-123","authorization","Bearer leak"),"{}");
        reject(BASE+"/api/community/posts/"+ID,"DELETE",headers("if-match","0"),"");
        reject(BASE+"/api/community/moderation/reports/"+ID,"PATCH",headers("content-type","application/json"),"{}");
        String first=new String(new char[64]).replace('\0','a'),second=new String(new char[64]).replace('\0','b');
        CommunityRequestPolicy.requireCurrentSession(first,first);checks++;
        try{CommunityRequestPolicy.requireCurrentSession(first,second);throw new AssertionError("Old session was accepted after same-owner login");}
        catch(AssertionError error){throw error;}catch(Exception expected){checks++;}
        try{CommunityRequestPolicy.requireCurrentSession("invalid",first);throw new AssertionError("Invalid session fingerprint was accepted");}
        catch(AssertionError error){throw error;}catch(Exception expected){checks++;}
        System.out.println("CommunityRequestPolicy: "+checks+" checks passed");
    }
}
