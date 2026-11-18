import Foundation

/// Synthetic projections only. This executable has no networking, wallet, identity or location access.
@main struct OrderModelChecks {
    static var checks = 0
    static func check(_ value: @autoclosure () -> Bool, _ message: String) {
        checks += 1
        if !value() { fatalError(message) }
    }
    static func main() throws {
        let source = #"{"id":"order-1","buyer":"buyer","seller":"seller","items":[{"id":"listing","title":"Lamp","price":"12","currency":"EUR","quantity":2}],"note":"Private note","status":"accepted","createdAt":1000,"updatedAt":1100,"shipment":{"stops":[{"id":"stop-1","label":"Pickup","address":"Private address","coordinates":[24.9,60.2],"courierPubkey":"courier","status":"pending"}],"trackingUrl":"https://example.invalid/private","eta":1400,"location":{"coordinates":[24.8,60.1],"at":1180,"courierPubkey":"courier","stopId":"stop-1"}},"archived":false,"role":"seller","sync":"queued","locationFresh":true}"#
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let order = try decoder.decode(MarketOrder.self, from: Data(source.utf8))
        check(order.createdAt == 1000 && order.shipment.trackingUrl != nil, "Camel-case order fields must decode through the main snapshot decoder")
        check(order.items[0].formattedPrice == "€12", "Order price formatting")
        check(order.statusLabel == "Accepted" && !order.terminal, "Order status presentation")
        check(MarketOrderList.purchases.contains(order, owner: "buyer"), "Buyer purchases")
        check(MarketOrderList.sales.contains(order, owner: "seller"), "Seller sales")
        check(MarketOrderList.deliveries.contains(order, owner: "courier"), "Courier deliveries")
        check(!MarketOrderList.archived.contains(order, owner: "seller"), "Active order stays out of archive")
        check(!MarketOrderList.deliveries.contains(order, owner: "unrelated"), "Unassigned identity has no courier item")
        let map = order.shipment.mapProjection(now: 1200)
        let mapJSON = String(decoding: try JSONSerialization.data(withJSONObject: map), as: UTF8.self)
        check(map["location"] != nil, "Fresh location appears")
        check(!mapJSON.contains("courierPubkey") && !mapJSON.contains("trackingUrl") && !mapJSON.contains("order-1") && !mapJSON.contains("Private note"), "Map receives no identities, order metadata or tracking URL")
        check(order.shipment.mapProjection(now: 1300)["location"] == nil, "Location expires at exactly two minutes")
        check(order.shipment.mapProjection(now: 1179)["location"] == nil, "Future location is hidden")
        check(!MarketShipment.validCoordinates([181, 60]) && !MarketShipment.validCoordinates([24, .nan]) && !MarketShipment.validCoordinates([24]), "Coordinates are bounded and finite")
        var draft = MarketStopDraft(stop: order.shipment.stops[0])
        let patch = try marketRoutePatch(stops: [draft], tracking: "https://example.invalid/tracking", eta: Date(timeIntervalSince1970: 1500))
        let shipment = patch["shipment"] as! [String: Any]
        let stop = (shipment["stops"] as! [[String: Any]])[0]
        check(stop["courierPubkey"] as? String == "courier" && stop["courier_pubkey"] == nil, "Route wire keys stay camelCase")
        check((stop["coordinates"] as? [Double]) == [24.9, 60.2], "Route coordinates use longitude then latitude")
        check(shipment["location"] == nil, "Route edits never include live location")
        draft.latitude = "NaN"
        do { _ = try draft.projection(); fatalError("Invalid map position accepted") } catch { checks += 1 }
        do { _ = try marketRoutePatch(stops: [], tracking: "https://user:secret@example.invalid", eta: nil); fatalError("Credential-bearing link accepted") } catch { checks += 1 }
        do { _ = try marketRoutePatch(stops: Array(repeating: MarketStopDraft(), count: 13), tracking: "", eta: nil); fatalError("Overlong route accepted") } catch { checks += 1 }
        let cashu = try decoder.decode(CashuPayment.self, from: Data(#"{"token":"synthetic-not-redeemable","amount":"120","mint":"https://mint.example.invalid","unit":"sat","status":"unverified"}"#.utf8))
        check(cashu.formattedAmount == "120 sats" && cashu.mintLabel == "mint.example.invalid" && cashu.status == "unverified", "Cashu card amount and unverified state")
        let testCashu = try decoder.decode(CashuPayment.self, from: Data(#"{"token":"synthetic-not-redeemable","amount":"128","mint":"https://testnut.cashu.space","unit":"sat","status":"unverified"}"#.utf8))
        check(testCashu.formattedAmount == "128 test sats" && testCashu.isTestMoney, "Test tokens must remain separate from real sats")
        var checkout = try JSONSerialization.jsonObject(with: Data(source.utf8)) as! [String: Any]
        func product(_ choice: MarketFulfillment?, status: String = "accepted", address: String? = nil, extra: [String: Any] = [:]) throws -> MarketOrder {
            var product = checkout
            product["fulfillment"] = choice?.rawValue
            product["status"] = status
            product["shipment"] = ["stops": address.map { [["id": "p", "label": "Pickup", "address": $0, "status": "pending"]] } ?? []]
            product.merge(extra) { _, updated in updated }
            return try decoder.decode(MarketOrder.self, from: JSONSerialization.data(withJSONObject: product))
        }
        check(order.handoffs == nil, "Previous snapshots decode without a handoff")
        for (kind, action, expected) in [("pickup", "show", "Show collection code"), ("pickup", "scan", "Scan collection code"), ("dropoff", "checked", "Receipt checked")] {
            let handoff = try product(.pickup, extra: ["handoffs": [["kind": kind, "action": action]]])
            check(handoff.handoffs?.first?.buttonLabel == expected, "A handoff exposes only the action projected by the core")
        }
        check(MarketOrderHandoff(kind: "pickup", action: "future").buttonLabel == nil && MarketOrderHandoff(kind: "unknown", action: "show").buttonLabel == nil, "Unknown handoffs expose no actions")
        check(MarketOrderHandoff.passInput("lightning:invoice") == nil && MarketOrderHandoff.passInput("iris-handoff:1:private\nvalue") == nil && MarketOrderHandoff.passInput("iris-handoff:1:" + String(repeating: "a", count: 220)) == nil, "Reject unrelated, multiline and oversized QR input before verification")
        let merchantDelivery = try product(.merchantDelivery)
        check(merchantDelivery.canBookMerchantCourier("seller") && !merchantDelivery.canBookMerchantCourier("buyer"), "Only the merchant can book merchant delivery")
        check(!merchantDelivery.canBookBuyerCourier("buyer"), "Merchant delivery never prompts the buyer to book")
        for choice in [MarketFulfillment.buyerCourier, nil] {
            let awaitingPickup = try product(choice, address: " ")
            let pickupShared = try product(choice, address: "Synthetic meeting point")
            check(!awaitingPickup.canBookBuyerCourier("buyer") && pickupShared.canBookBuyerCourier("buyer"), "Buyer or legacy courier needs the seller's pickup address")
            check(!pickupShared.canBookBuyerCourier("courier") && !pickupShared.canBookMerchantCourier("seller"), "Only the selected organizer books")
        }
        check(MarketFulfillment.buyerCourier.rawValue == "buyer-courier" && MarketFulfillment.buyerCourier.checkoutLabel == "I’ll arrange my own delivery" && MarketFulfillment.buyerCourier.label == "Buyer arranges delivery", "Buyer choice and shared order use role-appropriate delivery terms")
        let collected = try product(.pickup, status: "delivered")
        let awaitingCollection = try product(.pickup, status: "in-transit")
        let delivered = try product(nil, status: "delivered")
        check(collected.isPickup && collected.statusLabel == "Collected" && awaitingCollection.statusLabel == "Awaiting collection", "Current and older pickup orders show collection progress")
        check(!delivered.isPickup && delivered.statusLabel == "Delivered", "Legacy delivery completion stays delivered")
        let pickupOrder = try product(.pickup, address: "Synthetic meeting point")
        check(!pickupOrder.canBookBuyerCourier("buyer") && !pickupOrder.canBookMerchantCourier("seller"), "Pickup requires no courier")
        for status in ["requested", "cancelled", "delivered"] {
            let unavailable = try product(.merchantDelivery, status: status)
            check(!unavailable.canBookMerchantCourier("seller"), "Unavailable orders cannot book a courier")
        }
        for extra: [String: Any] in [
            ["deliveryOrderId": "separate-order"], ["pickupAuthorization": ["courierPubkey": "courier", "reference": "ref"]],
            ["shipment": checkout["shipment"]!],
            ["deliveryRequest": ["pickup": ["label": "Pickup", "address": "Here"], "destination": ["label": "Destination", "address": "There"]]]
        ] {
            let allocated = try product(.merchantDelivery, extra: extra)
            check(!allocated.canBookMerchantCourier("seller"), "A service order or an existing courier booking must not be booked again")
        }
        check(order.escrowTradeId == nil && order.escrowProvider == nil, "Existing direct orders have no escrow")
        var protected = checkout
        protected["escrowTradeId"] = "trade-fixture"
        protected["escrowProvider"] = "provider-fixture"
        let linked = try decoder.decode(MarketOrder.self, from: JSONSerialization.data(withJSONObject: protected))
        check(linked.escrowTradeId == "trade-fixture" && linked.escrowProvider == "provider-fixture", "Checkout keeps the exact trade and provider")
        checkout["payment"] = ["mint": "https://testnut.cashu.space", "amount": "16", "unit": "sat", "status": "requested"]
        checkout["deliveryRequest"] = ["pickup": ["label": "Shop", "address": "Shop entrance", "coordinates": [24.9, 60.2]], "destination": ["label": "Home", "address": "Private meeting point"], "collection": ["merchant": "seller", "reference": "opaque-reference"]]
        checkout["pickupAuthorization"] = ["courierPubkey": "courier", "reference": "opaque-reference"]
        checkout["sourceOrderId"] = "source-local-only"; checkout["deliveryOrderId"] = "delivery-local-only"
        checkout["display_price"] = ["amount": 13.0, "currency": "USD", "stale": false]
        let decoded = try decoder.decode(MarketOrder.self, from: JSONSerialization.data(withJSONObject: checkout))
        check(decoded.payment?.amount == "16" && decoded.deliveryRequest?.collection?.reference == "opaque-reference", "Separate delivery request and payment decode")
        check(decoded.pickupAuthorization?.courierPubkey == "courier" && decoded.sourceOrderId == "source-local-only" && decoded.deliveryOrderId == "delivery-local-only", "Authorization and local links decode")
        check(decoded.formattedTotal == "€24" && decoded.formattedTotal != decoded.formattedPrice, "Two €12 units show €24 due rather than a converted unit price")
        check(decoded.displayPrice?.currency == "USD", "Selected display currency is a local order projection")
        let request = try decoded.deliveryRequest!.projection()
        let privateJSON = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        check(!privateJSON.contains("sourceOrderId") && !privateJSON.contains("deliveryOrderId") && !privateJSON.contains("source-local-only"), "Local links never enter delivery request payload")
        do { _ = try MarketDeliveryPlace(label: "Destination").projection(); fatalError("Empty destination accepted") } catch { checks += 1 }
        do { _ = try MarketDeliveryPlace(label: "Destination", address: "Entrance", coordinates: [181, 60]).projection(); fatalError("Invalid destination coordinates accepted") } catch { checks += 1 }
        print("\(checks) native order projection checks passed.")
    }
}
