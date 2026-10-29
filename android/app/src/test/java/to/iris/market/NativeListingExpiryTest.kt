package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeListingExpiryTest {
    @Test fun durationStartsWhenPublishingAndExistingDeadlineStaysAbsolute() {
        val opened=1000L; val published=9000L
        assertNull(NativeListingExpiry.NEVER.deadline(published))
        NativeListingExpiry.entries.drop(1).zip(listOf(1L,7L,30L,90L,365L)).forEach { (preset,days) ->
            assertEquals(published+days*86_400,preset.deadline(published))
        }
        assertNotEquals(opened+86_400,NativeListingExpiry.DAY.deadline(published))
        assertEquals(12345L,NativeListingExpiry.resolve(null,12345L,published))
        assertNull(NativeListingExpiry.resolve(null,null,published))
        assertNull(NativeListingExpiry.resolve(NativeListingExpiry.NEVER,12345L,published))
        assertEquals(published+604800,NativeListingExpiry.resolve(NativeListingExpiry.WEEK,12345L,published))
        assertEquals(Long.MAX_VALUE,NativeListingExpiry.DAY.deadline(Long.MAX_VALUE-1))
    }
    @Test fun detailHandlesNoExpiryExactBoundaryAndRelativeUnits() {
        assertEquals("No expiry",NativeListingExpiry.detail(null,1000))
        assertEquals("Expired",NativeListingExpiry.detail(1000,1000))
        assertEquals("Expired",NativeListingExpiry.detail(999,1000))
        assertEquals("Expires in less than a minute",NativeListingExpiry.detail(1001,1000))
        assertEquals("Expires in 1 minute",NativeListingExpiry.detail(1060,1000))
        assertEquals("Expires in 1 day",NativeListingExpiry.detail(87400,1000))
        assertEquals("Expires in 1 week",NativeListingExpiry.detail(605800,1000))
    }
}
