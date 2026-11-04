package to.iris.market

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.ui.Modifier
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Requires a dedicated test device with an isolated, synthetic provider fixture. */
class EscrowWorkspaceTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun find(node: AccessibilityNodeInfo?, label: String): AccessibilityNodeInfo? {
        if (node == null) return null
        if (node.text?.contains(label) == true || node.contentDescription?.contains(label) == true) return node
        for (i in 0 until node.childCount) find(node.getChild(i), label)?.let { return it }
        return null
    }
    private fun waitFor(label: String): AccessibilityNodeInfo {
        val until = SystemClock.elapsedRealtime() + 30_000
        while (SystemClock.elapsedRealtime() < until) {
            find(instrumentation.uiAutomation.rootInActiveWindow, label)?.let { return it }
            SystemClock.sleep(100)
        }
        error("Could not find $label")
    }
    private fun click(label: String) {
        var node: AccessibilityNodeInfo? = waitFor(label)
        while (node != null && !node.isClickable) node = node.parent
        check(node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true) { "Could not open $label" }
    }
    private fun webView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) webView(view.getChildAt(i))?.let { return it }
        return null
    }
    private fun waitForTrade(script: String) {
        val deadline = SystemClock.elapsedRealtime() + 30_000
        while (SystemClock.elapsedRealtime() < deadline) {
            val reply = CountDownLatch(1)
            var result: String? = null
            instrumentation.runOnMainSync {
                val web = WindowInspector.getGlobalWindowViews().firstNotNullOfOrNull(::webView)
                if (web == null) reply.countDown()
                else web.evaluateJavascript(script) { result = it; reply.countDown() }
            }
            if (reply.await(2, TimeUnit.SECONDS) && result == "true") return
            SystemClock.sleep(100)
        }
        error("The trade screen did not complete the expected provider action.")
    }
    private fun screenshot(app: Application, name: String) {
        val image = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try {
            val dir = File(app.getExternalFilesDir(null), "native-evidence").apply { mkdirs() }
            File(dir, "$name.png").outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        } finally { image.recycle() }
    }

    @Test fun providerReviewsThenDeclinesAnEscrowJob() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("escrowFixture") == "true")
        val app = instrumentation.targetContext.applicationContext as Application
        val fixture = File(app.filesDir, "escrow-ui-fixture")
        check(File(fixture, "ui-test-storage-v1").readText() == "iris-market-isolated-test-v1")
        val root = File.createTempFile("escrow-role-", "", app.cacheDir).also { it.delete(); check(it.mkdir()) }
        val isolated = object : Application() {
            init { attachBaseContext(app) }
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        check(File(fixture, "market").copyRecursively(File(isolated.filesDir, "market")))
        val identity = JSONObject(File(fixture, "credentials.json").readText()).getString("identity")
        SecureRecord(isolated).put("identity", identity)
        val intent = Intent(app, ComponentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = ActivityScenario.launch<ComponentActivity>(intent)
        try {
            activity.onActivity { host ->
                val model = ViewModelProvider(host, object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>) = MarketModel(isolated, false) as T
                })[MarketModel::class.java]
                host.setContent {
                    val snapshot by model.state.collectAsState()
                    val busy by model.busy.collectAsState()
                    MarketTheme(false) { Box(Modifier.fillMaxSize().systemBarsPadding()) { OrdersView(snapshot, model, busy) { } } }
                }
            }
            click("Escrow jobs")
            waitFor("Oak reading lamp")
            screenshot(app, "android-provider-jobs")
            click("Oak reading lamp")
            waitForTrade("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Accept job' && !b.disabled)")
            screenshot(app, "android-provider-review")
            waitForTrade("(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Decline job' && !b.disabled);if(!b)return false;b.click();return true})()")
            waitForTrade("document.body.innerText.includes('Invitation declined')")
            screenshot(app, "android-provider-declined")
        } catch (error: Throwable) {
            screenshot(app, "android-provider-last-failure")
            throw error
        } finally { activity.close(); root.deleteRecursively() }
    }
}
