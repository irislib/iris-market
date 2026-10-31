package to.iris.market

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.Surface
import android.view.TextureView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.*
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.atomic.AtomicBoolean

internal fun normalizeWalletQR(value:String,invoice:Boolean):String? {
    val text=value.trim()
    if(invoice){val raw=text.removePrefix("lightning:").removePrefix("LIGHTNING:").lowercase();return raw.takeIf{it.length<=16384&&it.startsWith("lnbc")&&it.all{c->c in 'a'..'z'||c in '0'..'9'}}}
    val raw=if(text.startsWith("cashu:",true))text.drop(6) else text
    return raw.takeIf{it.length<=2*1024*1024&&(it.startsWith("cashuA")||it.startsWith("cashuB"))&&it.none(Char::isWhitespace)}
}

/** Frames stay on this device and are discarded after decoding. */
private class WalletCameraQR(private val context:Context,private val result:(String)->Unit,private val failure:()->Unit):TextureView.SurfaceTextureListener {
    private val thread=HandlerThread("market-wallet-qr").apply{start()}
    private val handler=Handler(thread.looper)
    private val main=Handler(Looper.getMainLooper())
    private val closed=AtomicBoolean(false)
    private val delivered=AtomicBoolean(false)
    private var camera:CameraDevice?=null
    private var capture:CameraCaptureSession?=null
    private var reader:ImageReader?=null
    private var preview:Surface?=null
    private val decoder=MultiFormatReader().apply{setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),DecodeHintType.TRY_HARDER to true))}
    override fun onSurfaceTextureAvailable(texture:SurfaceTexture,width:Int,height:Int){
        handler.post {
            if(closed.get())return@post
            try {
                val manager=context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                val id=manager.cameraIdList.firstOrNull{manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING)==CameraCharacteristics.LENS_FACING_BACK}?:manager.cameraIdList.firstOrNull()?:error("No camera")
                val sizes=manager.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.YUV_420_888)?:error("Unsupported camera")
                val size=sizes.filter{it.width<=1280&&it.height<=1280}.minByOrNull{kotlin.math.abs(it.width-640)+kotlin.math.abs(it.height-480)}?:sizes.minByOrNull{it.width.toLong()*it.height}?:error("No image size")
                texture.setDefaultBufferSize(size.width,size.height);preview=Surface(texture)
                reader=ImageReader.newInstance(size.width,size.height,ImageFormat.YUV_420_888,2).also{input->input.setOnImageAvailableListener({source->
                    val image=runCatching{source.acquireLatestImage()}.getOrNull()?:return@setOnImageAvailableListener
                    try {
                        if(closed.get()||delivered.get())return@setOnImageAvailableListener
                        val plane=image.planes[0];val bytes=ByteArray(image.width*image.height)
                        for(y in 0 until image.height)for(x in 0 until image.width)bytes[y*image.width+x]=plane.buffer.get(y*plane.rowStride+x*plane.pixelStride)
                        var luminance:LuminanceSource=PlanarYUVLuminanceSource(bytes,image.width,image.height,0,0,image.width,image.height,false)
                        var value:String?=null
                        repeat(4){if(value==null){value=runCatching{decoder.decodeWithState(BinaryBitmap(HybridBinarizer(luminance))).text}.getOrNull();decoder.reset();if(luminance.isRotateSupported)luminance=luminance.rotateCounterClockwise()}}
                        value?.let{if(delivered.compareAndSet(false,true))main.post{result(it)}}
                    } finally {image.close()}
                },handler)}
                if(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED){fail();return@post}
                manager.openCamera(id,object:CameraDevice.StateCallback(){
                    override fun onOpened(device:CameraDevice){if(closed.get()){device.close();return};camera=device
                        device.createCaptureSession(listOf(requireNotNull(preview),requireNotNull(reader).surface),object:CameraCaptureSession.StateCallback(){
                            override fun onConfigured(session:CameraCaptureSession){if(closed.get()){session.close();return};capture=session
                                val request=device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply{addTarget(requireNotNull(preview));addTarget(requireNotNull(reader).surface);set(CaptureRequest.CONTROL_AF_MODE,CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)}.build()
                                session.setRepeatingRequest(request,null,handler)
                            }
                            override fun onConfigureFailed(session:CameraCaptureSession){fail()}
                        },handler)
                    }
                    override fun onDisconnected(device:CameraDevice){device.close();fail()}
                    override fun onError(device:CameraDevice,error:Int){device.close();fail()}
                },handler)
            }catch(_:Exception){fail()}
        }
    }
    private fun fail(){if(!closed.get())main.post{failure()}}
    fun close(){if(!closed.compareAndSet(false,true))return;handler.post{runCatching{capture?.stopRepeating()};capture?.close();camera?.close();reader?.close();preview?.release();thread.quitSafely()}}
    override fun onSurfaceTextureDestroyed(texture:SurfaceTexture):Boolean{close();return true}
    override fun onSurfaceTextureSizeChanged(texture:SurfaceTexture,width:Int,height:Int){}
    override fun onSurfaceTextureUpdated(texture:SurfaceTexture){}
}

@Composable internal fun WalletQRScannerDialog(invoice:Boolean,onValue:(String)->Unit,close:()->Unit) {
    val context=LocalContext.current
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle){mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))}
    DisposableEffect(lifecycle){val observer=LifecycleEventObserver{_,_->resumed=lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)};lifecycle.addObserver(observer);onDispose{lifecycle.removeObserver(observer)}}
    var allowed by remember{mutableStateOf(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)}
    var error by remember{mutableStateOf("")}
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted->allowed=granted;if(!granted)error="Camera access is off. You can paste instead."}
    LaunchedEffect(Unit){if(!allowed)permission.launch(Manifest.permission.CAMERA)}
    Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxWidth().padding(20.dp),shape=MaterialTheme.shapes.large){Column(Modifier.padding(24.dp),verticalArrangement=Arrangement.spacedBy(16.dp)){
            Text(if(invoice)"Scan invoice" else "Scan token",style=MaterialTheme.typography.titleLarge)
            if(allowed&&resumed&&error.isBlank()){
    val camera=remember{WalletCameraQR(context,{raw->val value=normalizeWalletQR(raw,invoice);if(value!=null){onValue(value);close()}else{error="This QR is not a supported ${if(invoice)"Lightning invoice" else "Cashu token"}. Close and scan again."}},{error="Camera unavailable. You can paste the ${if(invoice)"invoice" else "token"} instead."})}
                DisposableEffect(camera){onDispose{camera.close()}}
                AndroidView(factory={TextureView(it).apply{surfaceTextureListener=camera}},modifier=Modifier.fillMaxWidth().height(320.dp))
            }
            Text(error.ifBlank{"Place the QR code inside the camera view."},style=MaterialTheme.typography.bodyMedium)
            TextButton(onClick=close){Text("Cancel")}
        }}
    }
}
