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
    @Synchronized fun canReview(value: String, candidates: Iterable<String>, batchSize: Int = 24): Boolean {
        // New arrivals may fill the core batch after this snapshot was read.
        if (batchSize <= 0 || remainingBudget(value) < batchSize) return false
        // Inspect only the prefix the core could receive. Planning can reorder it:
        // the caller records the actual batch once the core has selected it.
        return candidates.asSequence().take(batchSize).any { it !in attempted }
    }
}
