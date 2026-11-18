import SwiftUI

struct OrderHandoffActions: View {
    @EnvironmentObject private var store: MarketStore
    let orderID: String
    let handoffs: [MarketOrderHandoff]
    @State private var selected: MarketOrderHandoff?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(handoffs) { handoff in
                if let label = handoff.buttonLabel {
                    if handoff.action == "checked" {
                        Label(label, systemImage: "checkmark.circle.fill").font(.subheadline.weight(.medium))
                    } else {
                        Button { selected = handoff } label: {
                            Label(label, systemImage: handoff.action == "show" ? "qrcode" : "qrcode.viewfinder")
                        }
                        .disabled(store.busy)
                    }
                }
            }
        }
        .sheet(item: $selected) { handoff in
            if handoff.action == "show" {
                OrderHandoffCode(orderID: orderID, handoff: handoff)
            } else {
                MarketQRScanner(handoff: handoff.codeName) { pass, done in
                    store.command(["type": "verify_order_handoff", "order_id": orderID, "kind": handoff.kind, "pass": pass]) { ok in
                        done(ok ? nil : store.alert ?? "Ask for a new code for this handoff.")
                    }
                }
            }
        }
        .onChange(of: handoffs) { updated in
            if let selected, !updated.contains(selected) { self.selected = nil }
        }
        .onChange(of: store.snapshot.publicKey) { _ in selected = nil }
    }
}

private struct OrderHandoffCode: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let orderID: String
    let handoff: MarketOrderHandoff
    @State private var pass: String?
    @State private var requestID = UUID()
    @State private var generating = false
    @State private var expired = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if scenePhase == .active, let pass {
                    MarketQRCode(text: pass, label: handoff.codeName.capitalized, size: 285)
                        .privacySensitive()
                    Text("Show this code to the person checking the handoff.").foregroundStyle(MarketTheme.muted)
                } else if generating {
                    ProgressView("Preparing code…")
                } else if expired {
                    Text("This code has expired.").foregroundStyle(MarketTheme.muted)
                }
                Button("Refresh code", action: generate).buttonStyle(PrimaryButton(dark: false)).disabled(generating || scenePhase != .active)
                MarketInlineError()
            }.padding(24).navigationTitle(handoff.codeName.capitalized).marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .onAppear { generate() }
        .onDisappear { clear() }
        .onChange(of: scenePhase) { if $0 != .active { clear() } }
        .task(id: requestID) {
            let id = requestID
            // The signature is valid for 120 seconds. Leave a margin for scanning.
            try? await Task.sleep(nanoseconds: 110_000_000_000)
            guard !Task.isCancelled, requestID == id, pass != nil else { return }
            clear(); expired = true
        }
        .marketSheetFrame()
    }

    private func clear() {
        requestID = UUID(); pass = nil; generating = false; expired = false
    }

    private func generate() {
        clear()
        let id = requestID
        generating = true
        store.showOrderHandoff(orderID, kind: handoff.kind, onPass: { value in
            if requestID == id && scenePhase == .active { pass = value }
        }) { _ in
            if requestID == id { generating = false }
        }
    }
}
