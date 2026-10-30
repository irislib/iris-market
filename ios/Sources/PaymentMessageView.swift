import SwiftUI

/// A parsed bearer payment is unverified until the recipient explicitly checks it in a wallet.
struct PaymentMessageView: View {
    @EnvironmentObject private var store: MarketStore
    let payment: CashuPayment
    private var displayAmount: String {
        guard ["sat", "sats"].contains(payment.unit.lowercased()), let amount = UInt64(payment.amount) else { return payment.formattedAmount }
        let rate = store.snapshot.satsDisplayPrice
        return NativeMoney.display(sats: amount, currency: store.snapshot.settings.currency, testOnly: payment.isTestMoney, rate: rate?.amount, rateCurrency: rate?.currency, stale: rate?.stale ?? false)
    }
    @State private var copied = false
    @State private var wallet = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "wallet.pass.fill").font(.system(size: 25))
            Text(displayAmount).font(.system(size: 24, weight: .semibold))
            if displayAmount != payment.formattedAmount { Text(payment.formattedAmount).font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
            Text(payment.mintLabel).font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
            if payment.isTestMoney { Text("Test money · no bitcoin value").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
            Text("Not checked").font(.system(size: 12, weight: .medium)).foregroundStyle(MarketTheme.muted)
            Text("Verify and redeem in your wallet.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
            Button { wallet = true } label: { Label("Open in wallet", systemImage: "wallet.pass.fill") }.font(.system(size: 13, weight: .medium))
            Button { MarketPlatform.copyPaymentToClipboard(payment.token); copied = true } label: { Label(copied ? "Copied" : "Copy token", systemImage: "doc.on.doc") }.font(.system(size: 13, weight: .medium))
        }.frame(maxWidth: 260, alignment: .leading)
            .sheet(isPresented: $wallet) { WalletView(incomingToken: payment.token).marketSheetScope() }
            .task(id: copied) { if copied { try? await Task.sleep(nanoseconds: 2_500_000_000); if !Task.isCancelled { copied = false } } }
    }
}
