import SwiftUI

struct OrderPaymentRequestView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let order: MarketOrder
    @State private var amount = ""
    @State private var mint = "https://mint.coinos.io"
    private var value: UInt64? { guard let value = UInt64(amount), value > 0, value <= 1_000_000_000_000 else { return nil }; return value }
    var body: some View {
        NavigationStack {
            Form {
                Section("Payment") {
                    Picker("Mint", selection: $mint) { Text("Coinos").tag("https://mint.coinos.io"); Text("Testnut · test money").tag("https://testnut.cashu.space") }
                    TextField(NativeWalletUnits.isTest(mint) ? "Amount in test sats" : "Amount in sats", text: $amount).marketDecimalKeyboard()
                    Text("The buyer reviews the mint, amount and wallet fee before paying.").font(.caption).foregroundStyle(MarketTheme.muted)
                    if NativeWalletUnits.isTest(mint) { Text("Test money · no bitcoin value").font(.caption).foregroundStyle(MarketTheme.muted) }
                }
                MarketInlineError()
                Button("Request payment") { guard let value else { return }; store.updateOrder(order.id, patch: ["payment": ["mint": mint, "amount": String(value), "unit": "sat", "status": "requested"]]) { if $0 { dismiss() } } }.disabled(value == nil || store.busy)
            }.navigationTitle("Request payment").marketInlineTitle().toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
