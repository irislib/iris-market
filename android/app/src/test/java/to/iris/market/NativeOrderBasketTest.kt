package to.iris.market

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeOrderBasketTest {
    @Test fun basketLinesShowUnitPriceTimesCount() {
        assertEquals("4000 sats", OrderItem("a", "Mittens", "2000", "SATS", 2).lineDisplayPrice)
        assertEquals("€7.5", OrderItem("b", "Pie", "2.50", "EUR", 3).lineDisplayPrice)
        assertEquals("1500 sats", OrderItem("c", "Scarf", "1500", "SATS", 1).lineDisplayPrice)
        assertEquals("Negotiable", OrderItem("d", "Help", "", "EUR", 2).lineDisplayPrice)
    }
}
