package to.iris.market

/** Only a submitted search authorizes late-arrival review; stop clears that authority. */
class NativeSearchContinuation {
    private var context: String? = null
    private val attempted = mutableSetOf<String>()
    private var historyWindows = 0
    @Synchronized fun start(value: String) { context = value; attempted.clear(); historyWindows = 0 }
    @Synchronized fun stop() { context = null; attempted.clear(); historyWindows = 0 }
    @Synchronized fun record(values: List<String>) { attempted.addAll(values.take((240 - attempted.size).coerceAtLeast(0))) }
    @Synchronized fun remainingBudget(value: String): Int = if (context == value) (240 - attempted.size).coerceAtLeast(0) else 0
    @Synchronized fun claimHistory(value: String): Boolean {
        if (context != value || attempted.size >= 240 || historyWindows >= 2) return false
        historyWindows++
        return true
    }
    @Synchronized fun canReview(value: String, candidates: List<String>, batchSize: Int = 24): Boolean {
        if (context != value || attempted.size >= 240 || batchSize <= 0) return false
        // Core selects a prefix, so skipping attempted entries would claim work it will not receive.
        val batch = candidates.take(batchSize)
        // New arrivals may fill the core batch after this snapshot was read.
        return batchSize <= remainingBudget(value) && batch.any { it !in attempted }
    }
    @Synchronized fun claim(value: String, candidates: List<String>, batchSize: Int = 24): Boolean {
        if (!canReview(value, candidates, batchSize)) return false
        val batch = candidates.take(batchSize)
        if (batch.none { it !in attempted }) return false
        record(batch)
        return true
    }
}
