package to.iris.market

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OrderProjectionTest {
    private fun order() = JSONObject("""{
      "id":"buyer:order","buyer":"buyer","seller":"seller","items":[{"id":"seller:listing","title":"Local delivery","price":"12","currency":"EUR","quantity":2}],
      "note":"Leave at reception","status":"accepted","createdAt":1700000000,"updatedAt":1700000001,
      "shipment":{"stops":[{"id":"pickup","label":"Pickup","address":"Shop","coordinates":[24.94,60.17],"courierPubkey":"courier","status":"pending"}],"eta":1700003600},
      "archived":false,"sync":"queued","role":"courier","locationFresh":false
    }""")
    @Test fun distinguishesCurrentAndEarlierPickupReceipts() {
        val base = order()
        val previous = JSONObject().put("reference", "previous").put("collectedAt", 1000).put("confirmedAt", 1005)
        val pending = JSONObject().put("state", "awaiting-confirmation").put("collectedAt", 1100)
        val value = MarketOrder.parse(base.put("pickupReceiptRole", "merchant").put("pickupReceipt", pending)
            .put("previousPickupReceipts", org.json.JSONArray().put(previous)))
        assertEquals("merchant", value.pickupReceiptRole)
        assertEquals(PickupReceipt("awaiting-confirmation", 1100, null), value.pickupReceipt)
        assertEquals(listOf(PreviousPickupReceipt("previous", 1000, 1005)), value.previousPickupReceipts)
        val finished = MarketOrder.parse(base.put("status", "delivered")
            .put("pickupReceipt", pending.put("state", "confirmed").put("confirmedAt", 1110)))
        assertEquals(1110L, finished.pickupReceipt?.confirmedAt)
        assertNull(MarketOrder.parse(order()).pickupReceipt)
    }

    @Test fun parsesSharedCamelCaseOrderWithoutExposingParticipantsToMap() {
        val value = MarketOrder.parse(order())
        assertTrue(value.handoffs.isEmpty())
        assertNull(value.fulfillment)
        assertEquals("merchant-delivery", MarketOrder.parse(order().put("fulfillment", "merchant-delivery")).fulfillment)
        assertEquals("Local delivery", value.title)
        assertEquals(2, value.items.single().quantity)
        assertEquals("Accepted", value.statusLabel)
        assertTrue(value.handlesDelivery("courier"))
        assertFalse(value.handlesDelivery("other"))
        val map = value.shipment.mapProjection()
        assertFalse(map.has("buyer")); assertFalse(map.has("seller"))
        val stop = map.getJSONArray("stops").getJSONObject(0)
        assertFalse(stop.has("courierPubkey"))
        assertEquals(24.94, stop.getJSONArray("coordinates").getDouble(0), 0.0001)
    }
    @Test fun readsOnlySupportedHandoffActions() {
        val rows = org.json.JSONArray("""[{"kind":"pickup","action":"checked"},{"kind":"dropoff","action":"show"},{"kind":"return","action":"scan"},{"kind":"pickup","action":"future"}]""")
        assertEquals(listOf(OrderHandoff("pickup","checked"), OrderHandoff("dropoff","show")), MarketOrder.parse(order().put("handoffs", rows)).handoffs)
    }
    @Test fun onlyTheSelectedOrderAndProviderMatchItsInvitation() {
        val direct = MarketOrder.parse(order())
        assertNull(direct.escrowTradeId)
        val linked = MarketOrder.parse(order().put("escrowTradeId", "trade").put("escrowProvider", "provider"))
        val card = EscrowInboxCard("trade", "Local delivery", listOf("buyer", "seller", "provider"),
            "seller:listing", 24, "", "buyer:order")
        assertTrue(card.matches(linked))
        assertFalse(card.copy(id="other").matches(linked))
        assertFalse(card.copy(orderId="buyer:different").matches(linked))
        assertFalse(card.copy(participants=listOf("buyer", "seller", "uninvited")).matches(linked))
    }
    @Test fun expiredLocationsAndInvalidCoordinatesDoNotReachMap() {
        val raw = order()
        raw.getJSONObject("shipment").put("location", JSONObject().put("coordinates", org.json.JSONArray(listOf(24.94,60.17))).put("at", System.currentTimeMillis()/1000-121))
        raw.getJSONObject("shipment").getJSONArray("stops").getJSONObject(0).put("coordinates", org.json.JSONArray(listOf(181.0,60.17)))
        val value = MarketOrder.parse(raw)
        assertNull(value.shipment.stops.single().coordinates)
        assertFalse(value.shipment.mapProjection().has("location"))
    }
    @Test fun cashuPaymentUsesStructuredMetadataWithoutShowingBearerText() {
        val payment = CashuPayment.parse(JSONObject().put("token", "cashuA-test-only").put("amount", "123").put("mint", "https://mint.example").put("unit", "sat").put("status", "unverified"))
        assertEquals("123 sats", payment.displayAmount)
        assertEquals("mint.example", payment.mintLabel)
        assertFalse(payment.displayAmount.contains(payment.token))
    }
    @Test fun snapshotIncludesOrdersAndAuthenticatedMessageOrderLink() {
        val raw = JSONObject().put("orders", org.json.JSONArray().put(order())).put("conversations", org.json.JSONArray().put(JSONObject()
            .put("id", "seller").put("messages", org.json.JSONArray().put(JSONObject().put("id", "message").put("text", "Order accepted").put("mine", false).put("order_id", "buyer:order")))))
        val state = MarketSnapshot.parse(raw.toString())
        assertFalse(state.liveLocationSupported)
        assertTrue(MarketSnapshot.parse(raw.put("live_location_supported", true).toString()).liveLocationSupported)
        assertEquals("buyer:order", state.orders.single().id)
        assertEquals("buyer:order", state.conversations.single().messages.single().orderId)
    }
}
