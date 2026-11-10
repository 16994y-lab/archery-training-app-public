package app.gongxingji.training.debug;

import java.net.URI;

/** Narrow compatibility for the reviewed WebView 96 and the packaged photo worker. */
final class OfflinePhotoPolicy {
    static final String DEFAULT = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: content: https://www.frontiersin.org https://journals.plos.org; media-src 'self' blob: content:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
    // WebView 96 predates wasm-unsafe-eval. This necessarily permits JS eval too,
    // but only in this self-hosted worker; it never changes the document policy.
    static final String LEGACY_WORKER = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    private final String workerPath;
    private OfflinePhotoPolicy(String path) { workerPath=path; }
    static OfflinePhotoPolicy strict() { return new OfflinePhotoPolicy(null); }
    static OfflinePhotoPolicy create(String providerVersion,String[] packagedAssets) {
        if(providerVersion==null || !providerVersion.matches("96\\.[0-9]+\\.[0-9]+\\.[0-9]+") || packagedAssets==null) return strict();
        String found=null;
        for(String name:packagedAssets) {
            if(name!=null && name.matches("inference\\.worker-[A-Za-z0-9_-]{8,64}\\.js")) {
                if(found!=null) return strict();
                found="/assets/"+name;
            }
        }
        return new OfflinePhotoPolicy(found);
    }
    String forRequest(String rawUrl,boolean mainFrame) {
        if(workerPath==null || mainFrame || rawUrl==null) return DEFAULT;
        try {
            URI uri=new URI(rawUrl);
            if("https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
                && uri.getRawUserInfo()==null && uri.getPort()==-1 && uri.getRawQuery()==null && uri.getRawFragment()==null
                && workerPath.equals(uri.getRawPath())) return LEGACY_WORKER;
        } catch(Exception ignored) { }
        return DEFAULT;
    }
}
