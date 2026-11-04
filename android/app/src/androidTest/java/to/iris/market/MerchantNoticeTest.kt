package to.iris.market

import android.app.Application
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.ui.Modifier
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Opt-in, isolated device test with a synthetic signed offer on a loopback relay. */
class MerchantNoticeTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun notifySellerFromListing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val id = args.getString("noticeListing")
        assumeTrue(id != null)
        val relay = requireNotNull(args.getString("noticeRelay"))
        require(Regex("ws://127\\.0\\.0\\.1:[0-9]+").matches(relay))
        val app = instrumentation.targetContext.applicationContext as Application
        val root = kotlin.io.path.createTempDirectory(app.cacheDir.toPath(), "notice-").toFile()
        val isolated = object : Application() {
            init { attachBaseContext(app) }
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        val base = File(isolated.filesDir, "market").apply { mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(File(base, "market.sqlite"), null).use { db ->
            db.execSQL("CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            val settings = JSONObject().put("relays", JSONArray().put(relay))
            db.execSQL("INSERT INTO preferences VALUES ('settings',?)", arrayOf(settings.toString()))
        }
        val model = compose.activityRule.scenario.let { scenario ->
            lateinit var model: MarketModel
            scenario.onActivity { activity ->
                model = ViewModelProvider(activity, object : ViewModelProvider.Factory {
                    @Suppress("UNCHECKED_CAST")
                    override fun <T: ViewModel> create(modelClass: Class<T>): T = MarketModel(isolated, false) as T
                })[MarketModel::class.java]
            }
            model
        }
        try {
            compose.setContent {
                val snapshot by model.state.collectAsState()
                val listing = snapshot.listings.firstOrNull { it.id == id }
                MarketTheme(false) {
                    Box(Modifier.fillMaxSize().systemBarsPadding()) {
                        if (listing != null) ListingDetail(listing, false, model, false, null, {}, {}, {})
                    }
                }
            }
            compose.waitUntil(30_000) { compose.onAllNodesWithTag("merchantNotice").fetchSemanticsNodes().isNotEmpty() }
            val button = compose.onNodeWithTag("merchantNotice").performScrollTo().assertIsEnabled()
            compose.onNodeWithText("Sends “Someone wants to buy from you", substring = true).performScrollTo()
            compose.waitForIdle()
            val bitmap = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
            try {
                val file = File(app.getExternalFilesDir(null), "merchant-notice.png")
                file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            } finally { bitmap.recycle() }
            button.performClick()
            compose.waitUntil(30_000) {
                compose.onAllNodesWithText("Notice accepted by the seller’s inbox relay.").fetchSemanticsNodes().isNotEmpty()
            }
        } finally {
            compose.activityRule.scenario.close()
            root.deleteRecursively()
        }
    }
}
