package app.gongxingji.training.debug;

import android.content.ContentValues;
import android.content.Context;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.IOException;
import java.io.OutputStream;

/** Only app-generated PNG reports; never reads another app's media or needs library access. */
final class GalleryReport {
    static byte[] decode(String content) throws IOException {
        final String prefix="data:image/png;base64,";
        if(content==null||content.length()>28*1024*1024||!content.startsWith(prefix))throw new IOException("图片格式或大小无效");
        byte[] bytes;
        try {bytes=Base64.decode(content.substring(prefix.length()),Base64.DEFAULT);} catch(IllegalArgumentException error){throw new IOException("图片内容无效");}
        byte[] signature={(byte)137,80,78,71,13,10,26,10};
        if(bytes.length<24||bytes.length>21*1024*1024)throw new IOException("图片超过保存上限");
        for(int i=0;i<signature.length;i++)if(bytes[i]!=signature[i])throw new IOException("图片不是PNG");
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;
        BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
        if(options.outWidth<1||options.outHeight<1||options.outWidth>4096||options.outHeight>32000||(long)options.outWidth*options.outHeight>24000000)throw new IOException("图片过长，请减少分享内容");
        return bytes;
    }
    static void save(Context context,String filename,byte[] bytes) throws IOException {
        if(android.os.Build.VERSION.SDK_INT<29)throw new IOException("旧系统请使用文件保存");
        ContentValues values=new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME,System.currentTimeMillis()+"-"+filename);
        values.put(MediaStore.Images.Media.MIME_TYPE,"image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH,"Pictures/Gongxingji");
        values.put(MediaStore.Images.Media.IS_PENDING,1);
        Uri uri=context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,values);
        if(uri==null)throw new IOException("相册暂不可用");
        boolean published=false;
        try {
            try(OutputStream output=context.getContentResolver().openOutputStream(uri,"w")) {
                if(output==null)throw new IOException("无法写入相册");
                output.write(bytes);output.flush();
            }
            ContentValues ready=new ContentValues();ready.put(MediaStore.Images.Media.IS_PENDING,0);
            if(context.getContentResolver().update(uri,ready,null,null)!=1)throw new IOException("相册图片未完成发布");
            published=true;
        } finally {
            // This URI was just created by this call, not an existing user photo.
            if(!published)context.getContentResolver().delete(uri,null,null);
        }
    }
}
