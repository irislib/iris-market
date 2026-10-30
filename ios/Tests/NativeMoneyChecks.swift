import Foundation

@main struct NativeMoneyChecks {
    static func main() {
        let fiat = NativeMoney.display(sats: 100, currency: "USD", testOnly: false, rate: 0.02, rateCurrency: "USD")
        precondition(!fiat.contains("sats") && !fiat.contains("~"))
        precondition(NativeMoney.display(sats: 100, currency: "USD", testOnly: true, rate: 0.02, rateCurrency: "USD") == "100 test sats")
        precondition(NativeMoney.display(sats: 100, currency: "USD", testOnly: false, rate: nil, rateCurrency: nil) == "100 sats")
        precondition(NativeMoney.display(sats: 100, currency: "EUR", testOnly: false, rate: 0.02, rateCurrency: "USD") == "100 sats")
        precondition(NativeMoney.display(sats: 100, currency: "SATS", testOnly: false, rate: nil, rateCurrency: nil) == "100 sats")
        precondition(NativeMoney.display(sats: 100_000_000, currency: "BTC", testOnly: false, rate: nil, rateCurrency: nil) == "1 BTC")
        precondition(NativeMoney.display(sats: 100, currency: "USD", testOnly: false, rate: .nan, rateCurrency: "USD") == "100 sats")
        let zeroFormat = NumberFormatter(); zeroFormat.numberStyle = .currency; zeroFormat.currencyCode = "USD"
        let zeroUSD = zeroFormat.string(from: 0)!
        precondition(NativeMoney.display(sats: 0, currency: "USD", testOnly: false, rate: nil, rateCurrency: nil) == zeroUSD)
        precondition(NativeMoney.display(sats: 0, currency: "USD", testOnly: false, rate: .nan, rateCurrency: "EUR", stale: true) == zeroUSD)
        precondition(NativeMoney.display(sats: 0, currency: "USD", testOnly: true, rate: nil, rateCurrency: nil) == "0 test sats")
        precondition(NativeMoney.display(sats: 0, currency: "SATS", testOnly: false, rate: nil, rateCurrency: nil) == "0 sats")
        precondition(NativeMoney.display(sats: 0, currency: "BTC", testOnly: false, rate: nil, rateCurrency: nil) == "0 BTC")
        let tinyFormat = NumberFormatter(); tinyFormat.numberStyle = .currency; tinyFormat.currencyCode = "EUR"; tinyFormat.maximumFractionDigits = 8
        let tiny = NativeMoney.display(sats: 1, currency: "EUR", testOnly: false, rate: 0.00000789, rateCurrency: "EUR")
        precondition(tiny == tinyFormat.string(from: NSNumber(value: 0.00000789))!)
        precondition(tiny != tinyFormat.string(from: NSNumber(value: 0))!)
        precondition(!tiny.contains("~"))
        let yenFormat = NumberFormatter(); yenFormat.numberStyle = .currency; yenFormat.currencyCode = "JPY"; yenFormat.maximumFractionDigits = 8
        precondition(NativeMoney.display(sats: 1, currency: "JPY", testOnly: false, rate: 0.1, rateCurrency: "JPY") == yenFormat.string(from: NSNumber(value: 0.1))!)
        print("16 native money presentation checks passed.")
    }
}
