package to.iris.market

/** Only a submitted search authorizes late-arrival review; stop clears that authority. */
class NativeSearchContinuation {
    private var context: String? = null
    private val attempted = mutableSetOf<String>()
    @Synchronized fun start(value: String) { context = value; attempted.clear() }
    @Synchronized fun stop() { context = null; attempted.clear() }
    @Synchronized fun record(values: List<String>) { attempted.addAll(values.take((240 - attempted.size).coerceAtLeast(0))) }
    @Synchronized fun claim(value: String, candidates: List<String>): Boolean {
        if (context != value || attempted.size >= 240) return false
        val batch = candidates.take(24)
        if (batch.none { it !in attempted }) return false
        record(batch)
        return true
    }
}
