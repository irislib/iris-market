package to.iris.market

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.*
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File

/** An isolated worker for the same pinned classifier used by Market on the web. */
internal class CompactSearchWebView(private val app: Context, private val modelDir: File) : AutoCloseable {
    private val main = Handler(Looper.getMainLooper())
    private val started = CompletableDeferred<Unit>()
    private var web: WebView? = null
    private var serial = 0
    private var pending: Pair<Int, CompletableDeferred<JSONObject>>? = null
    private val host = "appassets.androidplatform.net"
    private val code = setOf("index.html","page.js","worker.js","ort-wasm-simd-threaded.mjs",
        "ort-wasm-simd-threaded.wasm.gz","topic-vectors.bin")

    private fun resource(request: WebResourceRequest): WebResourceResponse {
        fun denied() = WebResourceResponse("text/plain","utf-8",404,"Not Found",emptyMap(),ByteArrayInputStream(byteArrayOf()))
        val uri = request.url
        val name = uri.path?.removePrefix("/") ?: return denied()
        if (uri.scheme != "https" || uri.encodedAuthority != host || request.method != "GET" || uri.query != null) return denied()
        return try {
            val stream = when {
                name == "ort-wasm-simd-threaded.wasm.gz" -> app.assets.open("compact-search/ort-wasm-simd-threaded.wasm.bin")
                name in code -> app.assets.open("compact-search/$name")
                CompactSearchFiles.assets.any { it.name == name } -> File(modelDir,name).inputStream()
                else -> return denied()
            }
            val mime = when {
                name.endsWith(".json") -> "application/json"
                name.endsWith(".js") || name.endsWith(".mjs") -> "text/javascript"
                name.endsWith(".html") -> "text/html"
                else -> "application/octet-stream"
            }
            val headers = mutableMapOf("Cache-Control" to "no-store", "Cross-Origin-Opener-Policy" to "same-origin",
                "Cross-Origin-Embedder-Policy" to "require-corp",
                "Content-Security-Policy" to "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'")
            val length = stream.available()
            val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range",true) }?.value
            if (range == null) {
                headers["Content-Length"] = length.toString()
                WebResourceResponse(mime,null,200,"OK",headers,stream)
            } else if (range == "bytes=0-0") {
                val first = stream.use { it.read() }
                headers["Content-Range"] = "bytes 0-0/$length"
                headers["Content-Length"] = "1"
                WebResourceResponse(mime,null,206,"Partial Content",headers,ByteArrayInputStream(byteArrayOf(first.toByte())))
            } else { stream.close(); denied() }
        } catch (_: Exception) { denied() }
    }

    private fun fail() {
        val error = IllegalStateException("The compact model could not review this listing.")
        started.completeExceptionally(error)
        pending?.second?.completeExceptionally(error)
    }

    private fun open() {
        val view = WebView(app)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            cacheMode = WebSettings.LOAD_NO_CACHE
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = resource(request)
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) fail()
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                fail()
                close()
                return true
            }
        }
        view.addJavascriptInterface(object {
            @JavascriptInterface fun ready() { main.post { started.complete(Unit) } }
            @JavascriptInterface fun complete(id: Int, json: String) { main.post {
                val active = pending ?: return@post
                if (id != active.first) return@post
                val value = runCatching { require(json.length <= 8192); JSONObject(json) }.getOrNull()
                if (value == null || value.optBoolean("failed")) fail() else active.second.complete(value)
            } }
        },"IrisSearch")
        view.loadUrl("https://$host/index.html")
    }

    suspend fun request(action: String, input: JSONObject = JSONObject()): JSONObject = withContext(Dispatchers.Main.immediate) {
        if (web == null) open()
        withTimeout(30_000) { started.await() }
        val id = ++serial
        val result = CompletableDeferred<JSONObject>()
        check(pending == null)
        pending = id to result
        try {
            val data = JSONObject.quote(input.toString())
            web!!.evaluateJavascript("compactSearch($id,${JSONObject.quote(action)},JSON.parse($data));",null)
            withTimeout(45_000) { result.await() }
        } finally { pending = null }
    }

    override fun close() { main.post {
        fail()
        web?.removeJavascriptInterface("IrisSearch")
        web?.destroy()
        web = null
    } }
}
