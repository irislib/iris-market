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
}
