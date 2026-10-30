package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeTransportTest {
    @Test fun classifiesOnlyExplicitServiceTopics() {
        assertNull(NativeTransportType.classify(listOf("car", "transport")))
        assertEquals(NativeTransportType.PARCEL, NativeTransportType.classify(listOf("courier")))
        assertEquals(NativeTransportType.PASSENGER, NativeTransportType.classify(listOf("courier", "passenger")))
        assertEquals(NativeTransportType.BOTH, NativeTransportType.classify(listOf("parcel", "passenger")))
        assertEquals(NativeTransportType.PASSENGER, NativeTransportType.classify(listOf(" ＲＩＤＥＳ ")))
        NativeTransportType.entries.forEach { assertEquals(it, NativeTransportType.classify(it.tags)) }
        assertTrue(NativeTransportType.PARCEL.includes(listOf("parcel", "passenger")))
        assertFalse(NativeTransportType.PASSENGER.includes(listOf("parcel")))
        assertFalse(NativeTransportType.BOTH.includes(listOf("cars")))
    }
    @Test fun lateArrivalNeedsSubmittedQueryAndStopsOnCancel() {
        val search = NativeSearchContinuation()
        assertFalse(search.claim("a", listOf("first")))
        search.start("a")
        assertFalse(search.claim("b", listOf("first")))
        assertFalse(search.claim("a", emptyList()))
        assertTrue(search.claim("a", listOf("first|1")))
        assertFalse(search.claim("a", listOf("first|1")))
        assertTrue(search.claim("a", listOf("first|2")))
        search.stop()
        assertFalse(search.claim("a", listOf("late")))
    }
    @Test fun boundedBatchesAndExplicitRestart() {
        val search = NativeSearchContinuation()
        search.start("new")
        repeat(10) { page -> assertTrue(search.claim("new", (0..<24).map { "$page-$it" })) }
        assertFalse(search.claim("new", listOf("over-budget")))
        search.start("a")
        search.record(listOf("already-reviewed"))
        assertFalse(search.claim("a", listOf("already-reviewed")))
        assertTrue(search.claim("a", listOf("late-arrival")))
    }
    @Test fun boundedHistoryWindowsResetOnlyForExplicitIntent() {
        val search = NativeSearchContinuation()
        assertFalse(search.claimHistory("a"))
        search.start("a")
        assertTrue(search.claimHistory("a"))
        assertTrue(search.claimHistory("a"))
        assertFalse(search.claimHistory("a"))
        search.stop()
        assertFalse(search.claimHistory("a"))
        search.start("a")
        assertTrue(search.claimHistory("a"))
    }

    @Test fun remoteBatchesCountOnlyActualTwelveDecisions() {
        val search = NativeSearchContinuation()
        search.start("remote")
        val candidates = (0 until 36).map { "revision-$it" }
        assertTrue(search.canReview("remote", candidates, batchSize = 12))
        // Merely checking eligibility must not spend the budget or reserve a guessed batch.
        assertTrue(search.canReview("remote", candidates, batchSize = 12))
        search.record(candidates.take(12))
        assertFalse(search.canReview("remote", candidates, batchSize = 12))
        assertTrue(search.canReview("remote", candidates.drop(12), batchSize = 12))
        assertTrue(search.claim("remote", candidates.drop(12), batchSize = 12))
        assertFalse(search.claim("remote", candidates.drop(12), batchSize = 12))
        assertTrue(search.canReview("remote", candidates.drop(24), batchSize = 12))
        search.stop()
        assertFalse(search.canReview("remote", candidates.drop(24), batchSize = 12))
    }
    @Test fun twentyRemoteBatchesReachTheSharedActionBudget() {
        val search = NativeSearchContinuation()
        search.start("remote")
        repeat(20) { page ->
            val batch = (0 until 12).map { "$page-$it" }
            assertTrue(search.canReview("remote", batch, batchSize = 12))
            search.record(batch)
        }
        assertFalse(search.canReview("remote", listOf("late"), batchSize = 12))
        assertFalse(search.claimHistory("remote"))
        search.start("remote")
        assertTrue(search.canReview("remote", listOf("late"), batchSize = 12))
    }

    @Test fun aPartialFirstBatchCannotAuthorizeMoreThanRemainingBudget() {
        val search = NativeSearchContinuation()
        search.start("remote")
        search.record((0 until 237).map { "reviewed-$it" })
        assertEquals(3, search.remainingBudget("remote"))
        assertFalse(search.canReview("remote", (0 until 12).map { "late-$it" }, batchSize = 12))
        assertFalse(search.claim("remote", (0 until 12).map { "late-$it" }, batchSize = 12))
        assertFalse(search.canReview("remote", listOf("last-1", "last-2", "last-3"), batchSize = 12))
        assertFalse(search.claim("remote", listOf("last-1", "last-2", "last-3"), batchSize = 12))
        assertEquals(3, search.remainingBudget("remote"))
    }

}
