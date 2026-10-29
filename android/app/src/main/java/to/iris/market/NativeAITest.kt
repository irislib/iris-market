package to.iris.market

import org.json.JSONObject

data class NativeAITestInput(val query: String = "bicycle", val listing: String = "City bicycle in working condition.") {
    val validationError: String? get() = when {
        query.isBlank() || query.toByteArray(Charsets.UTF_8).size > 1000 -> "Enter a test search of up to 1000 bytes."
        listing.isBlank() || listing.toByteArray(Charsets.UTF_8).size > 2000 -> "Enter an example listing of up to 2000 bytes."
        else -> null
    }
}
data class NativeAITestResult(val matched: Boolean?, val elapsedMs: Long, val provider: String, val model: String, val error: String? = null) {
    val summary: String get() = summary(if(provider=="litert") "On-device" else provider)
    fun summary(providerLabel: String): String = "${matched?.let { if(it) "Match" else "No match" } ?: "Test failed"} · $providerLabel · $model · $elapsedMs ms"
    companion object {
        fun parse(o: JSONObject) = NativeAITestResult(if(o.isNull("matched")) null else o.getBoolean("matched"),o.getLong("elapsed_ms"),o.getString("provider"),o.getString("model"),if(o.has("error")&&!o.isNull("error")) o.getString("error") else null)
    }
}
data class NativeAITestContext(val account: Long, val epoch: Long, val provider: String, val model: String, val endpoint: String, val enabled: Boolean)
class NativeAITestSession {
    private val counter=java.util.concurrent.atomic.AtomicLong(0)
    val revision: Long get()=counter.get()
    fun invalidate(): Long = counter.incrementAndGet()
    fun accepts(submitted: Long, context: NativeAITestContext, current: NativeAITestContext): Boolean = submitted == revision && context == current
}
data class NativeAITestUI(val busy: Boolean = false, val result: NativeAITestResult? = null, val error: String? = null)

object NativeAITestRunner {
    suspend fun run(sample: NativeAITestInput, classify: suspend (LocalCurationBatch) -> List<LocalCurationDecision>): Boolean {
        require(sample.validationError == null)
        val listing=Listing("settings-test","","",sample.listing,"","","","","",null,false,false,"active","",null,null)
        val rows=classify(LocalCurationBatch("settings-test",sample.query,listOf(LocalCurationCandidate("settings-test",listing))))
        return rows.single().show
    }
}
