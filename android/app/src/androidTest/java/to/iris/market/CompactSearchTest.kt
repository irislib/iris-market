package to.iris.market

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import to.iris.market.core.MarketApp
import to.iris.market.core.generateSecretKey
import java.io.File

/** Opt in with -e compactSearchSmoke true after installing the pinned model.
 * Uses an isolated offline Market database and the regular native model/commands.
 */
class CompactSearchTest {
    @Test fun downloadPinnedModel() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("compactSearchDownload") == "true")
        val app = ApplicationProvider.getApplicationContext<Application>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = CompactSearchModel(app, scope)
        try {
            val initial = withTimeout(30_000) { model.state.first { !it.busy } }
            if (!initial.available) {
                model.download()
                val result = withTimeout(360_000) { model.state.first { !it.busy } }
                assertTrue(result.error ?: "Download incomplete", result.available)
            }
            for (asset in CompactSearchFiles.assets) {
                val file = File(File(app.noBackupFilesDir, CompactSearchFiles.directoryName), asset.name)
                file.inputStream().use { input -> LocalModelContract.copyVerified(input, null, asset.bytes, asset.hash) }
            }
        } finally { scope.cancel() }
    }

    @Test fun searchOfflineListings() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("compactSearchSmoke") == "true")
        val app = ApplicationProvider.getApplicationContext<Application>()
        val database = File.createTempFile("compact-search-", "", app.cacheDir).also { it.delete(); check(it.mkdir()) }
        val core = MarketApp(database.path, generateSecretKey(), true)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = CompactSearchModel(app, scope)
        fun command(value: JSONObject) = JSONObject(core.command(value.toString()))
        try {
            val ready = withTimeout(20_000) { model.state.first { it.phase != LocalModelPhase.VERIFYING } }
            assertTrue("Install the verified compact model before replay", ready.available)
            val settings = JSONObject(core.snapshot()).getJSONObject("settings")
            settings.getJSONObject("ai").put("enabled", true).put("provider", "compact").put("model", CompactSearchFiles.ID)
                .put("base_url", "").put("curate_feed", true)
            command(JSONObject().put("type", "set_settings").put("settings", settings))
            val query = "bicycle"
            command(JSONObject().put("type", "set_filter").put("query", query).put("side", "all").put("ai_search", true))
            val batch = MarketSnapshot.parse(core.command("""{"type":"begin_local_curation"}""")).localCuration!!
            assertTrue(batch.candidates.isNotEmpty())
            var planned = false
            val reviewed = mutableListOf<String>()
            val decisions = model.classify(batch, run = 1, planning = LocalSearchPlanInput(query, listOf("bicycles", "lamp")), onPlan = { terms ->
                // The web topic index supplies free terms as well as observed tags.
                assertTrue(terms.size in 1..6)
                planned = true
                batch
            }, onDecision = { decision ->
                assertNotNull(decision.score)
                assertFalse(decision.unavailable)
                val row = JSONObject().put("event_id", decision.eventId).put("score", decision.score)
                    .put("show", decision.show).put("reason", decision.reason)
                command(JSONObject().put("type", "apply_local_curation").put("id", batch.id)
                    .put("partial", true).put("decisions", JSONArray().put(row)))
                reviewed.add(decision.eventId)
            })
            assertTrue(planned)
            assertEquals(batch.candidates.map { it.eventId }, reviewed)
            assertEquals(reviewed.size, decisions.size)
            assertEquals(reviewed.size, MarketSnapshot.parse(core.snapshot()).listings.count { it.relevanceScore != null })
            // The Settings test uses the same offline renderer and full-detail path.
            assertTrue(NativeAITestRunner.run(NativeAITestInput("bicycle", "A city bicycle with two wheels, available for purchase.")) {
                model.classify(it, sandbox = true)
            })
        } finally {
            model.stop()
            scope.cancel()
            core.shutdown()
            core.close()
            database.deleteRecursively()
        }
    }
}
