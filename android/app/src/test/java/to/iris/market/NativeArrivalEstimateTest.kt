package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeArrivalEstimateTest {
    @Test fun destinationEstimateBoundariesAndVisibility() {
        val now = 1_800_000_000L
        val cases = listOf(-1L to "Taking longer than expected", 0L to "Taking longer than expected", 1L to "Less than a minute", 59L to "Less than a minute", 60L to "About 1 min", 61L to "About 2 min", 120L to "About 2 min", 3599L to "About 1 hr", 3600L to "About 1 hr", 3601L to "About 1 hr 1 min", 86400L to "About 1 day", 90000L to "About 2 days", 172800L to "About 2 days")
        for ((seconds, expected) in cases) for (status in listOf("accepted", "in-transit")) assertEquals(expected, marketArrivalEstimate(now + seconds, status, now))
        for (status in listOf("requested", "delivered", "cancelled", "unknown")) assertNull(marketArrivalEstimate(now + 120, status, now))
        for (eta in listOf(null, 0L, -1L, Long.MAX_VALUE)) assertNull(marketArrivalEstimate(eta, "accepted", now))
        assertNull(marketArrivalEstimate(now, "accepted", Long.MIN_VALUE))
    }
}
