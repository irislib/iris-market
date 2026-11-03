package to.iris.market

import android.app.Application
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Offline replay through the production LiteRT classifier, without opening MainActivity.
 * Pass -e marketSearchReplay NAME after placing NAME.jsonl under files/search-replay
 * in the debug app and installing its pinned model. Rows contain caseID, query and listing.
 * The adjacent NAME-results.jsonl contains initialization timing and one flushed record per row.
 * Consecutive cases with the same query reuse an engine exactly as in a submitted search.
 */
class PublicSearchReplayTest {
    @Test fun scorePublicListings() = runBlocking {
        val name = InstrumentationRegistry.getArguments().getString("marketSearchReplay")
        assumeTrue(name != null)
        require(checkNotNull(name).matches(Regex("[a-zA-Z0-9_-]{1,60}")))
        val app = ApplicationProvider.getApplicationContext<Application>()
        val directory = File(app.filesDir, "search-replay")
        val input = File(directory, "$name.jsonl")
        require(input.length() in 1..4_000_000)
        val rows = input.readLines().filter(String::isNotBlank).map(::JSONObject)
        require(rows.size in 1..300)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val model = LocalModel(app, scope)
        val now = SystemClock::elapsedRealtime
        try {
            File(directory, "$name-results.jsonl").bufferedWriter().use { out ->
                fun write(row: JSONObject) { out.appendLine(row.toString()); out.flush() }
                val initial = now()
                assertTrue("Download the verified model before replay", model.verifyInstalled())
                write(JSONObject().put("verifyInstalledMilliseconds", now() - initial))
                var previous: String? = null
                var run = 0L
                for (row in rows) {
                    val query = row.getString("query")
                    val item = row.getJSONObject("listing")
                    val caseID = row.getString("caseID")
                    val tags = when (val value = item.opt("tags")) {
                        is JSONArray -> (0 until value.length()).map(value::getString)
                        is String -> value.split(", ").filter(String::isNotBlank)
                        else -> emptyList()
                    }
                    val listing = Listing("", "", item.optString("title"), item.optString("description"),
                        item.optString("side"), item.optString("price"), item.optString("currency"),
                        item.optString("location"), item.optString("category"), null, false, false, "active",
                        "", null, null, tags = tags)
                    val batch = LocalCurationBatch("", query, listOf(LocalCurationCandidate(caseID, listing)))
                    val cold = query != previous
                    if (cold) run++
                    val started = now()
                    val result = JSONObject().put("caseID", caseID).put("coldEngine", cold)
                    try {
                        val decision = withTimeout(270_000) { model.classify(batch, run = run).single() }
                        result.put("show", if (decision.unavailable) JSONObject.NULL else decision.show)
                            .put("score", decision.score ?: JSONObject.NULL)
                            .put("error", if (decision.unavailable) "invalid_decision" else JSONObject.NULL)
                        previous = query
                    } catch (e: TimeoutCancellationException) {
                        result.put("error", "timeout")
                        previous = null
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) {
                        result.put("error", e.javaClass.simpleName)
                        previous = null
                    }
                    write(result.put("milliseconds", now() - started))
                }
            }
        } finally { model.stop(); scope.cancel() }
    }
}
