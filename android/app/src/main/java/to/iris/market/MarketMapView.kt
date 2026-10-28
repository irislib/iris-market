package to.iris.market

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebSettings
import androidx.compose.runtime.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONArray
import org.json.JSONObject

private fun trustedMap(url: String?): Boolean = runCatching {
    val uri=Uri.parse(url ?: return false)
    uri.scheme=="https" && uri.host=="market.iris.to" && uri.port==-1 && uri.path=="/native-map.html"
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
        listings.forEach { l -> l.coordinates?.takeIf { it.size==2 && it.all(Double::isFinite) }?.let { coords ->
            array.put(JSONObject().put("id",l.id).put("title",l.title).put("coordinates",JSONArray(coords)))
        } }
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
    val callback by rememberUpdatedState(onSelect)
    DisposableEffect(bridge) {onDispose {bridge.web?.apply {stopLoading();removeJavascriptInterface("MarketMapBridge");destroy()};bridge.web=null}}
    AndroidView(modifier=modifier,factory={
        WebView(context).apply {
            settings.javaScriptEnabled=true;settings.domStorageEnabled=true
            settings.allowFileAccess=false;settings.allowContentAccess=false
            settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically=false
            addJavascriptInterface(bridge,"MarketMapBridge")
            webViewClient=object:WebViewClient() {
                override fun onPageStarted(view:WebView?,url:String?,icon:android.graphics.Bitmap?) {bridge.navigated()}
                override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?):Boolean {
                    val url=request?.url?.toString()
                    if(request?.isForMainFrame==true && trustedMap(url)) return false
                    if(request?.hasGesture()==true && request.isForMainFrame && request.url.scheme=="https") runCatching {context.startActivity(Intent(Intent.ACTION_VIEW,request.url))}
                    return true
                }
            }
            bridge.web=this;bridge.listings=listings;bridge.dark=dark;bridge.onSelect={callback(it)}
            loadUrl("https://market.iris.to/native-map.html?native=1&cache=512&theme=${if(dark) "dark" else "light"}")
        }
    },update={bridge.listings=listings;bridge.dark=dark;bridge.onSelect={callback(it)};bridge.send()})
}
