package to.iris.market

/** Only a submitted search authorizes late-arrival review; stop clears that authority. */
class NativeSearchContinuation {
    private var context: String? = null
    private val attempted = mutableSetOf<String>()
    private var historyWindows = 0
    @Synchronized fun start(value: String) { context = value; attempted.clear(); historyWindows = 0 }
    @Synchronized fun stop() { context = null; attempted.clear(); historyWindows = 0 }
    @Synchronized fun record(values: List<String>) { attempted.addAll(values.take((240 - attempted.size).coerceAtLeast(0))) }
    @Synchronized fun claimHistory(value: String): Boolean {
        if (context != value || attempted.size >= 240 || historyWindows >= 2) return false
        historyWindows++
        return true
    }
    @Synchronized fun claim(value: String, candidates: List<String>): Boolean {
        if (context != value || attempted.size >= 240) return false
        val batch = candidates.take(24)
        if (batch.none { it !in attempted }) return false
        record(batch)
        return true
    }
}
