package app.gongxingji.training.offline;

import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String HOST = "offline.gongxingji.invalid";
    private static final String ENTRY = "mobile.html";
    private static final String START_URL = "https://" + HOST + "/" + ENTRY;
    private static final Pattern ASSET_PATH = Pattern.compile("[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*");
    private static final String CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
            + "media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; "
            + "base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";

    private FrameLayout content;
    private WebView web;

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
        web.loadUrl(START_URL);
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
            return !request.isForMainFrame() || !"GET".equals(request.getMethod())
                    || !ENTRY.equals(packagedPath(request.getUrl()));
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
        if (web != null) {
            content.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
