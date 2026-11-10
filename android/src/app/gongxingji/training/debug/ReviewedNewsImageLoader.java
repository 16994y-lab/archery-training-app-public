package app.gongxingji.training.debug;
import android.graphics.BitmapFactory;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
/** Fixed public images only. One exact PLOS storage object redirect; no forwarded credentials or disk cache. */
public final class ReviewedNewsImageLoader {
 public static WebResourceResponse load(String url,String method)throws IOException {
  if(!ReviewedNewsImagePolicy.allowed(url,method))throw new IOException("Image not reviewed");
  HttpsURLConnection connection=(HttpsURLConnection)new URL(url).openConnection();
  try {
   connection.setRequestMethod("GET");connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
   connection.setConnectTimeout(6000);connection.setReadTimeout(6000);connection.setRequestProperty("Accept","image/webp,image/png,image/jpeg");
   int status=connection.getResponseCode();
   if(status==301||status==302||status==303||status==307||status==308){
    String location=connection.getHeaderField("Location");
    if(!ReviewedNewsImagePolicy.allowedRedirect(url,location))throw new IOException("Unreviewed image redirect");
    connection.disconnect();connection=(HttpsURLConnection)new URL(location).openConnection();
    connection.setRequestMethod("GET");connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
    connection.setConnectTimeout(6000);connection.setReadTimeout(6000);connection.setRequestProperty("Accept","image/png");
   }
   if(connection.getResponseCode()!=200)throw new IOException("Image unavailable");
   String mime=connection.getContentType();mime=mime==null?"":mime.split(";")[0].trim().toLowerCase(Locale.ROOT);
   if(!mime.equals("image/webp")&&!mime.equals("image/png")&&!mime.equals("image/jpeg"))throw new IOException("Invalid image type");
   if(connection.getContentLengthLong()>ReviewedNewsImagePolicy.MAX_BYTES)throw new IOException("Image too large");
   ByteArrayOutputStream output=new ByteArrayOutputStream();
   try(InputStream input=connection.getInputStream()) {byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1){if(output.size()+count>ReviewedNewsImagePolicy.MAX_BYTES)throw new IOException("Image too large");output.write(buffer,0,count);}}
   byte[] bytes=output.toByteArray();if(!ReviewedNewsImagePolicy.validPayload(mime,bytes))throw new IOException("Invalid image bytes");
   BitmapFactory.Options size=new BitmapFactory.Options();size.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,size);
   if(size.outWidth<1||size.outHeight<1||size.outWidth>4096||size.outHeight>4096||(long)size.outWidth*size.outHeight>12000000)throw new IOException("Invalid image dimensions");
   Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("Access-Control-Allow-Origin","*");
   return new WebResourceResponse(mime,null,200,"OK",Collections.unmodifiableMap(headers),new ByteArrayInputStream(bytes));
  } finally {connection.disconnect();}
 }
 private ReviewedNewsImageLoader(){}
}
