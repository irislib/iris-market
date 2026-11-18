import SwiftUI

struct OrderHandoffActions: View {
    @EnvironmentObject private var store: MarketStore
    let order: MarketOrder
    @State private var selected: HandoffSheet?
    @State private var confirming = false

    private var hasReceiptRole: Bool {
        ["collector", "merchant", "observer"].contains(order.pickupReceiptRole ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if hasReceiptRole || order.pickupReceipt != nil || order.previousPickupReceipts?.isEmpty == false {
                OrderPickupReceiptView(order: order, confirm: { confirming = true }, present: { selected = $0 })
            }
            ForEach(order.handoffs ?? []) { handoff in
                if handoff.kind != "pickup" || !hasReceiptRole { authorityButton(handoff) }
            }
        }
        .disabled(store.busy)
        .sheet(item: $selected) { sheet in
            if sheet.isScanner {
                MarketQRScanner(handoff: sheet.title, receipt: sheet == .scanReceipt) { code, done in
                    store.command(sheet.request(orderID: order.id, scanned: code)) { ok in
                        done(ok ? nil : store.alert ?? "Could not verify this code.")
                    }
                }
            } else {
                OrderHandoffCode(orderID: order.id, sheet: sheet)
            }
        }
        .alert(order.pickupReceiptRole == "collector" ? "Have you collected the item?" : "Have you handed over the item?", isPresented: $confirming) {
            Button("Cancel", role: .cancel) {}
            if order.pickupReceiptRole == "collector" {
                Button("I collected the item") { store.command(["type": "acknowledge_order_pickup", "order_id": order.id]) }
            } else {
                Button("I handed it over") { store.command(["type": "confirm_order_pickup", "order_id": order.id]) }
            }
        } message: {
            Text(order.pickupReceiptRole == "collector" ? "Your acknowledgment will be shared privately with the merchant when connected." : "Both acknowledgments will be saved on the pickup receipt and shared privately when connected.")
        }
        .onChange(of: order.handoffs) { updated in
            if case .authority(let handoff) = selected, !(updated ?? []).contains(handoff) { selected = nil }
        }
        .onChange(of: order.pickupReceipt?.state) { state in
            if state == "confirmed" { selected = nil; confirming = false }
        }
        .onChange(of: order.status) { _ in selected = nil; confirming = false }
        .onChange(of: order.pickupAuthorization) { _ in selected = nil; confirming = false }
        .onChange(of: order.pickupReceiptRole) { _ in selected = nil; confirming = false }
        .onChange(of: store.snapshot.publicKey) { _ in selected = nil; confirming = false }
    }

    @ViewBuilder private func authorityButton(_ handoff: MarketOrderHandoff) -> some View {
        if let label = handoff.buttonLabel {
            if handoff.action == "checked" {
                Label(label, systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium))
            } else {
                Button { selected = .authority(handoff) } label: {
                    Label(label, systemImage: handoff.action == "show" ? "qrcode" : "qrcode.viewfinder")
                }
            }
        }
    }

}

private struct OrderHandoffCode: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let orderID: String
    let sheet: HandoffSheet
    @State private var pass: String?
    @State private var requestID = UUID()
    @State private var generating = false
    @State private var expired = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if scenePhase == .active, let pass {
                    MarketQRCode(text: pass, label: sheet.title.capitalized, size: 285).privacySensitive()
                    Text(sheet.isReceipt ? "Share this receipt only with someone involved in this pickup." : "Show this code in person. It is valid for two minutes.")
                        .foregroundStyle(MarketTheme.muted)
                } else if generating {
                    ProgressView("Preparing code…")
                } else if expired {
                    Text("This code has expired.").foregroundStyle(MarketTheme.muted)
                }
                if !sheet.isReceipt || pass == nil {
                    Button(sheet.isReceipt ? "Show receipt QR" : "Refresh code", action: generate)
                        .buttonStyle(PrimaryButton(dark: false)).disabled(generating || scenePhase != .active)
                }
                MarketInlineError()
            }.padding(24).navigationTitle(sheet.title.capitalized).marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .onAppear { generate() }
        .onDisappear { clear() }
        .onChange(of: scenePhase) { if $0 != .active { clear() } }
        .task(id: requestID) {
            guard !sheet.isReceipt else { return }
            let id = requestID
            try? await Task.sleep(nanoseconds: 110_000_000_000)
            guard !Task.isCancelled, requestID == id, pass != nil else { return }
            clear(); expired = true
        }
        .marketSheetFrame()
    }

    private func clear() { requestID = UUID(); pass = nil; generating = false; expired = false }

    private func generate() {
        clear()
        let id = requestID
        generating = true
        store.showOrderHandoff(sheet.request(orderID: orderID), onPass: { value in
            if requestID == id && scenePhase == .active { pass = value }
        }) { _ in
            if requestID == id { generating = false }
        }
    }
}
