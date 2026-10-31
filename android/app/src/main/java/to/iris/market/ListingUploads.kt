package to.iris.market

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import java.io.ByteArrayOutputStream

internal data class PreparedListingFile(val data:ByteArray,val name:String,val mime:String)
internal data class ListingMediaUpload(val url:String,val fileLink:String,val name:String,val isImage:Boolean) {
    companion object {fun parse(raw:String):ListingMediaUpload {val json=JSONObject(raw);return ListingMediaUpload(json.getString("url"),json.getString("fileLink"),json.getString("name"),json.getBoolean("isImage"))}}
}
internal fun prepareListingFile(context:Context,uri:Uri):PreparedListingFile {
    val resolver=context.contentResolver
    val bytes=resolver.openInputStream(uri)?.use { input ->
        val output=ByteArrayOutputStream();val buffer=ByteArray(16384)
        while(true){val count=input.read(buffer);if(count<0)break;require(output.size()+count<=8*1024*1024);output.write(buffer,0,count)}
        output.toByteArray()
    } ?: error("File unavailable")
    require(bytes.isNotEmpty())
    val name=resolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use {if(it.moveToFirst())it.getString(0) else null} ?: "file"
    val mime=resolver.getType(uri) ?: "application/octet-stream"
    if(!mime.startsWith("image/"))return PreparedListingFile(bytes,name,mime)
    val bounds=BitmapFactory.Options().apply {inJustDecodeBounds=true}
    BitmapFactory.decodeByteArray(bytes,0,bytes.size,bounds)
    require(bounds.outWidth>0&&bounds.outHeight>0&&bounds.outWidth.toLong()*bounds.outHeight<=48_000_000)
    var sample=1;while(maxOf(bounds.outWidth,bounds.outHeight)/sample>5120)sample*=2
    val decoded=BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply {inSampleSize=sample}) ?: error("Photo unavailable")
    val transform=Matrix()
    val orientation=runCatching {ExifInterface(bytes.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL)}.getOrDefault(1)
    when(orientation){2->transform.setScale(-1f,1f);3->transform.setRotate(180f);4->transform.setScale(1f,-1f);5->{transform.setRotate(90f);transform.postScale(-1f,1f)};6->transform.setRotate(90f);7->{transform.setRotate(270f);transform.postScale(-1f,1f)};8->transform.setRotate(270f)}
    val scale=minOf(1f,2560f/maxOf(decoded.width,decoded.height));transform.postScale(scale,scale)
    val prepared=Bitmap.createBitmap(decoded,0,0,decoded.width,decoded.height,transform,true)
    try {
        val output=ByteArrayOutputStream();check(prepared.compress(Bitmap.CompressFormat.JPEG,90,output));require(output.size()<=8*1024*1024)
        return PreparedListingFile(output.toByteArray(),name.substringBeforeLast('.',name)+".jpg","image/jpeg")
    } finally {if(prepared!==decoded)prepared.recycle();decoded.recycle()}
}
@Composable internal fun ListingUploadButton(model:MarketModel,enabled:Boolean,setBusy:(Boolean)->Unit,onUpload:(ListingMediaUpload)->Unit) {
    val context=LocalContext.current;val scope=rememberCoroutineScope()
    val state by model.state.collectAsState()
    var uploading by remember {mutableStateOf(false)};var failure by remember {mutableStateOf(false)}
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {uri->
        if(uri!=null){val owner=state.publicKey;uploading=true;setBusy(true);failure=false;scope.launch {
            try {val file=withContext(Dispatchers.IO){prepareListingFile(context,uri)};ensureActive();onUpload(model.uploadMedia(file,owner))}
            catch(e:kotlinx.coroutines.CancellationException){throw e}
            catch(_:Exception){failure=true}
            finally {uploading=false;setBusy(false)}
        }}
    }
    OutlinedButton(enabled=enabled&&!uploading,onClick={picker.launch(arrayOf("*/*"))}) {Text(if(uploading) "Uploading…" else "Add photo or file")}
    Text("Uploads are public. Photos have location metadata removed.",style=MaterialTheme.typography.bodySmall,color=Muted)
    if(failure)Text("Could not upload this file. Choose a file under 8 MiB and try again.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.error)
}
