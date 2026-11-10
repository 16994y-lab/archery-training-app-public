package app.gongxingji.training.debug;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Fixed contribution purpose. No personal archive permission or arbitrary upload endpoint. */
final class PhotoContributionRequestPolicy {
    static final int MAX_FILE_BYTES=8*1024*1024,MAX_REQUEST_BYTES=512*1024,MAX_POLICY_BYTES=32*1024;
    static final String UUID="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    private static final String PREFIX="/api/photo-contributions",SAMPLE=PREFIX+"/samples/"+UUID;
    private PhotoContributionRequestPolicy(){}
    private static void require(boolean valid)throws Exception{if(!valid)throw new Exception("照片贡献请求未通过限定核验");}
    static boolean matches(String path){return path!=null&&path.startsWith(PREFIX+"/");}
    static String fingerprint(String scope,String owner,String sessionDigest)throws Exception{
        require(PrivateMediaRequestPolicy.approved(scope)&&owner!=null&&owner.matches("[A-Za-z0-9_-]{1,128}")
            &&sessionDigest!=null&&sessionDigest.matches("[a-f0-9]{64}"));
        byte[] hash=java.security.MessageDigest.getInstance("SHA-256").digest(
            ("gongxingji/photo-contribution/v1\n"+scope+"\n"+owner+"\n"+sessionDigest).getBytes(StandardCharsets.UTF_8));
        StringBuilder result=new StringBuilder();for(byte b:hash)result.append(String.format(Locale.ROOT,"%02x",b&255));return result.toString();
    }
    static void publicRequest(String headers,String body)throws Exception{
        require(headers!=null&&headers.length()<=8192&&body!=null&&body.isEmpty());
        require(new JSONObject(headers).length()==0);
    }
    static void jsonResponse(String mime)throws Exception{
        require(mime!=null&&"application/json".equals(mime.split(";",2)[0].trim().toLowerCase(Locale.ROOT)));
    }
    static void pngSignature(byte[] first)throws Exception{
        byte[] signature={(byte)137,80,78,71,13,10,26,10};require(first.length>=signature.length);
        for(int i=0;i<signature.length;i++)require(first[i]==signature[i]);
    }
    static URI validate(String url,String method,Map<String,String> headers,String json,int bytes,String scope)throws Exception{
        try{return validateChecked(url,method,headers,json,bytes,scope);}
        catch(Exception rejected){throw new Exception("照片贡献请求未通过限定核验");}
    }
    private static URI validateChecked(String url,String method,Map<String,String> headers,String json,int bytes,String scope)throws Exception{
        require(url!=null&&url.length()<=2048&&method!=null&&headers!=null&&json!=null&&json.length()<=MAX_REQUEST_BYTES&&scope!=null);
        URI endpoint=new URI(url),service=new URI(scope);
        require(PrivateMediaRequestPolicy.approved(scope)&&scope.equals(PrivateMediaRequestPolicy.origin(service))
            &&(service.getRawPath()==null||service.getRawPath().isEmpty())&&service.getRawQuery()==null
            &&scope.equals(PrivateMediaRequestPolicy.origin(endpoint))&&endpoint.getRawQuery()==null);
        String path=endpoint.getRawPath();require(path!=null);
        boolean upload="PUT".equals(method)&&path.matches(SAMPLE+"/content");
        boolean read="GET".equals(method)&&(path.equals(PREFIX+"/choice")||path.matches(SAMPLE)||path.matches(SAMPLE+"/content-status"));
        boolean write="POST".equals(method)&&(path.equals(PREFIX+"/choice")||path.equals(PREFIX+"/requests/read")||path.equals(PREFIX+"/samples/prepare")||path.matches(SAMPLE+"/finalize"));
        require(upload||read||write);
        for(Map.Entry<String,String> item:headers.entrySet()){
            String key=item.getKey(),value=item.getValue();require(key!=null&&value!=null&&value.length()<=1024&&value.indexOf('\r')<0&&value.indexOf('\n')<0
                &&(key.equals("accept")||key.equals("content-type")||key.equals("x-contribution-request-id")));
        }
        require("application/json".equals(headers.get("accept")));
        if(upload){
            require(bytes>=1&&bytes<=MAX_FILE_BYTES&&json.isEmpty()&&"image/png".equals(headers.get("content-type"))&&headers.size()==3);
            require(headers.get("x-contribution-request-id")!=null&&headers.get("x-contribution-request-id").matches(UUID));
        }else if(read){require(bytes==0&&json.isEmpty()&&headers.size()==1);}
        else{
            require(bytes==0&&!json.isEmpty()&&json.getBytes(StandardCharsets.UTF_8).length<=MAX_REQUEST_BYTES
                &&headers.size()==2&&"application/json".equals(headers.get("content-type")));
            request(path,new JSONObject(json));
        }
        return endpoint;
    }
    private static JSONObject exact(JSONObject o,String... keys)throws Exception{
        require(o.length()==keys.length);for(String key:keys)require(o.has(key));return o;
    }
    private static String text(JSONObject o,String key,String pattern)throws Exception{
        Object value=o.get(key);require(value instanceof String&&((String)value).matches(pattern));return (String)value;
    }
    private static String one(JSONObject o,String key,String... choices)throws Exception{
        Object value=o.get(key);require(value instanceof String&&Arrays.asList(choices).contains(value));return (String)value;
    }
    private static void number(JSONObject o,String key,long min,long max)throws Exception{
        Object value=o.get(key);require(value instanceof Integer||value instanceof Long);long n=((Number)value).longValue();require(n>=min&&n<=max);
    }
    private static JSONObject obj(JSONObject o,String key)throws Exception{Object value=o.get(key);require(value instanceof JSONObject);return (JSONObject)value;}
    private static JSONArray array(JSONObject o,String key,int min,int max)throws Exception{Object value=o.get(key);require(value instanceof JSONArray);JSONArray a=(JSONArray)value;require(a.length()>=min&&a.length()<=max);return a;}
    private static void point(JSONObject o)throws Exception{exact(o,"x","y");number(o,"x",0,1000000);number(o,"y",0,1000000);}
    private static void score(JSONObject o)throws Exception{if(o.get("score")!=JSONObject.NULL)one(o,"score","X","10","9","8","7","6","5","4","3","2","1","M");}
    private static void geometry(JSONObject o)throws Exception{
        exact(o,"kind","controls","radiusRatioPpm");String kind=one(o,"kind","unlocated","auto-ellipse","manual-quad");
        number(o,"radiusRatioPpm",1,1000000);JSONArray controls=array(o,"controls",0,4);require(controls.length()==(kind.equals("unlocated")?0:4));
        for(int i=0;i<controls.length();i++)point(controls.getJSONObject(i));
    }
    private static Set<String> labels(JSONArray values,boolean predictions)throws Exception{
        Set<String> ids=new HashSet<>();
        for(int i=0;i<values.length();i++){
            JSONObject o=values.getJSONObject(i);
            if(predictions)exact(o,"id","point","score","responsePpm");else exact(o,"id","point","score","targetPoint","coordinateEvidence");
            require(ids.add(text(o,"id","p[1-9][0-9]{0,2}")));point(obj(o,"point"));score(o);
            if(predictions)number(o,"responsePpm",0,1000000);
            else if(o.get("targetPoint")==JSONObject.NULL)require(o.get("coordinateEvidence")==JSONObject.NULL);
            else{point(obj(o,"targetPoint"));one(o,"coordinateEvidence","manual-target-confirmed");}
        }return ids;
    }
    private static void request(String path,JSONObject o)throws Exception{
        if(path.equals(PREFIX+"/choice")){
            exact(o,"requestId","expectedRevision","choice","policyVersion");text(o,"requestId",UUID);number(o,"expectedRevision",0,9007199254740991L);
            one(o,"choice","participate","decline");one(o,"policyVersion","photo-contribution/v1");
        }else if(path.equals(PREFIX+"/requests/read")){
            if(o.has("readback")){
                exact(o,"requestId","readback");
                JSONObject readback=exact(obj(o,"readback"),"sampleId","manifestSha256","imageSha256","imageBytes","consentEpoch","consentRevision");
                text(readback,"sampleId",UUID);text(readback,"consentEpoch",UUID);
                text(readback,"manifestSha256","[a-f0-9]{64}");text(readback,"imageSha256","[a-f0-9]{64}");
                number(readback,"imageBytes",1,MAX_FILE_BYTES);number(readback,"consentRevision",1,9007199254740991L);
            }else exact(o,"requestId");
            text(o,"requestId",UUID);
        }
        else if(path.equals(PREFIX+"/samples/prepare")){
            exact(o,"requestId","sampleId","consentEpoch","consentRevision","manifestSha256","imageSha256","imageBytes","mime");
            text(o,"requestId",UUID);text(o,"sampleId",UUID);text(o,"consentEpoch",UUID);number(o,"consentRevision",1,9007199254740991L);
            text(o,"manifestSha256","[a-f0-9]{64}");text(o,"imageSha256","[a-f0-9]{64}");number(o,"imageBytes",1,MAX_FILE_BYTES);one(o,"mime","image/png");
        }else{
            exact(o,"requestId","manifest","manifestSha256");text(o,"requestId",UUID);text(o,"manifestSha256","[a-f0-9]{64}");
            JSONObject m=obj(o,"manifest");manifest(m);require(path.equals(PREFIX+"/samples/"+m.getString("sampleId")+"/finalize"));
        }
    }
    private static void manifest(JSONObject m)throws Exception{
        exact(m,"schema","sampleId","image","model","target","initial","correctionEvents","corrected","confirmation");one(m,"schema","photo-contribution/v1");text(m,"sampleId",UUID);
        JSONObject image=exact(obj(m,"image"),"kind","sha256","bytes","width","height","mime");one(image,"kind","inference-work-png");text(image,"sha256","[a-f0-9]{64}");
        number(image,"bytes",1,MAX_FILE_BYTES);number(image,"width",32,1024);number(image,"height",32,1024);one(image,"mime","image/png");
        JSONObject model=exact(obj(m,"model"),"status","sha256","decoder","preprocessing");one(model,"status","completed");text(model,"sha256","[a-f0-9]{64}");
        one(model,"decoder","phase11-regional-maxima-nms/v1");one(model,"preprocessing","rgb-planar-unit/v1");
        JSONObject target=exact(obj(m,"target"),"id","face","rulesVersion");text(target,"id","[a-zA-Z0-9_.:/-]{1,80}");number(target,"face",1,3);text(target,"rulesVersion","[a-zA-Z0-9_.:/-]{1,80}");
        JSONObject initial=exact(obj(m,"initial"),"geometry","predictions");geometry(obj(initial,"geometry"));Set<String> before=labels(array(initial,"predictions",0,256),true);
        JSONObject corrected=exact(obj(m,"corrected"),"geometry","labels","removedPredictionIds");geometry(obj(corrected,"geometry"));Set<String> after=labels(array(corrected,"labels",1,512),false);
        JSONArray removed=array(corrected,"removedPredictionIds",0,256);Set<String> removals=new HashSet<>();for(int i=0;i<removed.length();i++){Object v=removed.get(i);require(v instanceof String&&((String)v).matches("p[1-9][0-9]{0,2}")&&removals.add((String)v));}
        Set<String> missing=new HashSet<>(before);missing.removeAll(after);require(removals.equals(missing));
        replay(initial,array(m,"correctionEvents",0,256),corrected);
        JSONObject confirmation=exact(obj(m,"confirmation"),"kind","labelSource","labels");one(confirmation,"kind","user-confirmed-local-save");one(confirmation,"labelSource","user-not-ground-truth");
        JSONArray confirmed=array(confirmation,"labels",1,512);labels(confirmed,false);require(equal(confirmed,corrected.get("labels")));
        for(int i=0;i<confirmed.length();i++)require(confirmed.getJSONObject(i).get("score")!=JSONObject.NULL);
    }
    private static JSONObject eventLabel(JSONObject event,String key)throws Exception{
        Object value=event.get(key);if(value==JSONObject.NULL)return null;
        require(value instanceof JSONObject);JSONObject label=(JSONObject)value;
        labels(new JSONArray().put(label),false);return label;
    }
    /** Ordered history is evidence, never inferred from the final snapshot. */
    private static void replay(JSONObject initial,JSONArray events,JSONObject corrected)throws Exception{
        JSONArray predictions=initial.getJSONArray("predictions");Set<String> known=new HashSet<>();
        Map<String,JSONObject> current=new HashMap<>();
        for(int i=0;i<predictions.length();i++){
            JSONObject p=predictions.getJSONObject(i);String id=p.getString("id");require(id.equals("p"+(i+1)));known.add(id);
            current.put(id,new JSONObject().put("id",id).put("point",p.get("point")).put("score",p.get("score"))
                .put("targetPoint",JSONObject.NULL).put("coordinateEvidence",JSONObject.NULL));
        }
        for(int i=0;i<events.length();i++){
            JSONObject event=exact(events.getJSONObject(i),"seq","candidateId","kind","cause","before","after","undoOf");
            number(event,"seq",i+1,i+1);String id=text(event,"candidateId","p[1-9][0-9]{0,2}");
            String kind=one(event,"kind","add","remove","change");
            String cause=one(event,"cause","add-point","remove-point","move-point","set-score","restore-score","set-target-point");
            JSONObject before=eventLabel(event,"before"),after=eventLabel(event,"after");
            require((before==null||id.equals(before.getString("id")))&&(after==null||id.equals(after.getString("id"))));
            require(equal(current.get(id),before)&&!equal(before,after));
            if(kind.equals("add")){
                require(cause.equals("add-point")&&before==null&&after!=null&&!known.contains(id)
                    &&id.equals("p"+(known.size()+1))&&known.size()<512&&after.get("targetPoint")==JSONObject.NULL);
                known.add(id);
            }else if(kind.equals("remove")){
                require(cause.equals("remove-point")&&before!=null&&after==null);
            }else{
                require(before!=null&&after!=null);
                if(cause.equals("set-target-point")){
                    require(equal(before.get("point"),after.get("point"))&&equal(before.get("score"),after.get("score"))
                        &&after.get("targetPoint")!=JSONObject.NULL);
                }else if(cause.equals("set-score")||cause.equals("restore-score")){
                    require(equal(before.get("point"),after.get("point"))&&after.get("targetPoint")==JSONObject.NULL
                        &&(!cause.equals("set-score")||after.get("score")!=JSONObject.NULL));
                }else if(cause.equals("move-point"))require(after.get("targetPoint")==JSONObject.NULL);
                else require(false);
            }
            if(event.get("undoOf")!=JSONObject.NULL){
                number(event,"undoOf",1,i);JSONObject inverse=events.getJSONObject(((Number)event.get("undoOf")).intValue()-1);
                require(id.equals(inverse.getString("candidateId"))&&equal(eventLabel(inverse,"before"),after)
                    &&equal(eventLabel(inverse,"after"),before));
            }
            if(after==null)current.remove(id);else current.put(id,after);
        }
        JSONArray finalLabels=corrected.getJSONArray("labels");require(current.size()==finalLabels.length());
        for(int i=0;i<finalLabels.length();i++){
            JSONObject label=finalLabels.getJSONObject(i);require(equal(current.get(label.getString("id")),label));
        }
        require(equal(initial.get("geometry"),corrected.get("geometry")));
    }
    /** Android org.json has no JSONObject.similar; compare exact structures without key order. */
    private static boolean equal(Object a,Object b)throws Exception{
        if(a==b)return true;if(a==null||b==null)return false;
        if(a instanceof JSONObject&&b instanceof JSONObject){JSONObject x=(JSONObject)a,y=(JSONObject)b;if(x.length()!=y.length())return false;java.util.Iterator<String> keys=x.keys();while(keys.hasNext()){String k=keys.next();if(!y.has(k)||!equal(x.get(k),y.get(k)))return false;}return true;}
        if(a instanceof JSONArray&&b instanceof JSONArray){JSONArray x=(JSONArray)a,y=(JSONArray)b;if(x.length()!=y.length())return false;for(int i=0;i<x.length();i++)if(!equal(x.get(i),y.get(i)))return false;return true;}
        return a.equals(b);
    }
}
