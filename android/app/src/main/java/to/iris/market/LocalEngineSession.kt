package to.iris.market

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** One verified engine per active search, with fresh conversations for each review. */
internal class LocalEngineSession<E : AutoCloseable, F : Any>(
    private val scope: CoroutineScope,
    private val fileIdentity: () -> F,
    private val verify: suspend () -> Unit,
    private val create: () -> E,
    private val initialize: (E) -> Unit,
    private val idleMillis: Long = 10_000,
    private val afterUse: () -> Unit = {},
) {
    private data class Entry<E, F>(val epoch: Long, val run: Long?, val file: F, val engine: E)
    private val mutex = Mutex() // Exclusive ownership through initialization, inference and close.
    private val lifecycle = Any()
    @Volatile private var epoch = 0L
    private var active: Job? = null
    private var entry: Entry<E, F>? = null
    private var idle: Job? = null

    init {
        scope.coroutineContext.job.invokeOnCompletion { invalidate() }
    }

    /** Cancel without blocking the UI. File mutations join cleanup before changing the path. */
    fun invalidate(): Job {
        val cancelled = synchronized(lifecycle) {
            epoch++
            active
        }
        cancelled?.cancel()
        return scope.launch(NonCancellable + Dispatchers.IO) {
            mutex.withLock { if (entry?.epoch != epoch) clear() }
        }
    }

    private fun clear() {
        idle?.cancel()
        idle = null
        val old = entry
        entry = null
        old?.let { runCatching { it.engine.close() } }
    }

    val revision: Long get() = epoch

    suspend fun <R> use(run: Long?, submitted: Long = revision, review: suspend (E) -> R): R = coroutineScope {
        val operation = coroutineContext.job
        mutex.withLock {
            synchronized(lifecycle) {
                if (submitted != epoch || !scope.isActive) throw CancellationException("Model use ended")
                active = operation
            }
            idle?.cancel()
            idle = null
            var completed = false
            try {
                val file = fileIdentity()
                val previous = entry
                if (previous == null || previous.epoch != submitted || run == null || previous.run != run || previous.file != file) {
                    clear()
                    verify()
                    ensureActive()
                    check(fileIdentity() == file) { "Model changed during verification" }
                    val engine = create()
                    entry = Entry(submitted, run, file, engine)
                    initialize(engine)
                    ensureActive()
                    check(fileIdentity() == file) { "Model changed while loading" }
                }
                val result = review(checkNotNull(entry).engine)
                ensureActive()
                completed = true
                result
            } finally {
                synchronized(lifecycle) { active = null }
                if (completed && run != null && submitted == epoch && scope.isActive) {
                    idle = scope.launch(Dispatchers.IO) {
                        delay(idleMillis)
                        mutex.withLock { clear() }
                    }
                } else clear()
                afterUse()
            }
        }
    }
}
