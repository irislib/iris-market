package to.iris.market

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebSettings
import androidx.compose.runtime.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONArray
import org.json.JSONObject

private open class MapPageClient(private val failed: MutableState<Boolean>) : WebViewClient() {
    override fun onPageStarted(view: WebView?, url: String?, icon: android.graphics.Bitmap?) {
        failed.value = false
        view?.visibility = View.INVISIBLE
    }
    override fun onPageCommitVisible(view: WebView?, url: String?) {
        if (!failed.value && trustedMap(url)) view?.visibility = View.VISIBLE
    }
    private fun unavailable(view: WebView?) {
        view?.stopLoading()
        view?.visibility = View.INVISIBLE
        failed.value = true
    }
    override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
        if (request?.isForMainFrame == true) unavailable(view)
    }
    override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) {
        if (request?.isForMainFrame == true) unavailable(view)
    }
    override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
        handler?.cancel()
        unavailable(view)
    }
}

@Composable private fun MapFrame(modifier: Modifier, failed: Boolean, retry: () -> Unit, content: @Composable () -> Unit) {
    Box(modifier) {
        content()
        if (failed) Surface(Modifier.matchParentSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Map unavailable", style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = retry) { Text("Retry") }
            }
        }
    }
}

private fun trustedMap(url: String?): Boolean = runCatching {
    val uri=Uri.parse(url ?: return false)
    uri.scheme=="https" && uri.host=="market.iris.to" && uri.port==-1 && uri.userInfo==null && uri.path in setOf("/native-map", "/native-map.html")
}.getOrDefault(false)

/** Only ready/marker-id messages are exposed. No keys, credentials or private messages. */
private class MapBridge {
    var web: WebView?=null
    var listings: List<Listing> = emptyList()
    var onSelect: (Listing)->Unit={}
    var dark=false
    var loaded=false
    private var lastPayload=""
    @JavascriptInterface fun ready() { web?.post { if(trustedMap(web?.url)) {loaded=true;lastPayload="";send()} } }
    @JavascriptInterface fun select(id: String) { if(id.length>230) return; web?.post { if(trustedMap(web?.url)) listings.firstOrNull{it.id==id}?.let(onSelect) } }
    fun navigated() {loaded=false;lastPayload=""}
    fun send() {
        val view=web ?: return
        if(!loaded || !trustedMap(view.url)) return
        val array=JSONArray()
        var areaBytes = 0
        listings.take(1000).forEach { listing ->
            val row = JSONObject().put("id", listing.id).put("title", listing.title.take(160))
            listing.coordinates?.takeIf { it.size == 2 && it.all(Double::isFinite) && kotlin.math.abs(it[0]) <= 180 && kotlin.math.abs(it[1]) <= 90 }
                ?.let { row.put("coordinates", JSONArray(it)) }
            listing.serviceAreas?.let { raw ->
                val size = raw.toByteArray(Charsets.UTF_8).size
                if (size <= 32832 && areaBytes + size <= 1048576) runCatching { JSONObject(raw) }.getOrNull()?.let { areas ->
                    row.put("serviceAreas", areas); areaBytes += size
                }
            }
            if (row.has("coordinates") || row.has("serviceAreas")) array.put(row)
        }
        val script="window.marketMap?.setListings($array);window.marketMap?.setDark($dark);"
        if(script==lastPayload) return
        lastPayload=script;view.evaluateJavascript(script,null)
    }
}
@SuppressLint("SetJavaScriptEnabled")
@Composable fun MarketMapView(listings: List<Listing>, onSelect:(Listing)->Unit, modifier: Modifier=Modifier) {
    val context=LocalContext.current
    val dark=MaterialTheme.colorScheme.background.luminance()<.5f
    val bridge=remember { MapBridge() }
    val failed=remember { mutableStateOf(false) }
    val callback by rememberUpdatedState(onSelect)
    DisposableEffect(bridge) {onDispose {bridge.web?.apply {stopLoading();removeJavascriptInterface("MarketMapBridge");destroy()};bridge.web=null}}
    MapFrame(modifier,failed.value,{bridge.web?.reload()}) {
    AndroidView(modifier=Modifier.fillMaxSize(),factory={
        WebView(context).apply {
            settings.javaScriptEnabled=true;settings.domStorageEnabled=true
            settings.allowFileAccess=false;settings.allowContentAccess=false
            settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically=false
            addJavascriptInterface(bridge,"MarketMapBridge")
            webViewClient=object:MapPageClient(failed) {
                override fun onPageStarted(view:WebView?,url:String?,icon:android.graphics.Bitmap?) {super.onPageStarted(view,url,icon);bridge.navigated()}
                override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?):Boolean {
                    val url=request?.url?.toString()
                    if(request?.isForMainFrame==true && trustedMap(url)) return false
                    if(request?.hasGesture()==true && request.isForMainFrame && request.url.scheme=="https") runCatching {context.startActivity(Intent(Intent.ACTION_VIEW,request.url))}
                    return true
                }
            }
            bridge.web=this;bridge.listings=listings;bridge.dark=dark;bridge.onSelect={callback(it)}
            loadUrl("https://market.iris.to/native-map?native=1&cache=512&theme=${if(dark) "dark" else "light"}")
        }
    },update={bridge.listings=listings;bridge.dark=dark;bridge.onSelect={callback(it)};bridge.send()})
    }
}

private fun trustedShipmentMap(url: String?): Boolean = trustedMap(url) && runCatching {
    Uri.parse(url).getQueryParameter("mode") == "shipment"
}.getOrDefault(false)

private class ShipmentBridge {
    var web: WebView? = null
    var shipment: Shipment? = null
    var dark = false
    private var loaded = false
    private var lastPayload = ""
    @JavascriptInterface fun ready() { web?.post { if (trustedShipmentMap(web?.url)) { loaded = true; lastPayload = ""; send() } } }
    fun navigated() { loaded = false; lastPayload = "" }
    fun send() {
        val view = web ?: return
        if (!loaded || !trustedShipmentMap(view.url)) return
        val route = shipment?.mapProjection() ?: JSONObject().put("stops", JSONArray())
        val script = "window.marketMap?.setShipment($route);window.marketMap?.setDark($dark);"
        if (script == lastPayload) return
        lastPayload = script; view.evaluateJavascript(script, null)
    }
}

/** Separate route-only renderer. No listing discovery, identities, tokens or signing bridge. */
@SuppressLint("SetJavaScriptEnabled")
@Composable fun ShipmentMapView(shipment: Shipment, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val dark = MaterialTheme.colorScheme.background.luminance() < .5f
    val bridge = remember { ShipmentBridge() }
    val failed = remember { mutableStateOf(false) }
    DisposableEffect(bridge) {
        onDispose { bridge.shipment = null; bridge.web?.apply { stopLoading(); removeJavascriptInterface("MarketMapBridge"); destroy() }; bridge.web = null }
    }
    MapFrame(modifier, failed.value, { bridge.web?.reload() }) {
    AndroidView(modifier = Modifier.fillMaxSize(), factory = {
        WebView(context).apply {
            settings.javaScriptEnabled = true; settings.domStorageEnabled = true
            settings.allowFileAccess = false; settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            addJavascriptInterface(bridge, "MarketMapBridge")
            webViewClient = object : MapPageClient(failed) {
                override fun onPageStarted(view: WebView?, url: String?, icon: android.graphics.Bitmap?) { super.onPageStarted(view,url,icon); bridge.navigated() }
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = request?.isForMainFrame != true || !trustedShipmentMap(request.url.toString())
            }
            bridge.web = this; bridge.shipment = shipment; bridge.dark = dark
            loadUrl("https://market.iris.to/native-map?native=1&mode=shipment&cache=512&theme=${if (dark) "dark" else "light"}")
        }
    }, update = { bridge.shipment = shipment; bridge.dark = dark; bridge.send() })
    }
}
