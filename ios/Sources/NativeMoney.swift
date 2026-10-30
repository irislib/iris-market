import Foundation

/// Presentation uses the existing cached price rate; the ledger remains exact sats.
enum NativeMoney {
    static func display(sats: UInt64, currency: String, testOnly: Bool, rate: Double?, rateCurrency: String?, stale: Bool = false) -> String {
        if testOnly { return sats.formatted() + " test sats" }
        let currency = currency.uppercased()
        if ["SAT", "SATS"].contains(currency) { return sats.formatted() + " sats" }
        let value: Double
        if currency == "BTC" { value = Double(sats) / 100_000_000 }
        else if sats == 0 { value = 0 }
        else {
            guard let rate, rate.isFinite, rate > 0, rateCurrency?.uppercased() == currency else { return sats.formatted() + " sats" }
            value = Double(sats) * rate
        }
        guard value.isFinite else { return sats.formatted() + " sats" }
        let format = NumberFormatter()
        if currency == "BTC" { format.numberStyle = .decimal; format.maximumFractionDigits = 8; return (format.string(from: NSNumber(value: value)) ?? String(value)) + " BTC" }
        format.numberStyle = .currency; format.currencyCode = currency
        if value != 0 && (abs(value) < 0.01 || abs(value) < pow(10, -Double(format.maximumFractionDigits)) / 2) { format.maximumFractionDigits = 8 }
        return (format.string(from: NSNumber(value: value)) ?? "\(value) \(currency)") + (stale && sats > 0 ? " · older rate" : "")
    }
}
