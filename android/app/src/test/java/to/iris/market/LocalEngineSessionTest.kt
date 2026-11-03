package to.iris.market

import java.util.concurrent.atomic.AtomicInteger
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class LocalEngineSessionTest {
    private class Rig(idleMillis: Long = 10_000) {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var inode = 1L
        var valid = true
        var afterVerify: suspend () -> Unit = {}
        var initialize: () -> Unit = {}
        val verified = AtomicInteger()
        val opened = AtomicInteger()
        val closed = AtomicInteger()
        val session = LocalEngineSession(scope, { inode }, {
            verified.incrementAndGet()
            check(valid)
            afterVerify()
        }, {
            opened.incrementAndGet()
            AutoCloseable { closed.incrementAndGet() }
        }, { initialize() }, idleMillis)

        suspend fun finish() {
            session.invalidate().join()
            scope.cancel()
            assertEquals(opened.get(), closed.get())
        }
    }

    @Test fun allTenContinuationBatchesShareOneVerifiedEngine() = runBlocking {
        val r = Rig()
        try {
            val search = NativeSearchContinuation()
            search.start("bicycle")
            val rows = (0 until 240).map { "signed-$it" }
            var reviewed = 0
            while (search.canReview("bicycle", rows.drop(reviewed))) {
                r.session.use(search.runFor("bicycle")) {
                    val batch = rows.drop(reviewed).take(24)
                    search.record(batch)
                    reviewed += batch.size
                }
            }
            assertEquals(240, reviewed)
            assertEquals(1, r.verified.get())
            assertEquals(1, r.opened.get())
            assertEquals(0, r.closed.get())
            // Even the same query explicitly resubmitted is a fresh run.
            search.start("bicycle")
            r.session.use(search.runFor("bicycle")) { }
            assertEquals(2, r.verified.get())
            assertEquals(1, r.closed.get())
            // An isolated Settings check must never borrow or retain the search engine.
            r.session.use(null) { }
            assertEquals(3, r.opened.get())
            assertEquals(3, r.closed.get())
        } finally { r.finish() }
    }

    @Test fun replacementReverifiesAndRejectsCorruptOrChangingFiles() = runBlocking {
        val r = Rig()
        try {
            r.session.use(1) { }
            r.inode++ // Same-length replacement at the same path.
            r.session.use(1) { }
            assertEquals(2, r.verified.get())
            assertEquals(1, r.closed.get())
            r.inode++
            r.valid = false
            assertTrue(runCatching { r.session.use(1) { fail() } }.exceptionOrNull() is IllegalStateException)
            assertEquals(2, r.opened.get())
            assertEquals(2, r.closed.get())
            r.valid = true
            r.afterVerify = { r.inode++ }
            assertTrue(runCatching { r.session.use(1) { fail() } }.exceptionOrNull() is IllegalStateException)
            assertEquals(2, r.opened.get())
            r.afterVerify = {}
            r.initialize = { r.inode++ }
            assertTrue(runCatching { r.session.use(1) { fail() } }.exceptionOrNull() is IllegalStateException)
            assertEquals(3, r.closed.get())
            r.initialize = { error("Native engine failed to initialize") }
            assertTrue(runCatching { r.session.use(1) { fail() } }.isFailure)
            assertEquals(4, r.closed.get())
            r.initialize = {}
            r.session.use(1) { }
            assertEquals(7, r.verified.get())
        } finally { r.finish() }
    }

    @Test fun sameSizedFileReplacedAtTheSamePathMustPassThePinnedHashAgain() = runBlocking {
        val directory = Files.createTempDirectory("model-test")
        val file = directory.resolve("model")
        val incoming = directory.resolve("replacement")
        val bytes = "a model".toByteArray()
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun replace(content: ByteArray) {
            Files.write(incoming, content)
            Files.move(incoming, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        var verified = 0
        var opened = 0
        var closed = 0
        val session = LocalEngineSession(scope,
            { Files.readAttributes(file, BasicFileAttributes::class.java).fileKey() },
            { verified++; Files.newInputStream(file).use { LocalModelContract.copyVerified(it, null, bytes.size.toLong(), hash) } },
            { opened++; AutoCloseable { closed++ } }, {})
        try {
            replace(bytes)
            session.use(1) {}
            session.use(1) {}
            replace("corrupt".toByteArray())
            assertTrue(runCatching { session.use(1) { fail() } }.exceptionOrNull() is IllegalArgumentException)
            assertEquals(1, opened)
            assertEquals(1, closed)
            replace(bytes)
            session.use(1) {}
            assertEquals(3, verified)
            assertEquals(2, opened)
        } finally {
            session.invalidate().join()
            scope.cancel()
            Files.deleteIfExists(incoming)
            Files.deleteIfExists(file)
            Files.delete(directory)
        }
    }

    @Test fun stopCancelsActiveAndQueuedWorkWithoutClosingAnEngineInUse() = runBlocking {
        val r = Rig()
        try {
            val entered = CompletableDeferred<Unit>()
            val active = launch(start = CoroutineStart.UNDISPATCHED) {
                r.session.use(1) {
                    entered.complete(Unit)
                    try { awaitCancellation() } finally { assertEquals(0, r.closed.get()) }
                }
            }
            entered.await()
            val queued = launch(start = CoroutineStart.UNDISPATCHED) {
                r.session.use(1) { fail("A queued call from the stopped search ran") }
            }
            val oldRevision = r.session.revision
            r.session.invalidate().join()
            assertTrue(runCatching { r.session.use(1, oldRevision) { fail() } }.exceptionOrNull() is CancellationException)
            active.join()
            queued.join()
            assertTrue(active.isCancelled)
            assertTrue(queued.isCancelled)
            assertEquals(1, r.closed.get())
            r.session.use(2) { }
            assertEquals(2, r.verified.get())
        } finally { r.finish() }
    }

    @Test fun cancellationWhileVerifyingAndWhileReviewingLeavesNoWarmEngine() = runBlocking {
        val r = Rig()
        try {
            val verifying = CompletableDeferred<Unit>()
            r.afterVerify = { verifying.complete(Unit); awaitCancellation() }
            val job = launch { r.session.use(1) { fail() } }
            verifying.await()
            r.session.invalidate().join()
            job.join()
            assertTrue(job.isCancelled)
            assertEquals(0, r.opened.get())
            r.afterVerify = {}
            val failure = runCatching { r.session.use(2) { withTimeout(40) { awaitCancellation() } } }.exceptionOrNull()
            assertTrue(failure is TimeoutCancellationException)
            assertEquals(1, r.closed.get())
            r.session.use(2) { }
            assertEquals(2, r.opened.get())
        } finally { r.finish() }
    }

    @Test fun ownerTeardownCancelsAnActiveReviewFromAnotherScope() = runBlocking {
        val r = Rig(idleMillis = 60_000)
        try {
            val entered = CompletableDeferred<Unit>()
            val reviewing = launch {
                r.session.use(1) { entered.complete(Unit); awaitCancellation() }
            }
            entered.await()
            r.scope.cancel()
            withTimeout(3_000) { reviewing.join() }
            assertTrue(reviewing.isCancelled)
            assertEquals(1, r.closed.get())
        } finally { r.finish() }
    }

    @Test fun simultaneousBatchesSerializeAndIdleOrTeardownClosesTheEngine() = runBlocking {
        val r = Rig(idleMillis = 50)
        try {
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val first = launch(start = CoroutineStart.UNDISPATCHED) {
                r.session.use(1) { entered.complete(Unit); release.await() }
            }
            entered.await()
            val second = launch(start = CoroutineStart.UNDISPATCHED) {
                r.session.use(1) { assertTrue(release.isCompleted) }
            }
            assertEquals(1, r.opened.get())
            release.complete(Unit)
            joinAll(first, second)
            assertEquals(1, r.opened.get())
            withTimeout(3_000) { while (r.closed.get() == 0) delay(10) }
            r.session.use(1) { }
            assertEquals(2, r.opened.get())
            r.scope.cancel()
            withTimeout(3_000) { while (r.closed.get() < 2) delay(10) }
            assertTrue(runCatching { r.session.use(1) { fail() } }.exceptionOrNull() is CancellationException)
        } finally { r.finish() }
    }
}
