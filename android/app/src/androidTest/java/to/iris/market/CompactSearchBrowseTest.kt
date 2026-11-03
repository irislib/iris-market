package to.iris.market

import android.app.Application
import android.system.Os
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import to.iris.market.core.generateSecretKey
import java.io.File

/** Pass a private offline fixture with verified signed offers in files/search-replay/compact-ui.sqlite.
 * All normal search operations use an isolated, disposable profile. No live account or relay is used.
 */
class CompactSearchBrowseTest {
    @get:Rule val compose = createComposeRule()

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
        val owner = object : ViewModelStoreOwner { override val viewModelStore = ViewModelStore() }
        try {
            val model = compose.runOnUiThread {
                ViewModelProvider(owner, object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T : ViewModel> create(modelClass: Class<T>) = MarketModel(isolated, false) as T
                })[MarketModel::class.java]
            }
            compose.setContent {
                val state by model.state.collectAsState()
                val busy by model.busy.collectAsState()
                MarketTheme(false) { BrowseView(state, model, busy, {}, {}, false, {}) }
            }
            compose.waitUntil(30_000) { model.state.value.listings.isNotEmpty() && model.localModelState.value.available && !model.busy.value }
            assertFalse(model.homeFilterActive())
            compose.onNode(hasSetTextAction()).performTextInput(query)
            compose.onNode(hasSetTextAction()).performImeAction()
            compose.waitUntil(60_000) { model.state.value.listings.any { it.title == title && it.matchesSearch } }
            compose.onNodeWithText(title).performScrollTo().assertIsDisplayed()
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            try {
                val folder = File(app.getExternalFilesDir(null), "native-evidence").apply { mkdirs() }
                File(folder, "compact-search-result.png").outputStream().use {
                    check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
                }
            } finally { bitmap.recycle() }
        } finally {
            compose.runOnUiThread { owner.viewModelStore.clear() }
            // The installation belongs to Settings. Remove the link before retiring the fixture.
            java.nio.file.Files.deleteIfExists(link.toPath())
        }
    }
}
