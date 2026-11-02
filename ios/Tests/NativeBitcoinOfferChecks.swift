import Foundation

@main struct NativeBitcoinOfferChecks {
    static func main() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        var item: [String: Any] = [
            "id": "38383:maker:order", "author": "maker", "title": "Buy bitcoin", "description": "",
            "side": "request", "price": "2.00", "currency": "EUR", "location": "", "category": "Other",
            "created_at": 1, "status": "active", "saved": false, "mine": false, "delivery": "sent",
            "display_price": ["amount": 2.50, "currency": "USD", "approximate": true, "stale": false],
            "escrow": ["trade": "bitcoin_fiat", "sats": 80, "method": "bank_transfer"]
        ]
        func listing() throws -> MarketListing {
            try decoder.decode(MarketListing.self, from: JSONSerialization.data(withJSONObject: item))
        }
        let buy = try listing()
        precondition(buy.formattedPrice == "2.00 EUR" && buy.escrow?.bitcoinTerms == "80 sats · Bank transfer")
        precondition(buy.reviewAddress == "38383:maker:order")
        item["escrow"] = ["trade": "bitcoin_fiat", "sats": 8, "method": "cash"]
        item["side"] = "offer"
        let sell = try listing()
        precondition(sell.formattedPrice == "2.00 EUR" && sell.escrow?.bitcoinTerms == "8 sats · Cash in person")
        item["id"] = "maker:camera"
        item["escrow"] = ["trade": "goods"]
        let goods = try listing()
        precondition(!goods.isBitcoinOffer && goods.reviewAddress == "30402:maker:camera" && goods.escrow?.bitcoinTerms == nil)
        print("Signed fiat, both methods, typed review targets and classifieds passed")
    }
}
