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
        assertFalse(search.canReview("a", listOf("first")))
        search.start("a")
        assertFalse(search.canReview("b", listOf("first")))
        assertFalse(search.canReview("a", emptyList()))
        assertTrue(search.canReview("a", listOf("first|1")))
        search.record(listOf("first|1"))
        assertFalse(search.canReview("a", listOf("first|1")))
        assertTrue(search.canReview("a", listOf("first|2")))
        search.stop()
        assertFalse(search.canReview("a", listOf("late")))
    }
    @Test fun boundedBatchesAndExplicitRestart() {
        val search = NativeSearchContinuation()
        search.start("new")
        repeat(10) { page ->
            val batch = (0..<24).map { "$page-$it" }
            assertTrue(search.canReview("new", batch))
            search.record(batch)
        }
        assertFalse(search.canReview("new", listOf("over-budget")))
        search.start("a")
        search.record(listOf("already-reviewed"))
        assertFalse(search.canReview("a", listOf("already-reviewed")))
        assertTrue(search.canReview("a", listOf("late-arrival")))
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
        search.record(candidates.drop(12).take(12))
        assertFalse(search.canReview("remote", candidates.drop(12), batchSize = 12))
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
        assertFalse(search.canReview("remote", listOf("last-1", "last-2", "last-3"), batchSize = 12))
        assertEquals(3, search.remainingBudget("remote"))
    }

    @Test fun eligibilityReadsOnlyTheAuthorizedPrefixAndRecordsTheSelectedBatch() {
        for (batchSize in listOf(12, 24)) {
            val search = NativeSearchContinuation()
            var visits = 0
            val revisions = (0 until 1024).asSequence().map { visits++; "listing-$it" }.asIterable()
            assertFalse(search.canReview("search", revisions, batchSize))
            assertEquals(0, visits)
            search.start("search")
            assertTrue(search.canReview("search", revisions, batchSize))
            assertEquals(1, visits)

            // The planner moved different listings to the front. Only their reviews spend the budget.
            search.record((100 until 100 + batchSize).map { "listing-$it" })
            assertEquals(240 - batchSize, search.remainingBudget("search"))
            assertTrue(search.canReview("search", revisions, batchSize))
            search.record((0 until batchSize).map { "listing-$it" })
            visits = 0
            assertFalse(search.canReview("search", revisions, batchSize))
            assertEquals(batchSize, visits)
            search.stop()
            visits = 0
            assertFalse(search.canReview("search", revisions, batchSize))
            assertEquals(0, visits)
        }
    }

}
