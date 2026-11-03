package to.iris.market

import android.app.Application
import android.system.Os
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.WindowInsets
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import to.iris.market.core.generateSecretKey
import java.io.File

/** Pass a private offline fixture with verified signed offers in files/search-replay/compact-ui.sqlite.
 * All normal search operations use an isolated, disposable profile. No live account or relay is used.
 */
class CompactSearchBrowseTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun waitFor(label: String, timeout: Long = 30_000, condition: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + timeout
        while (!condition()) {
            check(SystemClock.elapsedRealtime() < until) { "Timed out waiting for $label" }
            SystemClock.sleep(100)
        }
    }

    private fun findNode(matches: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return null
        val nodes = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        while (nodes.isNotEmpty()) {
            val node = nodes.removeFirst()
            if (matches(node)) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let(nodes::add)
        }
        return null
    }

    private fun screenshot(app: Application, label: String) {
        val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        try {
            val folder = File(app.getExternalFilesDir(null), "native-evidence").apply { mkdirs() }
            File(folder, "$label.png").outputStream().use {
                check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
            }
        } finally { bitmap.recycle() }
    }

    @Test fun submitSearchInBrowse() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("compactSearchUI") == "true")
        val query = requireNotNull(args.getString("compactQuery"))
        val title = requireNotNull(args.getString("compactExpectedTitle"))
        val app = ApplicationProvider.getApplicationContext<Application>()
        val root = File.createTempFile("compact-browse-", "", app.cacheDir).also { it.delete(); check(it.mkdir()) }
        val isolated = object : Application() {
            init { attachBaseContext(app) }
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        val fixture = File(app.filesDir, "search-replay/compact-ui.sqlite")
        require(fixture.length() in 1..1_000_000)
        // Inspect the fixture *before* the Rust runtime can connect to its configured relays.
        android.database.sqlite.SQLiteDatabase.openDatabase(fixture.path, null, android.database.sqlite.SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT value FROM preferences WHERE key='settings'", null).use { cursor ->
                check(cursor.moveToFirst())
                val settings = JSONObject(cursor.getString(0))
                check(settings.getJSONArray("relays").length() == 0)
                check(settings.getJSONObject("ai").getString("provider") == "compact")
            }
        }
        val isolatedMarket = File(isolated.filesDir, "market").also { check(it.mkdir()) }
        fixture.copyTo(File(isolatedMarket, "market.sqlite"))
        val modelFolder = CompactSearchFiles.directoryName
        val link = File(isolated.noBackupFilesDir, modelFolder)
        Os.symlink(File(app.noBackupFilesDir, modelFolder).path, link.path)
        SecureRecord(isolated).put("identity", generateSecretKey())
        val intent = Intent(app, ComponentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val activity = ActivityScenario.launch<ComponentActivity>(intent)
        try {
            lateinit var model: MarketModel
            activity.onActivity { host ->
                model = ViewModelProvider(host, object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>) = MarketModel(isolated, false) as T
                })[MarketModel::class.java]
                host.setContent { MarketTheme(false) { MarketAppView(model, Appearance.Light, {}, {}) } }
            }
            waitFor("verified inventory and model") {
                model.state.value.listings.isNotEmpty() && model.localModelState.value.available && !model.busy.value
            }
            assertFalse(model.homeFilterActive())
            waitFor("search field") { findNode { it.isEditable } != null }
            val field = checkNotNull(findNode { it.isEditable })
            field.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            val text = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query) }
            check(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, text)) { "Cannot type search" }
            waitFor("typed query") { findNode { it.isEditable && it.text?.toString()?.contains(query) == true } != null }
            val editor = checkNotNull(findNode { it.isEditable })
            if (android.os.Build.VERSION.SDK_INT < 30 ||
                !editor.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) {
                instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
            }
            waitFor("model approved result", 60_000) {
                model.state.value.aiSearch && model.state.value.query == query && model.state.value.listings.any { it.title == title && it.matchesSearch }
            }
            activity.onActivity { if (android.os.Build.VERSION.SDK_INT >= 30) it.window.insetsController?.hide(WindowInsets.Type.ime()) }
            waitFor("listing card") { findNode { it.text?.toString()?.contains(title) == true } != null }
            screenshot(app, "compact-search-result")
            val settings = checkNotNull(findNode { it.contentDescription?.toString() == "AI search" })
            check(settings.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)) { "Cannot open AI settings" }
            waitFor("selected provider") { findNode { it.text?.toString()?.contains("On device · Compact search") == true } != null }
            screenshot(app, "compact-search-settings")
        } finally {
            activity.close()
            // The installation belongs to Settings. Retire only the isolated fixture profile.
            java.nio.file.Files.deleteIfExists(link.toPath())
            root.deleteRecursively()
        }
    }
}
