package app.gongxingji.training.debug;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.net.URI;
public final class ReviewedNewsImagePolicy {
 public static final int MAX_BYTES=600000;
 private static final Set<String> URLS=Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
  "https://www.frontiersin.org/files/Articles/1650300/xml-images/fspor-07-1650300-g001.webp",
  "https://www.frontiersin.org/files/Articles/1880932/xml-images/fphys-17-1880932-g001.webp",
  "https://journals.plos.org/plosone/article/figure/image?id=10.1371%2Fjournal.pone.0285223.g001&size=inline"
 )));
 public static boolean allowed(String url,String method){return "GET".equals(method)&&URLS.contains(url);}
 public static boolean allowedRedirect(String original,String target){
  if(!"https://journals.plos.org/plosone/article/figure/image?id=10.1371%2Fjournal.pone.0285223.g001&size=inline".equals(original)||target==null)return false;
  try {URI uri=new URI(target);return "https".equals(uri.getScheme())&&"storage.googleapis.com".equals(uri.getHost())&&uri.getPort()==-1&&uri.getRawUserInfo()==null&&uri.getRawFragment()==null&&"/plos-corpus-prod/10.1371/journal.pone.0285223/1/pone.0285223.g001.PNG_I".equals(uri.getRawPath());}
  catch(Exception invalid){return false;}
 }
 public static boolean allowedBrowserLink(String url){
  return "https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2026.1880932/full".equals(url)
   ||"https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2025.1650300/full".equals(url)
   ||"https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0285223".equals(url)
   ||"https://creativecommons.org/licenses/by/4.0/".equals(url);
 }
 public static boolean validPayload(String mime,byte[] bytes){
  if(bytes==null||bytes.length<12||bytes.length>MAX_BYTES)return false;
  if("image/webp".equals(mime))return bytes[0]=='R'&&bytes[1]=='I'&&bytes[2]=='F'&&bytes[3]=='F'&&bytes[8]=='W'&&bytes[9]=='E'&&bytes[10]=='B'&&bytes[11]=='P';
  if("image/png".equals(mime))return (bytes[0]&255)==137&&bytes[1]==80&&bytes[2]==78&&bytes[3]==71&&bytes[4]==13&&bytes[5]==10&&bytes[6]==26&&bytes[7]==10;
  return "image/jpeg".equals(mime)&&(bytes[0]&255)==255&&(bytes[1]&255)==216&&(bytes[2]&255)==255;
 }
 private ReviewedNewsImagePolicy(){}
}
