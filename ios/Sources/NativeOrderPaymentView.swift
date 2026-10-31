import SwiftUI

/// The buyer queues one recoverable token; only the seller confirms redemption.
struct NativeOrderPaymentView: View {
    let orderID: String
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @StateObject private var wallet = NativeWalletModel()
    @State private var owner = ""
    @State private var approvedMint = ""
    @State private var approvedAmount = ""
    private var order: MarketOrder? { store.snapshot.orders.first { $0.id == orderID } }
    private func display(_ amount: UInt64, mint: String) -> String {
        let rate = store.snapshot.satsDisplayPrice
        return NativeMoney.display(sats: amount, currency: store.snapshot.settings.currency, testOnly: NativeWalletUnits.isTest(mint), rate: rate?.amount, rateCurrency: rate?.currency, stale: rate?.stale ?? false)
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let order, let payment = order.payment, payment.status == "requested", payment.unit == "sat", let amount = UInt64(payment.amount), amount > 0 {
                        Text(order.items.first?.title ?? "Order payment").font(.title2.weight(.semibold))
                        Text(display(amount, mint: payment.mint)).font(.title.weight(.semibold))
                        Text(NativeWalletUnits.mintName(payment.mint)).foregroundStyle(MarketTheme.muted)
                        if NativeWalletUnits.isTest(payment.mint) { Text("Test money · no bitcoin value").font(.caption) }
                        if let review = wallet.sendReview {
                            Text("Fee: " + display(review.feeSat, mint: review.mintUrl))
                            Text("Total: " + display(review.maxTotalSat, mint: review.mintUrl)).font(.headline)
                            Button(review.existing ? "Retry sending payment" : "Pay order") {
                                let capturedOwner = owner, capturedMint = approvedMint, capturedAmount = approvedAmount
                                wallet.payOrder(review) { token in
                                    guard owner == capturedOwner, store.snapshot.publicKey == capturedOwner,
                                          store.snapshot.orders.first(where: { $0.id == orderID })?.payment?.mint == capturedMint, store.snapshot.orders.first(where: { $0.id == orderID })?.payment?.amount == capturedAmount else { throw WalletCredentials.Failure.invalidIdentity }
                                    try await store.sendOrderPaymentToken(orderID: orderID, token: token, expectedOwner: capturedOwner)
                                }
                            }.buttonStyle(.borderedProminent).controlSize(.large).disabled(wallet.busy || store.snapshot.publicKey != owner || payment.mint != approvedMint || payment.amount != approvedAmount)
                        } else {
                            Button("Review payment") {
                                do {
                                    owner = store.snapshot.publicKey; approvedMint = payment.mint; approvedAmount = payment.amount
                                    wallet.reviewOrder(material: try store.walletCredentials(), mint: payment.mint, amount: amount, requestID: NativeOrderPaymentIdentity.request(orderID: orderID, mint: payment.mint, amount: payment.amount))
                                } catch { wallet.error = error.localizedDescription }
                            }.buttonStyle(.borderedProminent).controlSize(.large).disabled(wallet.busy)
                        }
                        Text("The token is sent privately to the seller. The seller confirms payment after redeeming it.").font(.caption).foregroundStyle(MarketTheme.muted)
                    } else { Text("This order has no payment awaiting confirmation.") }
                    if wallet.busy { ProgressView("Working…") }
                    if let error = wallet.error { Text(error).foregroundStyle(.red) }
                    if let notice = wallet.notice { Text(notice).foregroundStyle(MarketTheme.green) }
                }.padding(24).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
            }.background(MarketTheme.paper).navigationTitle("Pay order").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .onDisappear { wallet.clear() }
        .onChange(of: order?.payment?.mint) { _ in wallet.clear() }
        .onChange(of: order?.payment?.amount) { _ in wallet.clear() }
        .onChange(of: store.snapshot.publicKey) { _ in wallet.clear(); dismiss() }
        .marketSheetFrame()
    }
}
