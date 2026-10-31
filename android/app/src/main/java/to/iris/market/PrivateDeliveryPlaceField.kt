package to.iris.market

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.*
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

private fun trustedPrivatePlace(url:String?):Boolean=runCatching {
    val uri=Uri.parse(url ?: return false)
    uri.scheme=="https" && uri.host=="market.iris.to" && uri.port==-1 && uri.userInfo==null && uri.path in setOf("/native-map","/native-map.html") && uri.getQueryParameter("mode")=="place"
}.getOrDefault(false)

private class PrivatePlaceBridge {
    var web:WebView?=null
    var current:String?=null
    var changed:(String?)->Unit={}
    var locate:(String)->Unit={}
    var ready=false
    var closed=false
    var navigation=0
    @JavascriptInterface fun placeReady(){web?.post {if(!closed&&trustedPrivatePlace(web?.url)){ready=true;send()}}}
    @JavascriptInterface fun placeChanged(raw:String){if(raw.toByteArray(Charsets.UTF_8).size>4096)return;web?.post {
        if(!closed&&trustedPrivatePlace(web?.url))runCatching {
            val value=if(raw=="null")null else JSONObject(raw).also { require(it.keys().asSequence().all {key->key in setOf("label","address","coordinates")});val place=OrderDeliveryPlace.parse(it);require(place.label.length<=120&&place.address.length<=500);place.coordinates?.let {point->require(point.size==2&&point.all(Double::isFinite)&&kotlin.math.abs(point[0])<=180&&kotlin.math.abs(point[1])<=90)} }.toString()
            current=value;changed(value)
        }
    }}
    @JavascriptInterface fun requestLocation(id:String){if(id.isEmpty()||id.length>20||!id.all(Char::isDigit))return;web?.post {if(!closed&&ready&&trustedPrivatePlace(web?.url))locate.invoke(id)}}
    fun send(){if(!closed&&ready&&trustedPrivatePlace(web?.url))web?.evaluateJavascript("window.marketPlace?.setValue(${current ?: "null"});",null)}
    fun location(id:String,point:JSONArray?){if(!closed&&ready&&trustedPrivatePlace(web?.url))web?.evaluateJavascript("window.marketPlace?.setLocation(${JSONObject.quote(id)},${point ?: "null"});",null)}
}

/** One explicit fix for a local coverage draft; no route messages or background watch. */
@SuppressLint("SetJavaScriptEnabled")
@Composable fun PrivatePlaceMapEditor(value:String?,change:(String?)->Unit,close:()->Unit) {
    val context=LocalContext.current
    val bridge=remember {PrivatePlaceBridge().also {it.current=value}}
    val latestChange by rememberUpdatedState(change)
    val handler=remember {Handler(Looper.getMainLooper())}
    val manager=remember {context.getSystemService(Context.LOCATION_SERVICE) as LocationManager}
    var listener by remember {mutableStateOf<LocationListener?>(null)}
    var pending by remember {mutableStateOf<String?>(null)}
    var failed by remember {mutableStateOf(false)}
    var error by remember {mutableStateOf<String?>(null)}
    val dark=MaterialTheme.colorScheme.background.luminance()<.5f
    fun finish(id:String,point:JSONArray?) {if(pending!=id)return;listener?.let {runCatching {manager.removeUpdates(it)}};listener=null;pending=null;bridge.location(id,point)}
    fun locate(id:String) {
        error=null
        val precise=ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED
        val approximate=ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED
        if(!precise&&!approximate){finish(id,null);return}
        val next=object:LocationListener {
            override fun onLocationChanged(location:Location) {
                if(bridge.closed||pending!=id)return
                if(!location.latitude.isFinite()||!location.longitude.isFinite()||android.os.SystemClock.elapsedRealtimeNanos()-location.elapsedRealtimeNanos>120_000_000_000L)return
                finish(id,JSONArray(listOf(location.longitude,location.latitude)))
            }
            override fun onProviderEnabled(provider:String){}
            override fun onProviderDisabled(provider:String){}
            @Deprecated("Deprecated in Android") override fun onStatusChanged(provider:String?,status:Int,extras:Bundle?){}
        }
        listener=next
        try {
            val providers=(if(precise)listOf(LocationManager.NETWORK_PROVIDER,LocationManager.GPS_PROVIDER) else listOf(LocationManager.NETWORK_PROVIDER)).filter {manager.isProviderEnabled(it)}
            if(providers.isEmpty()){error="Location unavailable. Choose a point on the map.";finish(id,null)}
            else {providers.forEach {manager.requestSingleUpdate(it,next,Looper.getMainLooper())};handler.postDelayed({finish(id,null)},10000)}
        }catch(_:SecurityException){finish(id,null)}
    }
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {result->pending?.let {id->if(result.values.any {it})locate(id) else finish(id,null)}}
    bridge.changed={latestChange(it)}
    bridge.locate={id->pending?.let {finish(it,null)};pending=id
        if(ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED||ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED)locate(id)
        else permission.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION))}
    DisposableEffect(bridge){onDispose {bridge.closed=true;listener?.let {runCatching {manager.removeUpdates(it)}};handler.removeCallbacksAndMessages(null);bridge.web?.apply {stopLoading();removeJavascriptInterface("MarketMapBridge");destroy()};bridge.web=null}}
    Dialog(onDismissRequest=close,properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize()) {Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal=16.dp)) {Text("Choose a place",style=MaterialTheme.typography.titleLarge,modifier=Modifier.weight(1f));TextButton(onClick=close){Text("Done")}}
            error?.let {Text(it,Modifier.padding(16.dp))}
            if(failed) {Text("Map unavailable",Modifier.padding(16.dp));OutlinedButton(onClick={failed=false;bridge.ready=false;bridge.web?.reload()}){Text("Retry")}}
            AndroidView(modifier=Modifier.weight(1f).fillMaxWidth(),factory={WebView(it).apply {
                settings.javaScriptEnabled=true;settings.domStorageEnabled=true;settings.allowFileAccess=false;settings.allowContentAccess=false;settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
                addJavascriptInterface(bridge,"MarketMapBridge");bridge.web=this
                webViewClient=object:WebViewClient(){
                    override fun onPageStarted(view:WebView?,url:String?,icon:android.graphics.Bitmap?){bridge.ready=false;bridge.navigation++;val generation=bridge.navigation;handler.postDelayed({if(!bridge.closed&&!bridge.ready&&bridge.navigation==generation)failed=true},12000)}
                    override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?):Boolean=request?.isForMainFrame!=true||!trustedPrivatePlace(request.url.toString())
                    override fun onReceivedError(view:WebView?,request:WebResourceRequest?,error:WebResourceError?){if(request?.isForMainFrame==true)failed=true}
                    override fun onReceivedHttpError(view:WebView?,request:WebResourceRequest?,response:WebResourceResponse?){if(request?.isForMainFrame==true)failed=true}
                    override fun onReceivedSslError(view:WebView?,handler:SslErrorHandler?,error:android.net.http.SslError?){handler?.cancel();failed=true}
                }
                loadUrl("https://market.iris.to/native-map?native=1&mode=place&theme=${if(dark)"dark" else "light"}")
            }},update={if(bridge.ready)it.evaluateJavascript("window.marketPlace?.setDark($dark);",null)})
        }}
    }
}


@Composable fun PrivateDeliveryPlaceField(value:OrderDeliveryPlace,change:(OrderDeliveryPlace)->Unit) {
    var choosing by remember {mutableStateOf(false)}
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text(value.label,style=MaterialTheme.typography.titleMedium)
        OutlinedTextField(value.address,{change(value.copy(address=it.take(500),coordinates=null))},label={Text("Address or meeting point")},modifier=Modifier.fillMaxWidth(),minLines=2)
        TextButton(onClick={choosing=true}){Text(if(value.coordinates==null)"Choose on map" else "Edit map point")}
        if(value.coordinates!=null)Text("Map point selected",style=MaterialTheme.typography.bodySmall)
    }
    if(choosing)PrivatePlaceMapEditor(value=JSONObject().put("label",value.label).put("address",value.address).apply {value.coordinates?.let {put("coordinates",JSONArray(it))}}.toString(),change={raw->if(raw!=null)runCatching {change(OrderDeliveryPlace.parse(JSONObject(raw)))}},close={choosing=false})
}
