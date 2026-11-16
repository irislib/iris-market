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
    @Test fun basketTotalStaysInTheItemsCurrency() {
        fun order(vararg items: OrderItem) = MarketOrder("o", "b", "s", items.toList(), "", "requested", 0, 0, Shipment(emptyList(), null, null, null), false, "sent", null, false)
        assertEquals("5500 sats", order(OrderItem("a", "Scarf", "1500", "SATS", 1), OrderItem("b", "Mittens", "2000", "SATS", 2)).itemsTotal)
        assertEquals(null, order(OrderItem("a", "Scarf", "3", "EUR", 1), OrderItem("b", "Mittens", "2000", "SATS", 1)).itemsTotal)
        assertEquals(null, order(OrderItem("a", "Scarf", "3", "EUR", 1)).itemsTotal)
    }
}
