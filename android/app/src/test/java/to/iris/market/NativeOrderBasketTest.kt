package to.iris.market

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
    @Test fun orderHistoryAndDetailUseTheTotalForRepeatedUnits() {
        val item = OrderItem("desk", "Desk", "8", "EUR", 2)
        val order = MarketOrder("o", "b", "s", listOf(item), "", "accepted", 0, 0,
            Shipment(emptyList(), null, null, null), false, "sent", null, false)
        assertEquals("€16", order.formattedPrice)
        val converted = PriceDisplay(12.0, "SATS", true, false)
        assertEquals(converted.copy(amount = 24.0).formatted, order.copy(displayPrice = converted).formattedPrice)
        val basket = order.copy(items = listOf(item, item.copy(id = "chair")), displayPrice = converted)
        assertEquals(converted.formatted, basket.formattedPrice)
    }
    @Test fun courierBookingBelongsToTheChosenOrganizer() {
        val stop = DeliveryStop("pickup", "Pickup", "Shop", null, null, "pending")
        val order = MarketOrder("id", "buyer", "seller", emptyList(), "", "accepted", 0, 0,
            Shipment(listOf(stop), null, null, null), false, "sent", null, false)
        assertTrue(order.canBookCourier("buyer"))
        assertFalse(order.canBookCourier("seller"))
        assertTrue(order.copy(fulfillment = "buyer-courier").canBookCourier("buyer"))
        val pickup = order.copy(fulfillment = "pickup")
        assertFalse(pickup.canBookCourier("buyer"))
        assertFalse(pickup.canBookCourier("seller"))
        val sale = order.copy(fulfillment = "merchant-delivery", shipment = order.shipment.copy(stops = emptyList()))
        assertTrue(sale.canBookCourier("seller"))
        assertFalse(sale.canBookCourier("buyer"))
        assertFalse(sale.canBookCourier("stranger"))
        assertFalse(sale.copy(status = "requested").canBookCourier("seller"))
        assertFalse(sale.copy(pickupAuthorization = PickupAuthorization("courier", "ref")).canBookCourier("seller"))
        assertFalse(sale.copy(deliveryOrderId = "existing").canBookCourier("seller"))
        assertFalse(sale.copy(fulfillment = null).canBookCourier("buyer"))
    }
    @Test fun checkoutOffersFulfillmentAndEscrowOnlyForEligibleGoods() {
        val listing = Listing(id = "seller:desk", author = "seller", title = "Desk", description = "", side = "offer",
            price = "12", currency = "EUR", location = "", category = "Home", imageUrl = null, saved = false, mine = false,
            status = "active", delivery = "sent", relevance = null, relevanceShow = null)
        assertTrue(listing.isGoodsOffer)
        assertFalse(listing.acceptsEscrowOrder)
        assertFalse(listing.copy(category = " Services ").isGoodsOffer)
        assertFalse(listing.copy(side = "request").isGoodsOffer)
        val goods = listing.copy(escrow = EscrowOffer("goods", null, ""))
        assertTrue(goods.acceptsEscrowOrder)
        assertFalse(goods.copy(status = "closed").acceptsEscrowOrder)
        assertFalse(goods.copy(mine = true).acceptsEscrowOrder)
        assertTrue(goods.copy(category = "Services").isGoodsOffer)
        assertFalse(goods.copy(tags = listOf("passenger")).isGoodsOffer)
    }
}
