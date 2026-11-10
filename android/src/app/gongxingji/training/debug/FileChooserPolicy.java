package app.gongxingji.training.debug;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Locale;

/** Normalize existing HTML inputs without widening them to an unfiltered picker. */
final class FileChooserPolicy {
    private final String[] types;

    private FileChooserPolicy(LinkedHashSet<String> accepted) {
        types=accepted.toArray(new String[0]);
    }

    static FileChooserPolicy fromAcceptTypes(String[] supplied) {
        LinkedHashSet<String> accepted=new LinkedHashSet<>();
        if(supplied!=null)for(String entry:supplied){
            if(entry==null)continue;
            for(String value:entry.split(",")){
                String type=value.trim().toLowerCase(Locale.ROOT);
                switch(type){
                    case ".jpg": case ".jpeg": case "image/jpg": type="image/jpeg";break;
                    case ".png": type="image/png";break;
                    case ".webp": type="image/webp";break;
                    case ".json": type="application/json";break;
                    case ".zip": case "application/x-zip-compressed": type="application/zip";break;
                    case ".mp4": type="video/mp4";break;
                    default:break;
                }
                // The photo decoder supports these three formats, even if a WebView
                // reports a broad image wildcard. Existing video notes retain video/*.
                if("image/*".equals(type)){
                    accepted.add("image/jpeg");accepted.add("image/png");accepted.add("image/webp");
                }else if("image/jpeg".equals(type)||"image/png".equals(type)||"image/webp".equals(type)
                        ||"application/json".equals(type)||"application/zip".equals(type)
                        ||"video/mp4".equals(type)||"video/*".equals(type))accepted.add(type);
            }
        }
        return new FileChooserPolicy(accepted);
    }

    boolean allowed(){return types.length>0;}
    boolean hasImages(){for(String type:types)if(type.startsWith("image/"))return true;return false;}
    String[] mimeTypes(){return types.clone();}
    String primaryType(){
        if(!allowed())throw new IllegalStateException("FILE_TYPE_UNSUPPORTED");
        if(types.length==1)return types[0];
        String family=types[0].substring(0,types[0].indexOf('/'));
        for(String type:types)if(!type.startsWith(family+"/"))return "*/*";
        return family+"/*";
    }

    // FileChooserParams.parseResult does not validate third-party results. Only
    // granted content URIs may reach WebView; never file/network or our providers.
    static boolean safeContentUri(String value,String packageName){
        if(value==null||packageName==null)return false;
        try{
            URI uri=new URI(value);
            String authority=uri.getRawAuthority();
            if(!"content".equals(uri.getScheme())||authority==null||authority.isEmpty()||authority.indexOf('%')>=0
                    ||uri.getRawUserInfo()!=null||uri.getRawFragment()!=null)return false;
            authority=authority.toLowerCase(Locale.ROOT);
            String own=packageName.toLowerCase(Locale.ROOT);
            if(authority.equals(own)||authority.startsWith(own+".")
                    ||authority.equals("app.gongxingji.training")
                    ||authority.startsWith("app.gongxingji.training."))return false;
            String decoded=uri.getPath();
            if(decoded==null||decoded.isEmpty())return false;
            for(String segment:decoded.split("/"))if("..".equals(segment)||".".equals(segment))return false;
            return true;
        }catch(Exception error){return false;}
    }
}
