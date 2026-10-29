import SwiftUI

/// A parsed bearer payment is unverified until the recipient explicitly checks it in a wallet.
struct PaymentMessageView: View {
    let payment: CashuPayment
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "wallet.pass.fill").font(.system(size: 25))
            Text(payment.formattedAmount).font(.system(size: 24, weight: .semibold))
            Text(payment.mintLabel).font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
            Text("Not checked").font(.system(size: 12, weight: .medium)).foregroundStyle(MarketTheme.muted)
            Text("Verify and redeem in your wallet.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
            Button { MarketPlatform.copyPaymentToClipboard(payment.token); copied = true } label: { Label(copied ? "Copied" : "Copy payment", systemImage: "doc.on.doc") }.font(.system(size: 13, weight: .medium))
        }.frame(maxWidth: 260, alignment: .leading)
            .task(id: copied) { if copied { try? await Task.sleep(nanoseconds: 2_500_000_000); if !Task.isCancelled { copied = false } } }
    }
}
