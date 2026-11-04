package to.iris.market

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
                    MarketTheme(false) { OrdersView(snapshot, model, busy) { } }
                }
            }
            click("Escrow jobs")
            waitFor("Oak reading lamp")
            screenshot(app, "android-provider-jobs")
            click("Oak reading lamp")
            waitFor("Accept job")
            screenshot(app, "android-provider-review")
            click("Decline job")
            waitFor("Invitation declined")
            screenshot(app, "android-provider-declined")
        } finally { activity.close(); root.deleteRecursively() }
    }
}
