package app.gongxingji.training.debug;

import android.app.Activity;
import android.Manifest;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.provider.MediaStore;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.*;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.Toast;
import android.widget.FrameLayout;
import org.json.JSONObject;
import java.io.*;
import java.net.URI;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final boolean SOCIAL_ENABLED = false;
    private static final boolean PRIVATE_MEDIA_ENABLED = false;
    // Transport support only. Participation and every sample still require server consent.
    private static final boolean PHOTO_CONTRIBUTION_ENABLED = true;
    private static final boolean PROTECTED_ARCHIVE_ENABLED = false;
    private static final int PICK_FILE=41, SAVE_FILE=42, CAMERA_PERMISSION=43, PHOTO_PERMISSION=44, CAPTURE_PHOTO=45, SAVE_ARCHIVE=46;
    private WebView web;
    private final PhotoInferencePolicy photoInference=new PhotoInferencePolicy();
    private NativePhotoInference nativePhotoInference;
    private volatile int photoPageEpoch;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback defaultNetworkCallback;
    private Network defaultNetwork;
    private boolean networkObserverStopped;
    private Boolean reportedNetworkAvailable;
    private DocumentStore store;
    private static DocumentStore sharedStore;
    private static AuxiliaryStore sharedAux;
    private volatile ValueCallback<Uri[]> fileCallback;
    private PermissionRequest cameraRequest;
    private File capturedPhoto;
    private Uri capturedUri;
    private volatile byte[] pendingExport;
    private volatile String archivePickerId;
    private BinaryArchiveExport archiveExport;
    private final ExecutorService archiveWriter=Executors.newSingleThreadExecutor();
    private TextToSpeech speech;
    private volatile boolean speechReady;
    private volatile boolean speechUnavailable;
    private String pendingSpeech;
    private boolean reviewModeActive;
    private int reviewPreviousOrientation=ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private final ExecutorService network=Executors.newSingleThreadExecutor();
    private final PhoneOtpRequestLane phoneOtpNetwork=new PhoneOtpRequestLane();
    private final ExecutorService mediaNetwork=Executors.newSingleThreadExecutor();
    private PrivateMediaBridge privateMedia;
    private final ExecutorService reportWriter=Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicBoolean gallerySaving=new java.util.concurrent.atomic.AtomicBoolean(false);
    private final java.util.concurrent.atomic.AtomicBoolean sharePreparing=new java.util.concurrent.atomic.AtomicBoolean(false);

    private OfflinePhotoPolicy packagedPhotoPolicy() {
        try {
            android.content.pm.PackageInfo provider=WebView.getCurrentWebViewPackage();
            return OfflinePhotoPolicy.create(provider==null?null:provider.versionName,getAssets().list("www/assets"));
        } catch(Exception ignored) { return OfflinePhotoPolicy.strict(); }
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        synchronized(DocumentStore.class){if(sharedStore==null)sharedStore=new DocumentStore(getFilesDir());if(sharedAux==null)sharedAux=new AuxiliaryStore(getFilesDir());store=sharedStore;}
        try{privateMedia=new PrivateMediaBridge(getCacheDir(),mediaNetwork,sharedAux::mediaAccessToken,this::emitPrivateMedia,PRIVATE_MEDIA_ENABLED,PROTECTED_ARCHIVE_ENABLED,sharedAux::photoContributionAccessToken,PHOTO_CONTRIBUTION_ENABLED);}
        catch(Exception ignored){privateMedia=null;}
        try{archiveExport=new BinaryArchiveExport(getCacheDir(),archiveWriter,
            (scope,owner,pin)->sharedAux.mediaAccessToken(scope,owner,pin),this::emitArchiveExport,this::openArchivePicker,PROTECTED_ARCHIVE_ENABLED);}
        catch(Exception ignored){archiveExport=null;}
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(244,248,253));
        FrameLayout viewport = new FrameLayout(this);
        viewport.setBackgroundColor(Color.rgb(247,250,255));
        viewport.addView(web,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(viewport);
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            // Inset the viewport, not the scrolling WebView content: sticky headers must
            // stay below the status bar after scrolling and returning from full screen.
            viewport.setOnApplyWindowInsetsListener((v,insets)->{android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());v.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});
        }
        WebSettings settings=web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        nativePhotoInference=new NativePhotoInference(this,this::emitPhotoInference);
        web.addJavascriptInterface(new Bridge(),"Gongxingji");
        final OfflinePhotoPolicy photoPolicy=packagedPhotoPolicy();
        web.setWebViewClient(new WebViewClient(){
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap favicon){
                if(view==web){photoPageEpoch++;photoInference.reset();if(nativePhotoInference!=null)nativePhotoInference.cancelAll();}
                if(privateMedia!=null)privateMedia.cancelAll();
                if(archiveExport!=null)archiveExport.cancelAll();
                // Keep the old system-picker routing lock until its result arrives.
                super.onPageStarted(view,url,favicon);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                String host=uri.getHost();
                // Recovery reloads the packaged main page after replacing the local document.
                if(request.isForMainFrame()&&"https".equals(uri.getScheme())&&"appassets.androidplatform.net".equals(host)
                    &&uri.getUserInfo()==null&&uri.getPort()==-1&&"/mobile.html".equals(uri.getPath())&&uri.getQuery()==null)return false;
                boolean official="www.worldarchery.sport".equalsIgnoreCase(host)||"worldarchery.sport".equalsIgnoreCase(host)
                    ||"www.sport.gov.cn".equalsIgnoreCase(host)||"sport.gov.cn".equalsIgnoreCase(host);
                if(request.isForMainFrame()&&request.hasGesture()&&"https".equalsIgnoreCase(uri.getScheme())
                    &&uri.getUserInfo()==null&&(official||ReviewedNewsImagePolicy.allowedBrowserLink(uri.toString()))){
                    try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}
                    catch(android.content.ActivityNotFoundException error){Toast.makeText(MainActivity.this,"未找到可打开资讯的浏览器",Toast.LENGTH_SHORT).show();}
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();
                if (ReviewedNewsImagePolicy.allowed(uri.toString(),request.getMethod())) {
                    try{return ReviewedNewsImageLoader.load(uri.toString(),request.getMethod());}
                    catch(IOException error){return errorResponse();}
                }
                if (!"appassets.androidplatform.net".equals(uri.getHost())) {
                    // Picked photos can use content: URIs, but page resources must
                    // never open another network origin outside the native bridges.
                    String scheme=uri.getScheme();
                    return "http".equalsIgnoreCase(scheme)||"https".equalsIgnoreCase(scheme)
                        ? errorResponse():null;
                }
                if (!"https".equals(uri.getScheme()) || !"GET".equals(request.getMethod())) return errorResponse();
                String path=uri.getPath();
                if(path==null || path.contains("..") || !path.startsWith("/")) return errorResponse();
                if(path.equals("/"))path="/mobile.html";
                try {
                    InputStream input=getAssets().open("www"+path);
                    String mime=path.endsWith(".html")?"text/html":path.endsWith(".js")||path.endsWith(".mjs")?"application/javascript":path.endsWith(".wasm")?"application/wasm":path.endsWith(".css")?"text/css":path.endsWith(".svg")?"image/svg+xml":path.endsWith(".json")?"application/json":"application/octet-stream";
                    return new WebResourceResponse(mime,"UTF-8",200,"OK",Collections.singletonMap("Content-Security-Policy",photoPolicy.forRequest(uri.toString(),request.isForMainFrame())),input);
                } catch(IOException error){return errorResponse();}
            }
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
            @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){
                boolean current=view==web;
                if(current&&PhotoInferencePolicy.STAGE_LOGS_ENABLED)android.util.Log.i("GongxingjiPhoto",photoInference.rendererExit(detail.didCrash()));
                if(current){photoPageEpoch++;if(nativePhotoInference!=null)nativePhotoInference.cancelAll();if(reviewModeActive)applyReviewMode(false);web=null;fileCallback=null;cameraRequest=null;stopSpeechGuide(false);
                    if(privateMedia!=null)privateMedia.cancelAll();if(archiveExport!=null)archiveExport.cancelAll();}
                android.view.ViewParent parent=view.getParent();
                if(parent instanceof android.view.ViewGroup)((android.view.ViewGroup)parent).removeView(view);
                view.destroy();
                if(current&&!isDestroyed()&&!isFinishing()){
                    android.widget.LinearLayout recovery=new android.widget.LinearLayout(MainActivity.this);
                    recovery.setOrientation(android.widget.LinearLayout.VERTICAL);
                    recovery.setGravity(android.view.Gravity.CENTER);
                    int inset=(int)(24*getResources().getDisplayMetrics().density);recovery.setPadding(inset,inset,inset,inset);
                    recovery.setBackgroundColor(Color.rgb(244,248,253));
                    android.widget.TextView title=new android.widget.TextView(MainActivity.this);title.setText("页面意外停止");title.setTextSize(22);recovery.addView(title);
                    android.widget.TextView notice=new android.widget.TextView(MainActivity.this);notice.setText("已保存的训练保留。未保存的修改可能丢失；重新打开后请先检查本组记录。");notice.setTextSize(16);notice.setPadding(0,inset,0,inset);recovery.addView(notice);
                    android.widget.Button reopen=new android.widget.Button(MainActivity.this);reopen.setText("重新打开");reopen.setOnClickListener(button->recreate());recovery.addView(reopen);
                    setContentView(recovery);
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(pendingExport!=null||archivePickerId!=null||(archiveExport!=null&&archiveExport.busy())){
                    callback.onReceiveValue(null);notifyUser("请先完成或取消文件保存");return true;
                }
                if(fileCallback!=null)fileCallback.onReceiveValue(null);
                fileCallback=callback;
                FileChooserPolicy choice=FileChooserPolicy.fromAcceptTypes(params.getAcceptTypes());
                if(!choice.allowed()){
                    fileCallback.onReceiveValue(null);fileCallback=null;
                    notifyUser("此文件类型不受支持，请选择图片、视频或训练备份");return true;
                }
                if(params.isCaptureEnabled()&&choice.hasImages()){
                    if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)capturePhoto();
                    else requestPermissions(new String[]{Manifest.permission.CAMERA},PHOTO_PERMISSION);
                    return true;
                }
                try{
                    Intent intent=params.createIntent();
                    intent.setType(choice.primaryType());
                    intent.putExtra(Intent.EXTRA_MIME_TYPES,choice.mimeTypes());
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent,PICK_FILE);
                }
                catch(Exception error){fileCallback.onReceiveValue(null);fileCallback=null;notifyUser("此设备文件选择不可用；手动记分可继续");}
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->requestCamera(request));}
            @Override public void onPermissionRequestCanceled(PermissionRequest request){runOnUiThread(()->{if(cameraRequest==request)cameraRequest=null;});}
        });
        initializeSpeech();
        startNetworkObserver();
        web.loadUrl(ORIGIN+"/mobile.html");
    }
    private boolean trustedOrigin(Uri origin){
        return "https".equals(origin.getScheme())&&"appassets.androidplatform.net".equals(origin.getHost())
            &&(origin.getPort()==-1||origin.getPort()==443)&&origin.getUserInfo()==null
            &&(origin.getPath()==null||origin.getPath().isEmpty()||origin.getPath().equals("/"))
            &&origin.getQuery()==null&&origin.getFragment()==null;
    }
    private void applyReviewMode(boolean active){
        if(web==null)return;
        if(active==reviewModeActive)return;
        reviewModeActive=active;
        if(active){
            reviewPreviousOrientation=getRequestedOrientation();
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        }else setRequestedOrientation(reviewPreviousOrientation);
        if(android.os.Build.VERSION.SDK_INT>=30){
            WindowInsetsController controller=getWindow().getInsetsController();
            if(controller!=null){
                if(active){controller.hide(WindowInsets.Type.statusBars()|WindowInsets.Type.navigationBars());controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);}
                else controller.show(WindowInsets.Type.statusBars()|WindowInsets.Type.navigationBars());
            }
        }else{
            getWindow().getDecorView().setSystemUiVisibility(active
                ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY|View.SYSTEM_UI_FLAG_FULLSCREEN|View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION|View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_LAYOUT_STABLE|View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }
    private void requestCamera(PermissionRequest request){
        // Never grant an entire resource list: future WebView versions may add permissions.
        boolean video=false;
        for(String resource:request.getResources())if(PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource))video=true;
        if(isDestroyed()||!trustedOrigin(request.getOrigin())||!video){request.deny();return;}
        if(cameraRequest!=null){request.deny();return;}
        if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED){
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});return;
        }
        cameraRequest=request;
        requestPermissions(new String[]{Manifest.permission.CAMERA},CAMERA_PERMISSION);
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] grants){
        super.onRequestPermissionsResult(code,permissions,grants);
        if(code==PHOTO_PERMISSION){
            if(fileCallback==null)return;
            if(grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED)capturePhoto();
            else{fileCallback.onReceiveValue(null);fileCallback=null;notifyUser("相机权限未开启，可选择已有照片或继续手动记分");}
            return;
        }
        if(code!=CAMERA_PERMISSION)return;
        PermissionRequest pending=cameraRequest;cameraRequest=null;
        if(pending==null)return;
        if(!isDestroyed()&&grants.length>0&&grants[0]==PackageManager.PERMISSION_GRANTED&&trustedOrigin(pending.getOrigin()))
            pending.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        else pending.deny();
    }
    private void capturePhoto(){
        try{
            clearCapturedPhoto();
            File directory=new File(getCacheDir(),"camera");
            if(!directory.exists()&&!directory.mkdirs())throw new IOException("无法创建临时照片");
            capturedPhoto=new File(directory,"capture-"+java.util.UUID.randomUUID()+".jpg");
            if(!capturedPhoto.createNewFile())throw new IOException("临时照片已存在");
            capturedUri=Uri.parse("content://"+getPackageName()+".capture/"+capturedPhoto.getName());
            Intent intent=new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT,capturedUri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("temporary photo",capturedUri));
            startActivityForResult(intent,CAPTURE_PHOTO);
        }catch(Exception error){clearCapturedPhoto();if(fileCallback!=null){fileCallback.onReceiveValue(null);fileCallback=null;}notifyUser("无法打开拍照，请改为选择已有照片");}
    }
    private void clearCapturedPhoto(){
        if(capturedUri!=null)revokeUriPermission(capturedUri,Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if(capturedPhoto!=null&&capturedPhoto.isFile())capturedPhoto.delete();
        capturedPhoto=null;capturedUri=null;
    }
    private void initializeSpeech(){
        speech=new TextToSpeech(this,status->{
            if(status!=TextToSpeech.SUCCESS||speech==null){speechUnavailable=true;speechReady=false;pendingSpeech=null;speechEvent("unavailable","此设备没有可用的离线中文语音，已保留完整文字提示。");return;}
            Voice localChinese=null;
            try{for(Voice voice:speech.getVoices())if(!voice.isNetworkConnectionRequired()&&"zh".equalsIgnoreCase(voice.getLocale().getLanguage())){localChinese=voice;break;}}
            catch(Exception ignored){}
            if(localChinese==null||speech.setVoice(localChinese)==TextToSpeech.ERROR){speechUnavailable=true;speechReady=false;pendingSpeech=null;speechEvent("unavailable","此设备没有可用的离线中文语音，已保留完整文字提示。");return;}
            speech.setSpeechRate(1f);speech.setPitch(1f);speech.setOnUtteranceProgressListener(new UtteranceProgressListener(){
                @Override public void onStart(String id){speechEvent("started","正在播放本机中文语音…");}
                @Override public void onDone(String id){speechEvent("done","语音播放结束，可直接拍摄。");}
                @Override public void onError(String id){speechEvent("error","本机中文语音播放失败，已保留完整文字提示。");}
            });
            speechReady=true;String queued=pendingSpeech;pendingSpeech=null;if(queued!=null)startSpeech(queued);
        });
    }
    private void speechEvent(String state,String message){runOnUiThread(()->{if(web==null||isDestroyed())return;try{String detail=new JSONObject().put("state",state).put("message",message).toString();web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-speech',{detail:"+detail+"}))",null);}catch(Exception ignored){}});}
    private void startSpeech(String text){
        if(speech==null||!speechReady){pendingSpeech=text;speechEvent("pending","正在准备本机中文语音；可先阅读提示并拍摄。");return;}
        pendingSpeech=null;int result=speech.speak(text,TextToSpeech.QUEUE_FLUSH,null,"gongxingji-capture-guide");
        if(result==TextToSpeech.ERROR)speechEvent("error","本机中文语音播放失败，已保留完整文字提示。");
    }
    private void queueSpeech(String text){
        if(web==null)return;
        if(speechUnavailable){speechEvent("unavailable","此设备没有可用的离线中文语音，已保留完整文字提示。");return;}
        startSpeech(text);
    }
    private void stopSpeechGuide(boolean notify){pendingSpeech=null;if(speech!=null)speech.stop();if(notify)speechEvent("stopped","语音已停止，可直接拍摄。");}
    private WebResourceResponse errorResponse(){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream("Missing packaged resource".getBytes(StandardCharsets.UTF_8)));}
    private static String ok(String data){try{return new JSONObject().put("ok",true).put("data",data==null?JSONObject.NULL:data).toString();}catch(Exception e){return "{\"ok\":false}";}}
    private static String failure(Exception e){try{return new JSONObject().put("ok",false).put("error",e.getMessage()).toString();}catch(Exception ignored){return "{\"ok\":false,\"error\":\"保存失败\"}";}}
    private void emitPhotoInference(JSONObject packet){
        final int epoch=photoPageEpoch;final WebView target=web;
        if("stage".equals(packet.optString("type"))){
            String accepted=photoInference.accept(packet.optString("stage"));
            if(accepted!=null&&PhotoInferencePolicy.STAGE_LOGS_ENABLED)android.util.Log.i("GongxingjiPhoto",accepted);
        }
        runOnUiThread(()->{if(target!=null&&target==web&&epoch==photoPageEpoch&&!isDestroyed()&&!isFinishing())target.evaluateJavascript("window.dispatchEvent(new CustomEvent(\"gongxingji-photo-result\",{detail:"+packet.toString()+"}))",null);});
    }
    private void notifyUser(String message){runOnUiThread(()->{Toast.makeText(getApplicationContext(),message,Toast.LENGTH_LONG).show();if(!isDestroyed()&&!isFinishing()&&web!=null)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-notice',{detail:"+JSONObject.quote(message)+"}))",null);});}
    private void prepareReportShare(String filename,String mime,byte[] bytes) throws IOException {
        if(!sharePreparing.compareAndSet(false,true))throw new IOException("分享图片正在准备，请稍候");
        try {reportWriter.execute(()->{
            File created=null;
            try {
                File directory=new File(getCacheDir(),"reports");
                if(!directory.exists()&&!directory.mkdirs())throw new IOException("无法创建分享文件");
                created=new File(directory,java.util.UUID.randomUUID()+"-"+filename);
                if(!created.createNewFile())throw new IOException("分享文件已存在");
                try(FileOutputStream output=new FileOutputStream(created)){output.write(bytes);output.getFD().sync();}
                final File ready=created;
                runOnUiThread(()->{
                    boolean launched=false;
                    try {
                        if(isDestroyed()||isFinishing()||web==null)return;
                        Uri uri=Uri.parse("content://"+getPackageName()+".reports/"+ready.getName());
                        Intent intent=new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.setClipData(ClipData.newRawUri("report",uri));
                        startActivity(Intent.createChooser(intent,"分享预览的训练报告"));launched=true;
                    }catch(Exception error){notifyUser("系统分享未打开，请重试；训练记录保留");}
                    finally {
                        // Successful receivers may read later: never delete on chooser return/cancel.
                        if(!launched)ready.delete();
                        sharePreparing.set(false);
                    }
                });
            }catch(Exception error){if(created!=null)created.delete();sharePreparing.set(false);notifyUser("分享文件准备失败，请重试；训练记录保留");}
        });}catch(Exception error){sharePreparing.set(false);throw new IOException("分享暂不可用，请重试",error);}
    }
    private void finishHttpConnection(boolean phoneOtp,HttpURLConnection connection){
        if(phoneOtp)phoneOtpNetwork.finishConnection(connection);
        else if(connection!=null)connection.disconnect();
    }
    private void httpRequest(String id,String url,String method,String headers,String body) {
        final boolean phoneOtp=PhoneOtpRequestLane.matches(url,method);
        Runnable task=()->{
            final PhoneOtpRequestLane.Request phoneRequest=phoneOtp?phoneOtpNetwork.currentRequest():null;
            JSONObject result=new JSONObject();HttpsURLConnection connection=null;boolean publicContribution=false;
            try {
                if(phoneOtp)phoneOtpNetwork.checkActive();
                result.put("id",id);URL endpoint=new URL(url);
                if(!"https".equals(endpoint.getProtocol())||endpoint.getUserInfo()!=null)throw new Exception("只允许HTTPS服务地址");
                boolean scoreBackup=CommunityTestNetworkPolicy.requireAllowed(url,method);
                boolean publicNews=CommunityTestNetworkPolicy.isPublicNews(url,method);
                publicContribution=CommunityTestNetworkPolicy.isPublicContributionPolicy(url,method);
                if(publicContribution)PhotoContributionRequestPolicy.publicRequest(headers,body);
                String route=endpoint.getPath();
                boolean manualBackup=route.equals("/api/mobile-document");
                boolean authPost=method.equals("POST")&&(route.equals("/auth/v1/token")||route.equals("/auth/v1/signup")||route.equals("/auth/v1/otp")||route.equals("/auth/v1/recover")||route.equals("/auth/v1/verify")||route.equals("/auth/v1/logout"));
                boolean documentPut=method.equals("PUT")&&route.equals("/api/mobile-document");
                boolean passwordPut=CommunityTestNetworkPolicy.isPasswordPut(method,route);
                boolean scoreBackupPut=scoreBackup&&method.equals("PUT");
                boolean accountPost=CommunityTestNetworkPolicy.isAccountPost(method,route);
                boolean teamMember=CommunityTestNetworkPolicy.isTeamMemberRequest(method,route);
                if(passwordPut&&!SOCIAL_ENABLED){JSONObject change=new JSONObject(body);if(change.length()!=1||!change.has("password")||!(change.get("password") instanceof String)||change.getString("password").length()<8)throw new Exception("此入口仅允许设置登录密码；手机绑定请使用验证入口");}
                if(!method.equals("GET")&&!authPost&&!documentPut&&!passwordPut&&!scoreBackupPut&&!accountPost&&!teamMember)throw new Exception("此请求不属于已接入的账号、成绩备份或本人团队接口");
                byte[] requestBytes=body.getBytes(StandardCharsets.UTF_8);
                int requestLimit=teamMember?2*1024*1024:manualBackup?CommunityTestNetworkPolicy.MANUAL_BACKUP_REQUEST_MAX_BYTES:scoreBackup?CommunityTestNetworkPolicy.SCORE_BACKUP_HTTP_MAX_BYTES:65536;
                if(requestBytes.length>requestLimit)throw new Exception("请求内容超过容量保护");
                if(phoneOtp)phoneOtpNetwork.checkActive();
                connection=(HttpsURLConnection)endpoint.openConnection();
                if(phoneOtp&&!phoneOtpNetwork.connectionOpened(connection))throw new IOException("短信请求页面已关闭，发送结果未确认，请勿重复申请");
                connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(phoneOtp?Math.min(15000,phoneOtpNetwork.remainingMillis()):15000);connection.setReadTimeout(phoneOtp?phoneOtpNetwork.remainingMillis():PhoneOtpRequestLane.readTimeoutMillis(url,method));connection.setRequestMethod(method);
                JSONObject requestedHeaders=new JSONObject(headers);
                if(publicNews&&(requestedHeaders.length()!=0||requestBytes.length!=0))throw new Exception("资讯仅支持不带账号信息的公开读取");
                for(String key:new String[]{"Authorization","apikey","Accept","Content-Type","If-Match"})if(requestedHeaders.has(key))connection.setRequestProperty(key,requestedHeaders.getString(key));
                if(method.equals("POST")||method.equals("PUT")||(teamMember&&method.equals("DELETE"))){connection.setDoOutput(true);connection.setFixedLengthStreamingMode(requestBytes.length);if(phoneOtp)phoneOtpNetwork.checkActive();try(OutputStream stream=connection.getOutputStream()){if(phoneOtp)phoneOtpNetwork.checkActive();stream.write(requestBytes);if(phoneOtp)phoneOtpNetwork.checkActive();}}
                if(phoneOtp){phoneOtpNetwork.checkActive();connection.setReadTimeout(phoneOtpNetwork.remainingMillis());}
                int status=connection.getResponseCode();if(phoneOtp)phoneOtpNetwork.checkActive();if(status>=300&&status<400)throw new Exception("服务发生重定向，请填写最终HTTPS地址");
                InputStream source=status>=400?connection.getErrorStream():connection.getInputStream();ByteArrayOutputStream output=new ByteArrayOutputStream();
                if(publicContribution)PhotoContributionRequestPolicy.jsonResponse(connection.getContentType());
                int responseLimit=publicContribution?PhotoContributionRequestPolicy.MAX_POLICY_BYTES:teamMember?2*1024*1024+8192:publicNews?180000:manualBackup?CommunityTestNetworkPolicy.MANUAL_BACKUP_HTTP_MAX_BYTES:scoreBackup?CommunityTestNetworkPolicy.SCORE_BACKUP_HTTP_MAX_BYTES:28*1024*1024;
                if(source!=null)try(InputStream input=source){byte[] buffer=new byte[8192];int read;while(true){if(phoneOtp){phoneOtpNetwork.checkActive();connection.setReadTimeout(phoneOtpNetwork.remainingMillis());}read=input.read(buffer);if(phoneOtp)phoneOtpNetwork.checkActive();if(read==-1)break;if(output.size()+read>responseLimit)throw new Exception("云响应超过容量保护");output.write(buffer,0,read);}}
                if(phoneOtp)phoneOtpNetwork.checkActive();
                result.put("status",status).put("body",output.toString("UTF-8"));
            }catch(Exception error){try{result.put("error",publicContribution?"贡献条款读取未确认":"云连接失败："+error.getMessage());}catch(Exception ignored){}}
            finally{finishHttpConnection(phoneOtp,connection);}
            String payload=result.toString();runOnUiThread(()->{if(!isDestroyed()&&web!=null&&(!phoneOtp||phoneOtpNetwork.canDeliver(phoneRequest)))web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-http',{detail:"+payload+"}))",null);});
        };
        if(phoneOtp){
            PhoneOtpRequestLane.Submission submitted=phoneOtpNetwork.submit(id,task,()->runOnUiThread(()->{try{
                String payload=new JSONObject().put("id",id).put("error","短信请求等待已结束，发送结果未确认；请查看已收到的短信，以页面倒计时为准，结束后可手动重新获取。不会自动重发").toString();
                if(!isDestroyed()&&web!=null)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-http',{detail:"+payload+"}))",null);
            }catch(Exception ignored){}}));
            // A duplicate bridge ID must not settle the original pending callback.
            if(submitted==PhoneOtpRequestLane.Submission.REJECTED)runOnUiThread(()->{try{
                String payload=new JSONObject().put("id",id).put("error","短信通道仍在处理或回收旧请求，暂不能再次申请；请查看已收到的短信或使用密码登录。不会自动重发").toString();
                if(!isDestroyed()&&web!=null)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-http',{detail:"+payload+"}))",null);
            }catch(Exception ignored){}});
        }else network.execute(task);
    }
    private void httpCommunityRequest(String id,String url,String method,String headers,String body,String scope,String owner,String sessionFingerprint){
        if(!SOCIAL_ENABLED){
            runOnUiThread(()->{try{
                String payload=new JSONObject().put("id",id).put("error","此版本未启用社交功能").toString();
                if(!isDestroyed()&&web!=null)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-http',{detail:"+payload+"}))",null);
            }catch(Exception ignored){}});
            return;
        }
        network.execute(()->{
            JSONObject result=new JSONObject();HttpsURLConnection connection=null;
            try{
                result.put("id",id);
                JSONObject supplied=new JSONObject(headers);
                Map<String,String> approvedHeaders=new HashMap<>();
                Iterator<String> keys=supplied.keys();
                while(keys.hasNext()){
                    String key=keys.next(),normalized=key.toLowerCase(Locale.ROOT);
                    Object value=supplied.get(key);
                    if(!(value instanceof String)||approvedHeaders.put(normalized,(String)value)!=null)
                        throw new Exception("社区请求头无效");
                }
                URI endpoint=CommunityRequestPolicy.validate(url,method,approvedHeaders,body,scope);
                if(!body.isEmpty())new JSONObject(body);
                // Read the durable session only after the request starts. A queued request
                // must not borrow a later login, including one by the same owner.
                String token=sharedAux.communityAccessToken(scope,owner,sessionFingerprint);
                connection=(HttpsURLConnection)endpoint.toURL().openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setRequestMethod(method);
                connection.setRequestProperty("Accept","application/json");
                connection.setRequestProperty("Authorization","Bearer "+token);
                if(approvedHeaders.containsKey("idempotency-key"))connection.setRequestProperty("Idempotency-Key",approvedHeaders.get("idempotency-key"));
                if(approvedHeaders.containsKey("if-match"))connection.setRequestProperty("If-Match",approvedHeaders.get("if-match"));
                if(!body.isEmpty()){
                    byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
                    connection.setRequestProperty("Content-Type","application/json");
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try(OutputStream stream=connection.getOutputStream()){stream.write(bytes);}
                }
                int status=connection.getResponseCode();
                if(status>=300&&status<400)throw new Exception("社区服务重定向已拒绝");
                InputStream source=status>=400?connection.getErrorStream():connection.getInputStream();
                ByteArrayOutputStream output=new ByteArrayOutputStream();
                if(source!=null)try(InputStream input=source){
                    byte[] buffer=new byte[8192];int read;
                    while((read=input.read(buffer))!=-1){
                        if(output.size()+read>512*1024)throw new Exception("社区响应超过容量保护");
                        output.write(buffer,0,read);
                    }
                }
                result.put("status",status).put("body",output.toString("UTF-8"));
            }catch(Exception error){try{result.put("error","社区连接失败："+error.getMessage());}catch(Exception ignored){}}
            finally{if(connection!=null)connection.disconnect();}
            String payload=result.toString();
            runOnUiThread(()->{if(!isDestroyed()&&web!=null)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gongxingji-http',{detail:"+payload+"}))",null);});
        });
    }
    private void emitPrivateMedia(JSONObject packet,Runnable guard)throws Exception{
        emitNativePacket("gongxingji-media",packet,guard);
    }
    private void emitArchiveExport(String id,String phase,Runnable guard)throws Exception{
        emitNativePacket("gongxingji-archive-export",new JSONObject().put("id",id).put("phase",phase),guard);
    }
    private void openArchivePicker(String id,String name){
        runOnUiThread(()->{
            try{
                if(isDestroyed()||isFinishing()||web==null||archiveExport==null)throw new IOException("归档页面已关闭");
                if(pendingExport!=null||fileCallback!=null||archivePickerId!=null)throw new IOException("请先完成当前文件界面");
                archiveExport.pickerLaunched(id);
                archivePickerId=id;
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/zip").addCategory(Intent.CATEGORY_OPENABLE)
                    .putExtra(Intent.EXTRA_TITLE,name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                startActivityForResult(intent,SAVE_ARCHIVE);
            }catch(Exception error){if(id.equals(archivePickerId))archivePickerId=null;if(archiveExport!=null)archiveExport.fail(id);}
        });
    }
    private void emitNativePacket(String event,JSONObject packet,Runnable guard)throws Exception{
        java.util.concurrent.CountDownLatch delivered=new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Exception> problem=new java.util.concurrent.atomic.AtomicReference<>();
        runOnUiThread(()->{
            try{
                guard.run();if(isDestroyed()||isFinishing()||web==null)throw new IOException("媒体页面已关闭");
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('"+event+"',{detail:"+packet.toString()+"}))",ignored->delivered.countDown());
            }catch(Exception error){problem.set(error);delivered.countDown();}
        });
        if(!delivered.await(5,java.util.concurrent.TimeUnit.SECONDS))throw new IOException("媒体页面未确认接收分块");
        if(problem.get()!=null)throw problem.get();
    }
    final class Bridge {
        @JavascriptInterface public int photoWorkMaxLongEdge(){return nativePhotoInference==null?PhotoInferencePolicy.WORK_MAX_LONG_EDGE:nativePhotoInference.maxLongEdge();}
        @JavascriptInterface public String photoInferenceStart(String id,String png,int width,int height){return nativePhotoInference==null?"{\"ok\":false,\"code\":\"PHOTO_UNAVAILABLE\"}":nativePhotoInference.start(id,png,width,height);}
        @JavascriptInterface public void photoInferenceCancel(String id){if(nativePhotoInference!=null)nativePhotoInference.cancel(id);}
        @JavascriptInterface public void photoInferenceStage(String stage){
            String accepted=photoInference.accept(stage);
            if(accepted!=null&&PhotoInferencePolicy.STAGE_LOGS_ENABLED)android.util.Log.i("GongxingjiPhoto",accepted);
        }
        @JavascriptInterface public String privateMediaFingerprint(String scope,String owner){try{if(!PRIVATE_MEDIA_ENABLED||privateMedia==null)throw new IOException("私有媒体保存尚未开放");return ok(sharedAux.mediaSessionFingerprint(scope,owner));}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String photoContributionFingerprint(String scope,String owner){try{if(!PHOTO_CONTRIBUTION_ENABLED||privateMedia==null)throw new IOException("照片贡献通道尚未开放");return ok(sharedAux.photoContributionFingerprint(scope,owner));}catch(Exception error){return failure(new IOException("照片贡献需核验当前账号"));}}
        @JavascriptInterface public String mediaArchiveFingerprint(String scope,String owner){try{if(!PROTECTED_ARCHIVE_ENABLED||privateMedia==null||archiveExport==null)throw new IOException("媒体归档尚未开放");return ok(sharedAux.mediaSessionFingerprint(scope,owner));}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String mediaArchiveExportBegin(String id,String name,String scope,String owner,String pin,int bytes,String sha256){try{
            if(!PROTECTED_ARCHIVE_ENABLED||archiveExport==null)throw new IOException("媒体归档尚未开放");
            if(pendingExport!=null||fileCallback!=null||archivePickerId!=null)throw new IOException("请先完成当前系统文件界面");
            archiveExport.begin(id,name,scope,owner,pin,bytes,sha256);return ok(null);
        }catch(Exception error){return failure(error);}}
        @JavascriptInterface public String mediaArchiveExportChunk(String id,int sequence,String encoded){try{if(archiveExport==null)throw new IOException("归档通道未就绪");archiveExport.append(id,sequence,encoded);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String mediaArchiveExportFinish(String id){try{if(archiveExport==null)throw new IOException("归档通道未就绪");archiveExport.finish(id);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public void mediaArchiveExportCancel(String id){if(archiveExport!=null)archiveExport.cancel(id);}
        @JavascriptInterface public String privateMediaBegin(String id,String url,String method,String headers,String json,String scope,String owner,String pin,int bytes,String sha256){try{if(privateMedia==null)throw new IOException("此安装包的媒体通道未就绪");privateMedia.begin(id,url,method,headers,json,scope,owner,pin,bytes,sha256);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String privateMediaChunk(String id,int sequence,String encoded){try{if(privateMedia==null)throw new IOException("媒体通道未就绪");privateMedia.append(id,sequence,encoded);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String privateMediaFinish(String id){try{if(privateMedia==null)throw new IOException("媒体通道未就绪");privateMedia.finish(id);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public void privateMediaCancel(String id){if(privateMedia!=null)privateMedia.cancel(id);}
        @JavascriptInterface public void request(String id,String url,String method,String headers,String body){httpRequest(id,url,method,headers,body);}
        @JavascriptInterface public void communityRequest(String id,String url,String method,String headers,String body,String scope,String owner,String sessionFingerprint){httpCommunityRequest(id,url,method,headers,body,scope,owner,sessionFingerprint);}
        @JavascriptInterface public String communitySessionFingerprint(String scope,String owner){if(!SOCIAL_ENABLED)return failure(new Exception("此版本未启用社交功能"));try{return ok(sharedAux.communitySessionFingerprint(scope,owner));}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String read(){try{return ok(store.read());}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String accountVaultRead(){try{return store.accountRead();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String accountVaultWrite(String value,String expectedHash,String legacyHash){try{return new JSONObject().put("ok",true).put("hash",store.accountWrite(value,expectedHash,legacyHash)).toString();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String write(String data,int revision){try{store.write(data,revision);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String cloudMetaRead(){try{return sharedAux.readMetaResult();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String cloudMetaWrite(String value,String expectedHash){try{return new JSONObject(ok(null)).put("hash",sharedAux.writeMeta(value,expectedHash)).toString();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String secureRead(String name){try{return ok(sharedAux.secureRead(name));}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String secureReadResult(String name){try{return sharedAux.secureReadResult(name);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String secureWriteIfCurrent(String name,String value,String expectedHash){try{if(privateMedia!=null)privateMedia.cancelAll();if(archiveExport!=null)archiveExport.cancelAll();return new JSONObject(ok(null)).put("hash",sharedAux.secureWriteIfCurrent(name,value,expectedHash)).toString();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String localIdentityRead(){try{return sharedAux.localIdentityRead().toString();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String localIdentityWrite(String value,String expectedHash){try{return sharedAux.localIdentityWrite(value,expectedHash).toString();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String secureWrite(String name,String value){try{if(privateMedia!=null)privateMedia.cancelAll();if(archiveExport!=null)archiveExport.cancelAll();sharedAux.secureWrite(name,value);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String emailEnrollmentRead(){try{return sharedAux.emailEnrollmentRead();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String emailEnrollmentWrite(String value,String expectedHash){try{return new JSONObject(ok(null)).put("hash",sharedAux.emailEnrollmentWrite(value,expectedHash)).toString();}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String communityPendingRead(String scope,String owner){if(!SOCIAL_ENABLED)return failure(new Exception("此版本未启用社交功能"));try{return ok(sharedAux.communityPendingRead(scope,owner));}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String communityPendingWrite(String scope,String owner,String value){if(!SOCIAL_ENABLED)return failure(new Exception("此版本未启用社交功能"));try{sharedAux.communityPendingWrite(scope,owner,value);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String recoveryRead(){try{return ok(store.recoveryRead());}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String recover(String value,String hash){try{store.recover(value,hash);return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String speakGuide(String text){try{if(text==null||text.trim().isEmpty()||text.length()>500)throw new Exception("语音提示内容无效");runOnUiThread(()->queueSpeech(text));return ok("本机离线语音请求已提交");}catch(Exception error){return failure(error);}}
        @JavascriptInterface public void stopGuide(){runOnUiThread(()->stopSpeechGuide(true));}
        @JavascriptInterface public String setReviewMode(boolean active){try{runOnUiThread(()->applyReviewMode(active));return ok(null);}catch(Exception error){return failure(error);}}
        @JavascriptInterface public String capabilities(){return "{\"localPersistence\":true,\"filePicker\":true,\"export\":true,\"share\":true,\"camera\":true,\"speechGuide\":\"local-only\",\"landscapeReview\":true,\"backgroundReminder\":false}";}
        @JavascriptInterface public String exportFile(String name,String content,String mime,boolean share){
            try {
                if(content.getBytes(StandardCharsets.UTF_8).length>28*1024*1024)throw new Exception("导出文件超过28MB");
                if(!mime.equals("application/json")&&!mime.equals("text/plain")&&!mime.equals("text/csv")&&!mime.equals("image/svg+xml")&&!mime.equals("image/png"))throw new Exception("不支持此导出类型");
                final byte[] bytes=mime.equals("image/png")?GalleryReport.decode(content):content.getBytes(StandardCharsets.UTF_8);
                String safe=name.replaceAll("[^a-zA-Z0-9._-]","_");
                if(safe.length()>100)safe=safe.substring(0,100);
                final String filename=mime.equals("image/png")&&!safe.endsWith(".png")?safe+".png":safe;
                if(mime.equals("image/png")&&!share&&android.os.Build.VERSION.SDK_INT>=29){
                    if(!gallerySaving.compareAndSet(false,true))throw new IOException("图片正在保存，请稍候");
                    try {reportWriter.execute(()->{try{GalleryReport.save(getApplicationContext(),filename,bytes);notifyUser("图片已保存到相册 · Gongxingji");}catch(Exception error){notifyUser("相册保存失败，请重试或使用系统分享；训练记录保留");}finally{gallerySaving.set(false);}});}catch(Exception error){gallerySaving.set(false);throw error;}
                    return ok("正在保存图片到相册");
                }
                if(share){prepareReportShare(filename,mime,bytes);return ok("正在准备系统分享");}
                runOnUiThread(()->{
                    try {
                        if(isDestroyed()||isFinishing()||web==null)return;
                            if(pendingExport!=null||fileCallback!=null||archivePickerId!=null||(archiveExport!=null&&archiveExport.busy())){notifyUser("请先完成或取消上一次文件界面");return;}
                            pendingExport=bytes;
                            if(mime.equals("image/png"))notifyUser("此Android版本使用文件保存，请选择图片位置");
                            Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,filename)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                            startActivityForResult(intent,SAVE_FILE);
                    }catch(Exception error){pendingExport=null;notifyUser("导出未完成："+error.getMessage());}
                });
                return ok("系统文件界面已请求打开");
            }catch(Exception error){return failure(error);}
        }
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==PICK_FILE&&fileCallback!=null){
            ValueCallback<Uri[]> pending=fileCallback;fileCallback=null;
            Uri[] picked=null;
            try{
                picked=WebChromeClient.FileChooserParams.parseResult(result,data);
                if(picked!=null)for(Uri uri:picked){
                    if(uri==null||!FileChooserPolicy.safeContentUri(uri.toString(),getPackageName())
                        ||checkUriPermission(uri,android.os.Process.myPid(),android.os.Process.myUid(),Intent.FLAG_GRANT_READ_URI_PERMISSION)!=PackageManager.PERMISSION_GRANTED)
                        throw new SecurityException("FILE_SELECTION_REJECTED");
                }
            }catch(Exception error){picked=null;notifyUser("无法读取所选文件，请从系统相册或文件中重新选择");}
            pending.onReceiveValue(picked);
        }
        if(request==CAPTURE_PHOTO){
            boolean valid=result==RESULT_OK&&capturedPhoto!=null&&capturedPhoto.length()>0&&capturedPhoto.length()<=100*1024*1024;
            if(capturedUri!=null)revokeUriPermission(capturedUri,Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if(fileCallback!=null){fileCallback.onReceiveValue(valid?new Uri[]{capturedUri}:null);fileCallback=null;}
            if(!valid)clearCapturedPhoto();
        }
        if(request==SAVE_ARCHIVE){
            String id=archivePickerId;archivePickerId=null;
            if(id==null||archiveExport==null)return;
            if(result!=RESULT_OK||data==null||data.getData()==null){archiveExport.cancel(id);return;}
            final Uri target=data.getData();
            archiveExport.selected(id,()->getContentResolver().openOutputStream(target,"wt"));
            return;
        }
        if(request==SAVE_FILE){
            byte[] content=pendingExport;pendingExport=null;
            if(result!=RESULT_OK||data==null||data.getData()==null){notifyUser("已取消文件保存；本机训练记录保留");return;}
            if(content==null){notifyUser("文件导出被系统回收中断，请重新导出；原记录保留");return;}
            try {try(OutputStream output=getContentResolver().openOutputStream(data.getData(),"wt")){if(output==null)throw new IOException("无法打开目标位置");output.write(content);output.flush();}notifyUser("文件已保存到所选位置");}
            catch(SecurityException error){android.util.Log.w("GongxingjiExport","Document write permission denied; resultFlags="+data.getFlags());notifyUser("所选位置未授予写入权限，请改选“内部存储 / Documents”重新导出；本机原记录保留");}
            catch(Exception error){android.util.Log.w("GongxingjiExport","Document save failed: "+error.getClass().getSimpleName());notifyUser("文件保存失败，请更换保存位置后重新导出；本机原记录保留");}
        }
    }
    // API 26 is the APK minimum. All callbacks and WebView updates use its UI thread.
    private void startNetworkObserver(){
        connectivity=getSystemService(ConnectivityManager.class);
        if(connectivity==null){applyNetworkAvailability(false);return;}
        defaultNetworkCallback=new ConnectivityManager.NetworkCallback(){
            private boolean current(){return !networkObserverStopped&&defaultNetworkCallback==this;}
            @Override public void onAvailable(Network network){
                if(current())defaultNetwork=network;
                // Wait for the supplied capabilities rather than querying from a callback.
            }
            @Override public void onCapabilitiesChanged(Network network,NetworkCapabilities capabilities){
                if(current()&&network.equals(defaultNetwork))
                    applyNetworkAvailability(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
            }
            @Override public void onLost(Network network){
                if(current()&&network.equals(defaultNetwork)){
                    defaultNetwork=null;
                    applyNetworkAvailability(false);
                }
            }
        };
        try{
            connectivity.registerDefaultNetworkCallback(defaultNetworkCallback,new android.os.Handler(getMainLooper()));
            refreshNetworkAvailability();
        }catch(RuntimeException unavailable){
            stopNetworkObserver();
            networkObserverStopped=false;
            applyNetworkAvailability(false);
        }
    }
    // Initial/resume snapshots run outside callbacks; capabilities are not proof of HTTP success.
    private void refreshNetworkAvailability(){
        if(networkObserverStopped)return;
        try{
            defaultNetwork=connectivity==null?null:connectivity.getActiveNetwork();
            NetworkCapabilities capabilities=defaultNetwork==null?null:connectivity.getNetworkCapabilities(defaultNetwork);
            applyNetworkAvailability(capabilities!=null&&capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET));
        }catch(RuntimeException unavailable){defaultNetwork=null;applyNetworkAvailability(false);}
    }
    private void applyNetworkAvailability(boolean available){
        if(networkObserverStopped||web==null||isDestroyed()||isFinishing())return;
        if(reportedNetworkAvailable!=null&&reportedNetworkAvailable.booleanValue()==available)return;
        web.setNetworkAvailable(available);
        reportedNetworkAvailable=available;
    }
    private void stopNetworkObserver(){
        // Invalidate queued callbacks before unregistering or destroying the renderer.
        networkObserverStopped=true;
        ConnectivityManager previous=connectivity;
        ConnectivityManager.NetworkCallback callback=defaultNetworkCallback;
        defaultNetworkCallback=null;defaultNetwork=null;connectivity=null;
        if(previous!=null&&callback!=null)try{previous.unregisterNetworkCallback(callback);}catch(RuntimeException ignored){}
    }
    @Override public void onBackPressed(){if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('gongxingji-back'))",null);else super.onBackPressed();}
    @Override protected void onPause(){if(privateMedia!=null)privateMedia.cancelAll();if(archiveExport!=null)archiveExport.background();stopSpeechGuide(false);if(web!=null){web.evaluateJavascript("window.dispatchEvent(new Event('gongxingji-background'))",null);web.onPause();}super.onPause();}
    @Override protected void onResume(){super.onResume();if(web!=null){web.onResume();refreshNetworkAvailability();web.evaluateJavascript("window.dispatchEvent(new Event('gongxingji-foreground'))",null);}}
    @Override protected void onDestroy(){photoPageEpoch++;if(nativePhotoInference!=null)nativePhotoInference.close();stopNetworkObserver();if(privateMedia!=null)privateMedia.close();if(archiveExport!=null)archiveExport.close();archiveWriter.shutdown();mediaNetwork.shutdownNow();phoneOtpNetwork.close();network.shutdownNow();reportWriter.shutdown();stopSpeechGuide(false);if(speech!=null){speech.shutdown();speech=null;}if(cameraRequest!=null){cameraRequest.deny();cameraRequest=null;}if(fileCallback!=null)fileCallback.onReceiveValue(null);if(web!=null){web.removeJavascriptInterface("Gongxingji");web.destroy();web=null;}clearCapturedPhoto();super.onDestroy();}
}
