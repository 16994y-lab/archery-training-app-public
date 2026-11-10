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
public final class ReportProvider extends ContentProvider {
    public boolean onCreate(){return true;}
    private File file(Uri uri) throws FileNotFoundException {
        String name=uri.getLastPathSegment();
        if(name==null||!name.matches("[a-zA-Z0-9._-]+")||name.contains(".."))throw new FileNotFoundException();
        File file=new File(new File(getContext().getCacheDir(),"reports"),name);
        if(!file.isFile())throw new FileNotFoundException();return file;
    }
    public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException();return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.MODE_READ_ONLY);}
    public String getType(Uri uri){return uri.toString().endsWith(".png")?"image/png":uri.toString().endsWith(".svg")?"image/svg+xml":uri.toString().endsWith(".json")?"application/json":uri.toString().endsWith(".csv")?"text/csv":"text/plain";}
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort){try{File file=file(uri);MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{file.getName(),file.length()});return c;}catch(Exception error){return null;}}
    public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}
    public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
    public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}
}
