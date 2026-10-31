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
    @State private var scanToken = false
    @State private var scanInvoice = false
    @State private var lightningRequest = ""
    @State private var payConfirmation = false
    @State private var sendRequestID = UUID().uuidString
    @State private var backupPassword = ""
    @State private var backupRepeat = ""
    @State private var restorePassword = ""
    @State private var restoreEnvelope = ""
    @State private var stoppedOriginal = false
    @State private var chooseRestore = false
    @State private var exportBackup = false
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
                            restoreControls
                            if store.demo { Text("Switch to your live profile to use a wallet.").font(.caption).foregroundStyle(MarketTheme.muted) }
                        }
                    } else {
                        balances
                        Picker("Wallet action", selection: $actionMode) {
                            Text("Receive").tag("receive")
                            Text("Send").tag("send")
                            Text("Pay invoice").tag("pay")
                            Text("Add funds").tag("lightning")
                        }.pickerStyle(.segmented).labelsHidden().accessibilityLabel("Wallet action")
                        if actionMode == "receive" { receive } else if actionMode == "pay" { lightningPayment } else { transfer }
                        if let invoice = wallet.invoice { invoiceSection(invoice) }
                        if let token = wallet.token { tokenSection(token) }
                        activity
                        backupControls
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
                Button("Create token") { if let review = wallet.sendReview { wallet.send(review) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Send \(wallet.sendReview.map { displayAmount($0.amountSat, mint: $0.mintUrl) } ?? ""). Fee: \(wallet.sendReview.map { displayAmount($0.feeSat, mint: $0.mintUrl) } ?? ""). Keep the token until its recipient redeems it.")
            }
            .confirmationDialog("Pay this Lightning invoice?", isPresented: $payConfirmation, titleVisibility: .visible) {
                Button("Pay invoice") { if let review = wallet.lightningReview { wallet.payLightning(review) } }
                Button("Cancel", role: .cancel) {}
            } message: { if let review = wallet.lightningReview { Text("Pay " + displayAmount(review.amountSat, mint: review.mintUrl) + ". Fee up to " + displayAmount(review.feeSat, mint: review.mintUrl) + ".") } }
            .confirmationDialog("Reclaim this token?", isPresented: Binding(get: { reclaimConfirmation != nil }, set: { if !$0 { reclaimConfirmation = nil } }), titleVisibility: .visible) {
                Button("Reclaim unredeemed funds") { if let item = reclaimConfirmation { wallet.reclaim(item) }; reclaimConfirmation = nil }
                Button("Cancel", role: .cancel) { reclaimConfirmation = nil }
            } message: { Text("Only ordinary tokens that have not been redeemed can return to this wallet. Locked payments may require the recipient. A successful reclaim makes the old token stop working.") }
            .fileExporter(isPresented: $exportBackup, document: WalletBackupDocument(text: wallet.encryptedBackup ?? ""), contentType: .json, defaultFilename: "iris-market-wallet-backup") { result in
                if case .failure = result { wallet.error = "The encrypted backup could not be saved." }; wallet.encryptedBackup = nil
            }
            .fileImporter(isPresented: $chooseRestore, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 64 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                    restoreEnvelope = try String(contentsOf: url, encoding: .utf8)
                } catch { wallet.error = "Choose an encrypted native-wallet backup under 64 MB." }
            }
            .onChange(of: wallet.encryptedBackup) { value in if value != nil { exportBackup = true } }
            .onChange(of: amount) { _ in wallet.sendReview = nil; sendRequestID = UUID().uuidString }
            .onChange(of: mint) { _ in wallet.sendReview = nil; wallet.lightningReview = nil; sendRequestID = UUID().uuidString }
            .onChange(of: lightningRequest) { _ in wallet.lightningReview = nil }
            .sheet(isPresented: $scanInvoice) { WalletQRScanner(kind: .invoice) { lightningRequest = $0 }.marketSheetScope() }
            .sheet(isPresented: $scanToken) { WalletQRScanner(kind: .token) { incoming = $0 }.marketSheetScope() }
            .onAppear { if let incomingToken { incoming = incomingToken } }
            .onDisappear { incoming = ""; reviewedToken = ""; backupPassword = ""; backupRepeat = ""; restorePassword = ""; restoreEnvelope = ""; wallet.clear() }
            .onChange(of: scenePhase) { phase in if phase != .active { wallet.token = nil; incoming = ""; reviewedToken = "" } }
            .onChange(of: store.snapshot.publicKey) { _ in wallet.clear(); incoming = ""; reviewedToken = ""; dismiss() }
            .onChange(of: wallet.notice) { value in if value == "Token received." { incoming = ""; reviewedToken = "" } }
            .onChange(of: incoming) { _ in wallet.clearTokenReview(); reviewedToken = "" }
            .onChange(of: actionMode) { _ in wallet.clearActionFeedback(); reviewedToken = "" }
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
            if wallet.snapshot.reviewRequired { Text("Refresh this restored wallet before spending. Stop using the original copy.").font(.callout).foregroundStyle(MarketTheme.muted) }
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
                Button { scanToken = true } label: { Label("Scan", systemImage: "qrcode.viewfinder") }.disabled(wallet.busy)
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
                if let review = wallet.sendReview {
                    Text("Fee: " + displayAmount(review.feeSat, mint: review.mintUrl)).font(.callout)
                    Text("Total: " + displayAmount(review.maxTotalSat, mint: review.mintUrl)).font(.headline)
                    Button("Create token") { sendConfirmation = true }.buttonStyle(.borderedProminent).controlSize(.large).disabled(wallet.busy || wallet.snapshot.reviewRequired)
                } else {
                    Button("Review transfer") { if let value = amountValue { wallet.reviewSend(mint: mint, amount: value, requestID: sendRequestID) } }.buttonStyle(.borderedProminent).controlSize(.large).disabled(wallet.busy || amountValue == nil || wallet.snapshot.reviewRequired)
                }
            }
            if actionMode == "lightning" { Text("Request an invoice, then pay with your Lightning wallet.").font(.caption).foregroundStyle(MarketTheme.muted) }
        }
    }
    private var lightningPayment: some View {
        walletCard("Pay a Lightning invoice") {
            Picker("Mint", selection: $mint) { ForEach(mintOptions, id: \.self) { value in Text(NativeWalletUnits.mintName(value)).tag(value) } }.labelsHidden()
            TextEditor(text: $lightningRequest).accessibilityLabel("Lightning invoice").font(.system(size: 12, design: .monospaced)).frame(height: 90).marketNoAutocapitalization().autocorrectionDisabled()
            HStack {
                Button("Paste invoice") { if let text = MarketPlatform.paymentFromClipboard(), let invoice = WalletQRInput.invoice(text) { lightningRequest = invoice } }
                Button { scanInvoice = true } label: { Label("Scan", systemImage: "qrcode.viewfinder") }
            }
            if let review = wallet.lightningReview {
                Text(displayAmount(review.amountSat, mint: review.mintUrl)).font(.headline)
                Text("Fee up to " + displayAmount(review.feeSat, mint: review.mintUrl))
                Text("Total up to " + displayAmount(review.maxTotalSat, mint: review.mintUrl))
                if review.state == "paid" { Text("This invoice was already paid.") }
                else { Button(review.state == "pending" ? "Check saved payment" : "Pay invoice") { payConfirmation = true }.buttonStyle(.borderedProminent).disabled(wallet.busy || wallet.snapshot.reviewRequired) }
            } else {
                Button("Review payment") { if let invoice = WalletQRInput.invoice(lightningRequest) { wallet.reviewLightning(mint: mint, invoice: invoice) } }.buttonStyle(.borderedProminent).disabled(wallet.busy || WalletQRInput.invoice(lightningRequest) == nil || NativeWalletUnits.isTest(mint) || wallet.snapshot.reviewRequired)
            }
        }
    }
    private var backupControls: some View {
        walletCard("Wallet backup") {
            DisclosureGroup("Save an encrypted backup") {
                SecureField("Backup password · at least 12 characters", text: $backupPassword)
                SecureField("Repeat password", text: $backupRepeat)
                Button("Save backup") { let password = backupPassword; backupPassword = ""; backupRepeat = ""; wallet.exportBackup(password: password) }.disabled(wallet.busy || backupPassword.utf8.count < 12 || backupPassword != backupRepeat)
                Text("Includes funds, pending transfers and recovery records. Store the password separately.").font(.caption).foregroundStyle(MarketTheme.muted)
            }
        }
    }
    private var restoreControls: some View {
        DisclosureGroup("Restore an encrypted backup") {
            Button(restoreEnvelope.isEmpty ? "Choose backup file" : "Backup file selected") { chooseRestore = true }
            SecureField("Backup password", text: $restorePassword)
            Text("Restore to your current profile on this device. Existing wallets are preserved.").font(.caption).foregroundStyle(MarketTheme.muted)
            Toggle("I stopped using the original wallet and want to restore on this device", isOn: $stoppedOriginal)
            Button("Restore wallet") {
                let expectedOwner = store.snapshot.publicKey, password = restorePassword, backup = restoreEnvelope
                restorePassword = ""; restoreEnvelope = ""
                wallet.restoreBackup(backup: backup, password: password, owner: expectedOwner) { seed in
                    guard store.snapshot.publicKey == expectedOwner else { throw WalletCredentials.Failure.invalidIdentity }
                    return try store.walletCredentials(importedSeed: seed)
                }
            }.disabled(wallet.busy || !stoppedOriginal || restoreEnvelope.isEmpty || restorePassword.utf8.count < 12)
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
