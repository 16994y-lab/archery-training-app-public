package app.gongxingji.training.debug;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.system.Os;
import android.util.Base64;
import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtLoggingLevel;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** One admitted request, CPU only, no photo persistence or raw exception logging. */
public final class NativePhotoInference implements AutoCloseable {
    public interface Emitter { void emit(JSONObject event); }
    private static final String SHA="c1bb85e71e251b97791ac86370ad013ba395c48c7e33cf904e971a1e6cda9f49";
    private static final String PREFIX="data:image/png;base64,";
    private static final int PNG_LIMIT=8*1024*1024;
    private static final int ENCODED_LIMIT=((PNG_LIMIT+2)/3)*4;
    private static final long MODEL_LIMIT=64L*1024*1024;
    private final Context context;
    private final Emitter emitter;
    private final ExecutorService work=Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService clock=Executors.newSingleThreadScheduledExecutor();
    private Job active;
    private boolean closed;
    private static final class Job {
        final String id; final int width,height;
        String data;
        boolean cancelled,terminal;
        OrtSession.RunOptions run;
        ScheduledFuture<?> timeout;
        Job(String id,String data,int width,int height){this.id=id;this.data=data;this.width=width;this.height=height;}
    }
    public NativePhotoInference(Context context,Emitter emitter) {
        if(context==null||emitter==null)throw new IllegalArgumentException("PHOTO_ARGUMENT");
        this.context=context.getApplicationContext();this.emitter=emitter;
    }
    public int maxLongEdge(){return 1024;}
    public synchronized String start(String id,String pngDataURL,int width,int height) {
        if(closed)return rejected("PHOTO_CLOSED");
        if(active!=null)return rejected("PHOTO_BUSY");
        if(id==null||!id.matches("[A-Za-z0-9_-]{1,128}")||width<32||height<32||width>1024||height>1024||(long)width*height>1048576
            ||pngDataURL==null||!pngDataURL.startsWith(PREFIX)||pngDataURL.length()<=PREFIX.length()||pngDataURL.length()-PREFIX.length()>ENCODED_LIMIT)
            return rejected("PHOTO_INPUT");
        Job job=new Job(id,pngDataURL,width,height);active=job;
        try {
            job.timeout=clock.schedule(()->timeout(job),90,TimeUnit.SECONDS);
            work.execute(()->execute(job));return "{\"ok\":true}";
        } catch(RuntimeException failure) {
            if(job.timeout!=null)job.timeout.cancel(false);job.data=null;active=null;return rejected("PHOTO_RUNTIME");
        }
    }
    public synchronized void cancel(String id) {
        if(active!=null&&active.id.equals(id)) stopLocked(active);
    }
    public synchronized void cancelAll(){if(active!=null)stopLocked(active);}
    @Override public synchronized void close(){
        if(closed)return;closed=true;if(active!=null)stopLocked(active);
        clock.shutdownNow();work.shutdown(); // Native run owns its finally cleanup; do not interrupt/close shared environment.
    }
    private static String rejected(String code){return "{\"ok\":false,\"code\":\""+code+"\"}";}
    private void stopLocked(Job job){
        job.cancelled=true;job.data=null;
        if(job.timeout!=null)job.timeout.cancel(false);
        if(job.run!=null)try{job.run.setTerminate(true);}catch(Exception|LinkageError|OutOfMemoryError ignored){}
    }
    private synchronized void timeout(Job job){
        if(closed||active!=job||job.cancelled||job.terminal)return;
        stopLocked(job);job.terminal=true;
        deliver(json("id",job.id,"type","stage","stage","TIMEOUT"));
        deliver(error(job,"PHOTO_TIMEOUT"));
    }
    private synchronized void live(Job job){
        if(closed||active!=job||job.cancelled||job.terminal)throw new Stopped();
    }
    private synchronized void stage(Job job,String stage){
        if(!closed&&active==job&&!job.cancelled&&!job.terminal)
            try{deliver(json("id",job.id,"type","stage","stage",stage));}catch(RuntimeException|OutOfMemoryError ignored){}
    }
    private void deliver(JSONObject event){try{emitter.emit(event);}catch(RuntimeException|LinkageError|OutOfMemoryError ignored){}}
    private static final class Stopped extends RuntimeException {}
    private static JSONObject json(Object... pairs){
        JSONObject result=new JSONObject();
        try{for(int i=0;i<pairs.length;i+=2)result.put((String)pairs[i],pairs[i+1]);}
        catch(JSONException impossible){throw new IllegalStateException("PHOTO_OUTPUT");}return result;
    }
    private static JSONObject error(Job job,String code){
        return json("id",job.id,"type","error","code",code,"message",code.equals("PHOTO_TIMEOUT")?"识别超过90秒，已停止，请返回照片核对。":"本机识别未完成，照片仍可用于人工核对。");
    }
    private void execute(Job job){
        Bitmap bitmap=null;OrtSession session=null;OrtSession.SessionOptions options=null;
        OrtSession.RunOptions run=null;OnnxTensor tensor=null;OrtSession.Result output=null;
        JSONObject result=null;String failureCode="PHOTO_INPUT";boolean failed=false;
        try {
            live(job);stage(job,"PHOTO_BEGIN");
            String data; synchronized(this){live(job);data=job.data;job.data=null;}
            byte[] png=decodePng(data);data=null;live(job);
            BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;
            BitmapFactory.decodeByteArray(png,0,png.length,bounds);
            if(bounds.outWidth!=job.width||bounds.outHeight!=job.height||!"image/png".equals(bounds.outMimeType))throw new IllegalArgumentException("PHOTO_INPUT");
            BitmapFactory.Options decode=new BitmapFactory.Options();decode.inScaled=false;decode.inPreferredConfig=Bitmap.Config.ARGB_8888;
            bitmap=BitmapFactory.decodeByteArray(png,0,png.length,decode);png=null;
            if(bitmap==null||bitmap.getWidth()!=job.width||bitmap.getHeight()!=job.height)throw new IllegalArgumentException("PHOTO_INPUT");
            live(job);stage(job,"IMAGE_READY");
            int n=job.width*job.height;int[] row=new int[job.width];float[] rgb=new float[n*3];
            for(int y=0;y<job.height;y++){
                live(job);bitmap.getPixels(row,0,job.width,0,y,job.width,1);
                for(int x=0;x<job.width;x++){int i=y*job.width+x,p=row[x];rgb[i]=((p>>>16)&255)/255f;rgb[n+i]=((p>>>8)&255)/255f;rgb[n*2+i]=(p&255)/255f;}
            }
            bitmap.recycle();bitmap=null;stage(job,"INPUT_READY");
            failureCode="PHOTO_MODEL";stage(job,"MODEL_FETCH");File model=verifiedModel(job);stage(job,"MODEL_FETCH_DONE");live(job);
            failureCode="PHOTO_RUNTIME";stage(job,"RUNTIME_LOAD");
            OrtEnvironment environment=OrtEnvironment.getEnvironment(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL,"gongxingji-photo");
            environment.setTelemetry(false);
            stage(job,"RUNTIME_READY");options=new OrtSession.SessionOptions();
            options.setIntraOpNumThreads(2);options.setInterOpNumThreads(1);
            options.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL);
            options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
            options.setCPUArenaAllocator(false);options.setMemoryPatternOptimization(false);
            options.setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL);options.setLoggerId("gongxingji-photo");options.disableProfiling();
            failureCode="PHOTO_MODEL";stage(job,"SESSION_CREATE");live(job);
            session=environment.createSession(model.getAbsolutePath(),options);live(job);
            if(!session.getInputNames().equals(Collections.singleton("rgb"))||!session.getOutputNames().equals(Collections.singleton("contact_logits")))throw new IllegalArgumentException("PHOTO_MODEL");
            stage(job,"SESSION_READY");
            tensor=OnnxTensor.createTensor(environment,FloatBuffer.wrap(rgb),new long[]{1,3,job.height,job.width});rgb=null;
            run=new OrtSession.RunOptions();run.setLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_FATAL);
            synchronized(this){live(job);job.run=run;}
            stage(job,"TENSOR_READY");failureCode="PHOTO_INFERENCE";stage(job,"INFERENCE_RUN");live(job);
            long started=SystemClock.elapsedRealtime();output=session.run(Collections.singletonMap("rgb",tensor),run);
            double inferenceMs=SystemClock.elapsedRealtime()-started;live(job);stage(job,"INFERENCE_DONE");failureCode="PHOTO_OUTPUT";
            OnnxValue value=output.get("contact_logits").orElse(null);
            if(!(value instanceof OnnxTensor))throw new IllegalArgumentException("PHOTO_OUTPUT");
            OnnxTensor logits=(OnnxTensor)value;TensorInfo info=logits.getInfo();
            if(info.type!=OnnxJavaType.FLOAT||!Arrays.equals(info.getShape(),new long[]{1,1,job.height,job.width}))throw new IllegalArgumentException("PHOTO_OUTPUT");
            FloatBuffer values=logits.getFloatBuffer();if(values==null||values.remaining()!=n)throw new IllegalArgumentException("PHOTO_OUTPUT");
            float[] probability=new float[n];
            for(int i=0;i<n;i++){float v=values.get();if(Float.isNaN(v)||Float.isInfinite(v))throw new IllegalArgumentException("PHOTO_OUTPUT");probability[i]=NativePhotoDecoder.sigmoid(v);}
            List<NativePhotoDecoder.Peak> found=NativePhotoDecoder.decode(probability,job.width,job.height);live(job);
            JSONArray peaks=new JSONArray();for(NativePhotoDecoder.Peak p:found)peaks.put(json("x",p.x,"y",p.y,"response",(double)p.response));
            result=json("id",job.id,"type","result","width",job.width,"height",job.height,"peaks",peaks,"inference_ms",inferenceMs,"verifiedModelSha256",SHA);
            stage(job,"DECODE_DONE");
        } catch(Stopped stopped) {
            // Cancellation/navigation is not a model failure or a zero-arrow result.
        } catch(Exception|LinkageError|OutOfMemoryError failure) {
            failed=true; // Never expose raw exception strings or runtime paths.
        } finally {
            stage(job,"RELEASE_START");
            synchronized(this){job.run=null;}
            closeResource(output);closeResource(tensor);closeResource(run);closeResource(session);closeResource(options);
            if(bitmap!=null)try{bitmap.recycle();}catch(RuntimeException ignored){}
            stage(job,"RELEASE_DONE");
            synchronized(this){
                try {
                    if(!closed&&active==job&&!job.cancelled&&!job.terminal){
                        if(result!=null&&!failed){stage(job,"RESULT_READY");job.terminal=true;deliver(result);}
                        else if(failed){stage(job,"PHOTO_FAILED");job.terminal=true;deliver(error(job,failureCode));}
                    }
                } finally {if(job.timeout!=null)job.timeout.cancel(false);job.data=null;if(active==job)active=null;}
            }
        }
    }
    private static void closeResource(AutoCloseable resource){if(resource!=null)try{resource.close();}catch(Exception|LinkageError|OutOfMemoryError ignored){}}
    private static byte[] decodePng(String data){
        String payload=data.substring(PREFIX.length());int padding=0;
        if((payload.length()&3)!=0)throw new IllegalArgumentException("PHOTO_INPUT");
        for(int i=0;i<payload.length();i++){
            char c=payload.charAt(i);
            if(c=='='){padding++;if(i<payload.length()-2||padding>2)throw new IllegalArgumentException("PHOTO_INPUT");}
            else if(padding!=0||!(c>='A'&&c<='Z'||c>='a'&&c<='z'||c>='0'&&c<='9'||c=='+'||c=='/'))throw new IllegalArgumentException("PHOTO_INPUT");
        }
        byte[] bytes=Base64.decode(payload,Base64.NO_WRAP);
        byte[] signature={(byte)137,80,78,71,13,10,26,10};
        if(bytes.length<8||bytes.length>PNG_LIMIT)throw new IllegalArgumentException("PHOTO_INPUT");
        for(int i=0;i<signature.length;i++)if(bytes[i]!=signature[i])throw new IllegalArgumentException("PHOTO_INPUT");return bytes;
    }
    private File verifiedModel(Job job)throws Exception {
        File dir=new File(context.getCacheDir(),"gongxingji-ort-model");
        if(!dir.isDirectory()&&!dir.mkdirs())throw new IllegalStateException("PHOTO_MODEL");
        File model=new File(dir,"phase11-contact-"+SHA+".onnx");
        if(model.isFile()&&model.length()>0&&model.length()<=MODEL_LIMIT&&SHA.equals(hash(model,job)))return model;
        // A new Activity may exist before an old cancelled worker has unwound.
        File part=File.createTempFile("phase11-contact-", ".part",dir);boolean complete=false;
        try {
            MessageDigest digest=MessageDigest.getInstance("SHA-256");long count=0;
            try(InputStream in=context.getAssets().open("www/photo-assist/phase11-contact.onnx");FileOutputStream out=new FileOutputStream(part,false)){
                byte[] buffer=new byte[65536];int read;
                while((read=in.read(buffer))!=-1){live(job);count+=read;if(count>MODEL_LIMIT)throw new IllegalArgumentException("PHOTO_MODEL");digest.update(buffer,0,read);out.write(buffer,0,read);}
                out.getFD().sync();
            }
            if(count==0||!SHA.equals(hex(digest.digest())))throw new IllegalArgumentException("PHOTO_MODEL");
            live(job);Os.rename(part.getAbsolutePath(),model.getAbsolutePath());complete=true;return model;
        } finally {if(!complete&&part.exists())part.delete();}
    }
    private String hash(File file,Job job)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");long count=0;
        try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];int read;
            while((read=in.read(buffer))!=-1){live(job);count+=read;if(count>MODEL_LIMIT)throw new IllegalArgumentException("PHOTO_MODEL");digest.update(buffer,0,read);}}
        return hex(digest.digest());
    }
    private static String hex(byte[] bytes){StringBuilder b=new StringBuilder(bytes.length*2);for(byte v:bytes)b.append(String.format(java.util.Locale.ROOT,"%02x",v&255));return b.toString();}
}
