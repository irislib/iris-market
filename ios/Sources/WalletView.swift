import SwiftUI
import CoreImage.CIFilterBuiltins

struct WalletView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var wallet = NativeWalletModel()
    @State private var mint = "https://mint.coinos.io"
    @State private var amount = ""
    @State private var incoming = ""
    @State private var reviewedToken = ""
    @State private var sendConfirmation = false
    @State private var reclaimConfirmation: NativeWalletActivity?
    @State private var copied = false
    @State private var actionMode = "receive"
    let incomingToken: String?
    init(incomingToken: String? = nil) { self.incomingToken = incomingToken }
    private var amountValue: UInt64? { guard !amount.isEmpty, amount.allSatisfy(\.isNumber), let value = UInt64(amount), value > 0 else { return nil }; return value }
    private var mintOptions: [String] { Array(Set(["https://mint.coinos.io", "https://testnut.cashu.space"] + wallet.snapshot.balances.map(\.mint))).sorted() }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !wallet.opened {
                        walletCard("Your Cashu wallet") {
                            Image(systemName: "wallet.pass.fill").font(.system(size: 34)).foregroundStyle(MarketTheme.green)
                            Text("Tokens, kept on this device.").font(.title2.weight(.semibold))
                            Text("Your recovery key stays in secure storage. Mints hold your balance.").font(.callout).foregroundStyle(MarketTheme.muted)
                            Button("Open wallet") { open() }.buttonStyle(.borderedProminent).controlSize(.large).disabled(store.demo || wallet.busy)
                            if store.demo { Text("Switch to your live profile to use a wallet.").font(.caption).foregroundStyle(MarketTheme.muted) }
                        }
                    } else {
                        balances
                        Picker("Wallet action", selection: $actionMode) {
                            Text("Receive").tag("receive")
                            Text("Send").tag("send")
                            Text("Add funds").tag("lightning")
                        }.pickerStyle(.segmented).labelsHidden().accessibilityLabel("Wallet action")
                        if actionMode == "receive" { receive } else { transfer }
                        if let invoice = wallet.invoice { invoiceSection(invoice) }
                        if let token = wallet.token { tokenSection(token) }
                        activity
                    }
                    if wallet.busy { ProgressView("Working…").frame(maxWidth: .infinity) }
                    if let error = wallet.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    if let notice = wallet.notice { Text(notice).font(.callout).foregroundStyle(MarketTheme.green).fixedSize(horizontal: false, vertical: true) }
                }
                .frame(maxWidth: 560, alignment: .leading)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .background(MarketTheme.paper)
            .navigationTitle("Wallet").marketInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { if wallet.opened { Button { wallet.refresh() } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(wallet.busy) } }
            }
            .confirmationDialog("Create a Cashu token?", isPresented: $sendConfirmation, titleVisibility: .visible) {
                Button("Create token") { if let value = amountValue { wallet.send(mint: mint, amount: value) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Send \(amountValue.map { displayAmount($0, mint: mint) } ?? "") at \(NativeWalletUnits.mintName(mint)). Mint fees may apply. Keep the token until its recipient redeems it.")
            }
            .confirmationDialog("Reclaim this token?", isPresented: Binding(get: { reclaimConfirmation != nil }, set: { if !$0 { reclaimConfirmation = nil } }), titleVisibility: .visible) {
                Button("Reclaim unredeemed funds") { if let item = reclaimConfirmation { wallet.reclaim(item) }; reclaimConfirmation = nil }
                Button("Cancel", role: .cancel) { reclaimConfirmation = nil }
            } message: { Text("Only ordinary tokens that have not been redeemed can return to this wallet. Locked payments may require the recipient. A successful reclaim makes the old token stop working.") }
            .onAppear { if let incomingToken { incoming = incomingToken } }
            .onDisappear { incoming = ""; reviewedToken = ""; wallet.clear() }
            .onChange(of: scenePhase) { phase in if phase != .active { wallet.token = nil; incoming = ""; reviewedToken = "" } }
            .onChange(of: store.snapshot.publicKey) { _ in wallet.clear(); incoming = ""; reviewedToken = ""; dismiss() }
            .onChange(of: wallet.notice) { value in if value == "Token received." { incoming = ""; reviewedToken = "" } }
            .onChange(of: incoming) { _ in wallet.preview = nil; reviewedToken = "" }
            .marketSheetFrame()
        }
    }
    private func displayAmount(_ amount: UInt64, mint: String, testOnly: Bool = false) -> String {
        let rate = store.snapshot.satsDisplayPrice
        return NativeMoney.display(sats: amount, currency: store.snapshot.settings.currency, testOnly: testOnly || NativeWalletUnits.isTest(mint), rate: rate?.amount, rateCurrency: rate?.currency, stale: rate?.stale ?? false)
    }
    @ViewBuilder private func satsDetail(_ amount: UInt64, mint: String, testOnly: Bool = false) -> some View {
        if !testOnly && displayAmount(amount, mint: mint) != NativeWalletUnits.amount(amount, mint: mint) { Text(NativeWalletUnits.amount(amount, mint: mint)).font(.caption).foregroundStyle(MarketTheme.muted) }
    }
    private func walletCard<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(MarketTheme.muted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(22)
        .background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 22))
        .overlay { RoundedRectangle(cornerRadius: 22).stroke(MarketTheme.line.opacity(0.55), lineWidth: 1) }
    }
    private var balances: some View {
        walletCard("Balances") {
            if wallet.snapshot.balances.isEmpty { Text(displayAmount(0, mint: mint)).font(.system(size: 34, weight: .semibold)); Text("No funds yet").font(.callout).foregroundStyle(MarketTheme.muted) }
            ForEach(wallet.snapshot.balances) { balance in
                VStack(alignment: .leading, spacing: 5) {
                    Text(displayAmount(balance.amount, mint: balance.mint, testOnly: balance.testOnly == true)).font(.system(size: 32, weight: .semibold))
                    satsDetail(balance.amount, mint: balance.mint, testOnly: balance.testOnly == true)
                    Text(NativeWalletUnits.mintName(balance.mint)).font(.caption).foregroundStyle(MarketTheme.muted)
                    if NativeWalletUnits.isTest(balance.mint) { Text("Test money · no bitcoin value").font(.caption).foregroundStyle(MarketTheme.muted) }
                }.padding(.vertical, 4)
            }
            if wallet.snapshot.warningCount > 0 { Text("Some mint requests need another check. Refresh to recover pending operations.").font(.caption).foregroundStyle(MarketTheme.muted) }
        }
    }
    private var receive: some View {
        walletCard("Receive") {
            Text("Paste a Cashu token.").font(.callout).foregroundStyle(MarketTheme.muted)
            TextEditor(text: $incoming)
                .font(.system(size: 12, design: .monospaced))
                .scrollContentBackground(.hidden)
                .frame(height: 104)
                .padding(10)
                .background(MarketTheme.paper, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(MarketTheme.line, lineWidth: 1) }
                .disabled(wallet.busy).marketNoAutocapitalization().autocorrectionDisabled().accessibilityLabel("Cashu token")
            HStack {
                Button("Paste token") { if let value = MarketPlatform.paymentFromClipboard() { incoming = value } }.disabled(wallet.busy)
                Spacer()
                Button("Review token") { reviewedToken = incoming.trimmingCharacters(in: .whitespacesAndNewlines); wallet.review(reviewedToken) }.buttonStyle(.borderedProminent).disabled(wallet.busy || incoming.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let preview = wallet.preview {
                VStack(alignment: .leading, spacing: 6) {
                    Text(displayAmount(preview.amount, mint: preview.mint, testOnly: preview.testOnly == true)).font(.headline)
                    satsDetail(preview.amount, mint: preview.mint, testOnly: preview.testOnly == true)
                    Text(preview.mint).font(.caption).textSelection(.enabled)
                    if NativeWalletUnits.isTest(preview.mint) { Text("Test money · no bitcoin value").font(.caption) }
                    Text("Approve this mint and redeem the token into your wallet. Mint fees may reduce the received amount.").font(.caption).foregroundStyle(MarketTheme.muted).fixedSize(horizontal: false, vertical: true)
                    Button("Approve mint & receive") { wallet.receive(reviewedToken, mint: preview.mint) }.buttonStyle(.borderedProminent).disabled(wallet.busy)
                }
            }
        }
    }
    private var transfer: some View {
        walletCard(actionMode == "lightning" ? "Add funds · Lightning" : "Send token") {
            Text("Mint").font(.caption).foregroundStyle(MarketTheme.muted)
            Picker("Mint", selection: $mint) { ForEach(mintOptions, id: \.self) { value in Text(NativeWalletUnits.mintName(value) + (NativeWalletUnits.isTest(value) ? " · Test money" : "")).tag(value) } }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
            if NativeWalletUnits.isTest(mint) { Text("Test sats have no bitcoin value.").font(.caption).foregroundStyle(MarketTheme.muted) }
            TextField(NativeWalletUnits.isTest(mint) ? "Amount in test sats" : "Amount in sats", text: $amount).textFieldStyle(.roundedBorder).controlSize(.large).marketDecimalKeyboard()
            if actionMode == "lightning" {
                Button("Create Lightning invoice") { if let value = amountValue { wallet.topUp(mint: mint, amount: value) } }.buttonStyle(.borderedProminent).controlSize(.large).disabled(wallet.busy || amountValue == nil)
            } else {
                Button("Review transfer") { sendConfirmation = true }.buttonStyle(.borderedProminent).controlSize(.large).disabled(wallet.busy || amountValue == nil)
            }
            if actionMode == "lightning" { Text("Request an invoice, then pay with your Lightning wallet.").font(.caption).foregroundStyle(MarketTheme.muted) }
        }
    }
    private func invoiceSection(_ invoice: NativeWalletInvoice) -> some View {
        walletCard(invoice.isTest ? "Test invoice" : "Lightning invoice") {
            Text(displayAmount(invoice.amount, mint: invoice.mint, testOnly: invoice.isTest)).font(.headline)
            satsDetail(invoice.amount, mint: invoice.mint, testOnly: invoice.isTest)
            if invoice.isTest { Text("Test money · no bitcoin value. Do not pay this invoice with a real Lightning wallet.").font(.caption) }
            if !invoice.isTest { WalletInvoiceQR(invoice: invoice.invoice).frame(maxWidth: .infinity) }
            Text(invoice.invoice).font(.caption.monospaced()).lineLimit(3).textSelection(.enabled)
            HStack {
                Button(invoice.isTest ? "Copy test invoice" : "Copy invoice") { MarketPlatform.copyPaymentToClipboard(invoice.invoice) }
                Spacer()
                if !invoice.isTest { Button("Open Lightning wallet") { if let url = URL(string: "lightning:" + invoice.invoice) { MarketPlatform.openExternalURL(url) } } }
            }
            Button("Check payment") { wallet.refresh() }.disabled(wallet.busy)
            if !invoice.isTest { Text("Opening another app does not confirm payment. Check payment here after paying.").font(.caption).foregroundStyle(MarketTheme.muted) }
        }
    }
    private func tokenSection(_ token: NativeWalletToken) -> some View {
        walletCard("Your token") {
            Text(displayAmount(token.amount, mint: token.mint, testOnly: token.testOnly == true)).font(.headline)
            satsDetail(token.amount, mint: token.mint, testOnly: token.testOnly == true)
            Text("Fee: " + displayAmount(token.fee, mint: token.mint, testOnly: token.testOnly == true)).font(.caption)
            Text("Anyone with this token can redeem it. It stays recoverable in Activity until redeemed.").font(.caption).foregroundStyle(MarketTheme.muted)
            HStack {
                Button(copied ? "Copied" : "Copy token") { MarketPlatform.copyPaymentToClipboard(token.token); copied = true }
                Spacer()
                ShareLink(item: token.token) { Label("Share token", systemImage: "square.and.arrow.up") }
            }
            Button("Hide token") { wallet.token = nil; copied = false }
        }
    }
    private var activity: some View {
        walletCard("Activity") {
            if wallet.snapshot.activity.isEmpty { Text("No payments yet").foregroundStyle(MarketTheme.muted) }
            ForEach(wallet.snapshot.activity) { item in
                VStack(alignment: .leading, spacing: 5) {
                    HStack { Text(item.title); Spacer(); Text(displayAmount(item.amount, mint: item.mint, testOnly: item.testOnly == true)) }
                    satsDetail(item.amount, mint: item.mint, testOnly: item.testOnly == true)
                    Text(NativeWalletUnits.mintName(item.mint) + " · " + item.status.capitalized).font(.caption).foregroundStyle(MarketTheme.muted)
                    if item.kind == "token_send", item.status == "pending", let id = item.operationId {
                        HStack { Button("Show token") { copied = false; wallet.showToken(id) }; Spacer(); Button("Reclaim payment") { reclaimConfirmation = item } }.disabled(wallet.busy)
                    }
                }
            }
        }
    }
    private func open() { do { wallet.open(try store.walletCredentials()) } catch { wallet.error = error.localizedDescription } }
}

private struct WalletInvoiceQR: View {
    let invoice: String
    private var image: CGImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(("lightning:" + invoice).utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 6, y: 6)), from: output.extent.applying(CGAffineTransform(scaleX: 6, y: 6)))
    }
    var body: some View {
        if let image { Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit().frame(width: 220, height: 220).padding(16).background(.white).clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityLabel("Lightning invoice QR code") }
    }
}
