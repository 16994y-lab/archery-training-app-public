package app.gongxingji.training.offline;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String HOST = "offline.gongxingji.invalid";
    private static final String ENTRY = "mobile.html";
    private static final String START_URL = "https://" + HOST + "/" + ENTRY;
    private static final Pattern ASSET_PATH = Pattern.compile("[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*");
    private static final Pattern EXPORT_ID = Pattern.compile("[a-f0-9]{32}");
    private static final Pattern EXPORT_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    private static final int CREATE_DOCUMENT = 71;
    private static final int PICK_PHOTO = 72;
    private static final String[] PHOTO_TYPES = { "image/jpeg", "image/png", "image/webp" };
    private static final int MAX_TEXT_BYTES = 24 * 1024 * 1024;
    private static final int MAX_PNG_BYTES = 21 * 1024 * 1024;
    private static final String PNG_PREFIX = "data:image/png;base64,";
    private static final String CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
            + "media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; "
            + "base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";

    private FrameLayout content;
    private WebView web;
    private PendingExport pendingExport;
    private ValueCallback<Uri[]> photoPicker;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        content = new FrameLayout(this);
        web = new WebView(this);
        content.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(content);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            content.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                    Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                            | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                    view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                    return insets;
                }
            });
            content.requestApplyInsets();
        }

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web.setWebViewClient(new LocalContent());
        web.setWebChromeClient(new PhotoChooser());
        web.addJavascriptInterface(new OfflineFiles(), "GongxingjiOfflineFiles");
        web.loadUrl(START_URL);
    }

    private static final class PendingExport {
        final String id;
        final String name;
        final String mime;
        final String content;

        PendingExport(String id, String name, String mime, String content) {
            this.id = id;
            this.name = name;
            this.mime = mime;
            this.content = content;
        }

        byte[] bytes() throws IOException {
            if (!"image/png".equals(mime)) {
                byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_TEXT_BYTES) throw new IOException("Text export exceeds limit");
                return bytes;
            }
            byte[] bytes = Base64.decode(content.substring(PNG_PREFIX.length()), Base64.NO_WRAP);
            if (bytes.length < 8 || bytes.length > MAX_PNG_BYTES
                    || bytes[0] != (byte) 0x89 || bytes[1] != 'P' || bytes[2] != 'N' || bytes[3] != 'G'
                    || bytes[4] != 13 || bytes[5] != 10 || bytes[6] != 26 || bytes[7] != 10) {
                throw new IOException("Invalid PNG export");
            }
            return bytes;
        }
    }

    private final class OfflineFiles {
        @JavascriptInterface
        public String saveFile(String id, String name, String mime, String content) {
            if (id == null || !EXPORT_ID.matcher(id).matches() || name == null
                    || !EXPORT_NAME.matcher(name).matches() || content == null || content.isEmpty()) {
                return "invalid";
            }
            if ("image/png".equals(mime)) {
                if (!name.endsWith(".png") || !content.startsWith(PNG_PREFIX)
                        || content.length() > PNG_PREFIX.length() + 4 * ((MAX_PNG_BYTES + 2) / 3)) return "invalid";
            } else if (!("text/csv".equals(mime) && name.endsWith(".csv"))
                    && !("application/json".equals(mime) && name.endsWith(".json"))) {
                return "invalid";
            } else if (content.length() > MAX_TEXT_BYTES) {
                return "invalid";
            }

            PendingExport request = new PendingExport(id, name, mime, content);
            synchronized (MainActivity.this) {
                if (pendingExport != null) return "busy";
                pendingExport = request;
            }
            runOnUiThread(new Runnable() {
                @Override public void run() { openSavePicker(request); }
            });
            return "accepted";
        }
    }

    private void openSavePicker(PendingExport request) {
        String url = web == null ? null : web.getUrl();
        if (url == null || !ENTRY.equals(packagedPath(Uri.parse(url))) || isFinishing() || photoPicker != null) {
            finishSave(request, "failed");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(request.mime)
                .putExtra(Intent.EXTRA_TITLE, request.name)
                .putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        try {
            startActivityForResult(intent, CREATE_DOCUMENT);
        } catch (RuntimeException unavailable) {
            finishSave(request, "failed");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_PHOTO) {
            ValueCallback<Uri[]> callback = photoPicker;
            photoPicker = null;
            if (callback != null) callback.onReceiveValue(resultCode == RESULT_OK ? selectedPhoto(data) : null);
            return;
        }
        if (requestCode != CREATE_DOCUMENT) return;
        PendingExport request;
        synchronized (this) {
            request = pendingExport;
        }
        if (request == null) return;
        if (resultCode != RESULT_OK) {
            finishSave(request, "cancelled");
            return;
        }
        Uri destination = data == null ? null : data.getData();
        if (!isGrantedDocument(destination, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) {
            finishSave(request, "failed");
            return;
        }
        new Thread(new Runnable() {
            @Override public void run() {
                String status = "failed";
                try {
                    byte[] bytes = request.bytes();
                    try (OutputStream stream = getContentResolver().openOutputStream(destination, "w")) {
                        if (stream == null) throw new IOException("Document provider did not open output");
                        stream.write(bytes);
                    }
                    status = "saved";
                } catch (IOException | RuntimeException failure) {
                    // The caller reports failure. Existing training data is untouched.
                }
                finishSave(request, status);
            }
        }, "offline-file-save").start();
    }

    private void finishSave(PendingExport request, String status) {
        synchronized (this) {
            if (pendingExport != request) return;
            pendingExport = null;
        }
        String event = "window.dispatchEvent(new CustomEvent('gongxingji-offline-file-save',{detail:{id:"
                + JSONObject.quote(request.id) + ",status:" + JSONObject.quote(status) + "}}));";
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript(event, null);
            }
        });
    }

    private final class PhotoChooser extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            Set<String> accepted = new HashSet<>();
            for (String entry : params.getAcceptTypes()) {
                for (String mime : entry.split(",")) {
                    if (!mime.trim().isEmpty()) accepted.add(mime.trim().toLowerCase(Locale.ROOT));
                }
            }
            boolean saving;
            synchronized (MainActivity.this) {
                saving = pendingExport != null;
            }
            String url = view.getUrl();
            if (saving || photoPicker != null || url == null || !ENTRY.equals(packagedPath(Uri.parse(url)))
                    || params.isCaptureEnabled() || params.getMode() != FileChooserParams.MODE_OPEN
                    || !accepted.equals(new HashSet<>(Arrays.asList(PHOTO_TYPES)))) {
                callback.onReceiveValue(null);
                return true;
            }
            photoPicker = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("image/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, PHOTO_TYPES)
                    .putExtra(Intent.EXTRA_LOCAL_ONLY, true)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                startActivityForResult(intent, PICK_PHOTO);
            } catch (RuntimeException unavailable) {
                photoPicker = null;
                callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, "无法打开本机照片选择器", Toast.LENGTH_SHORT).show();
            }
            return true;
        }
    }

    private Uri[] selectedPhoto(Intent data) {
        Uri uri = data == null ? null : data.getData();
        try {
            if (isGrantedDocument(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    && Arrays.asList(PHOTO_TYPES).contains(getContentResolver().getType(uri))) {
                return new Uri[] { uri };
            }
        } catch (RuntimeException unavailable) {
            // A rejected picker result is never passed to WebView.
        }
        Toast.makeText(this, "请选择可读取的本机 JPEG、PNG 或 WebP 照片", Toast.LENGTH_SHORT).show();
        return null;
    }

    private boolean isGrantedDocument(Uri uri, int permission) {
        try {
            return uri != null && "content".equals(uri.getScheme())
                    && DocumentsContract.isDocumentUri(this, uri)
                    && checkUriPermission(uri, Process.myPid(), Process.myUid(), permission)
                            == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    private static String packagedPath(Uri uri) {
        if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getEncodedAuthority())
                || uri.getEncodedQuery() != null) return null;
        String path = uri.getEncodedPath();
        if (path == null || !path.startsWith("/") || !ASSET_PATH.matcher(path.substring(1)).matches()) return null;
        return path.substring(1);
    }

    private final class LocalContent extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame() || !"GET".equals(request.getMethod())) return true;
            Uri url = request.getUrl();
            if (ENTRY.equals(packagedPath(url))) return false;
            String host = url.getHost();
            if (request.hasGesture() && !request.isRedirect() && "https".equals(url.getScheme())
                    && host != null && !host.isEmpty() && !HOST.equalsIgnoreCase(host)
                    && url.getUserInfo() == null) {
                Intent browser = new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE);
                browser.setSelector(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_BROWSER));
                try {
                    startActivity(browser);
                } catch (ActivityNotFoundException | SecurityException unavailable) {
                    Toast.makeText(MainActivity.this, "无法打开系统浏览器", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String path = packagedPath(request.getUrl());
            if (path == null || !"GET".equals(request.getMethod())) return blocked(403, "Forbidden");
            String type = mimeType(path);
            if (type == null || (request.isForMainFrame() && !ENTRY.equals(path))) return blocked(404, "Not Found");

            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Referrer-Policy", "no-referrer");
            if (ENTRY.equals(path)) headers.put("Content-Security-Policy", CSP);
            String charset = type.startsWith("text/") || type.endsWith("json") ? "UTF-8" : null;
            try {
                return new WebResourceResponse(type, charset, 200, "OK", headers, getAssets().open("www/" + path));
            } catch (IOException missing) {
                return blocked(404, "Not Found");
            }
        }
    }

    private static WebResourceResponse blocked(int status, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", status, reason,
                Collections.singletonMap("Cache-Control", "no-store"),
                new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    private static String mimeType(String path) {
        int extension = path.lastIndexOf('.');
        if (extension < 0) return null;
        switch (path.substring(extension + 1)) {
            case "html": return ENTRY.equals(path) ? "text/html" : null;
            case "js":
            case "mjs": return "text/javascript";
            case "css": return "text/css";
            case "json": return "application/json";
            case "webmanifest": return "application/manifest+json";
            case "svg": return "image/svg+xml";
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "ico": return "image/x-icon";
            case "woff": return "font/woff";
            case "woff2": return "font/woff2";
            case "ttf": return "font/ttf";
            case "otf": return "font/otf";
            default: return null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (photoPicker != null) {
            photoPicker.onReceiveValue(null);
            photoPicker = null;
        }
        if (web != null) {
            content.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
