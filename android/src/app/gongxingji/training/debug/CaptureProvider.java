package app.gongxingji.training.debug;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Only the explicitly granted, newly created temporary camera image is writable. */
public final class CaptureProvider extends ContentProvider {
    public boolean onCreate(){return true;}
    private File file(Uri uri)throws FileNotFoundException{
        String name=uri.getLastPathSegment();
        if(uri.getPathSegments().size()!=1||name==null||!name.matches("capture-[0-9a-f-]{36}\\.jpg"))throw new FileNotFoundException();
        File file=new File(new File(getContext().getCacheDir(),"camera"),name);
        if(!file.isFile())throw new FileNotFoundException();return file;
    }
    public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
        int flags;
        if("r".equals(mode))flags=ParcelFileDescriptor.MODE_READ_ONLY;
        else if("w".equals(mode)||"wt".equals(mode))flags=ParcelFileDescriptor.MODE_WRITE_ONLY|ParcelFileDescriptor.MODE_TRUNCATE;
        else if("rw".equals(mode))flags=ParcelFileDescriptor.MODE_READ_WRITE;
        else if("rwt".equals(mode))flags=ParcelFileDescriptor.MODE_READ_WRITE|ParcelFileDescriptor.MODE_TRUNCATE;
        else throw new FileNotFoundException();
        return ParcelFileDescriptor.open(file(uri),flags);
    }
    public String getType(Uri uri){return "image/jpeg";}
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){try{File file=file(uri);MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{file.getName(),file.length()});return c;}catch(Exception error){return null;}}
    public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    public int update(Uri uri,ContentValues values,String selection,String[] args){throw new UnsupportedOperationException();}
    public int delete(Uri uri,String selection,String[] args){throw new UnsupportedOperationException();}
}
