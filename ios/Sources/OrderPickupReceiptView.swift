import SwiftUI

enum HandoffSheet: Hashable, Identifiable {
    case authority(MarketOrderHandoff), acknowledgment, scanPickup, receipt(String?), scanReceipt
    var id: Self { self }
    var isReceipt: Bool { if case .receipt = self { return true }; return false }
    var title: String {
        switch self {
        case .authority(let handoff): return handoff.codeName
        case .acknowledgment: return "pickup acknowledgment"
        case .scanPickup: return "pickup code"
        case .receipt, .scanReceipt: return "pickup receipt"
        }
    }
    var isScanner: Bool {
        switch self {
        case .scanPickup, .scanReceipt: return true
        case .authority(let handoff): return handoff.action == "scan"
        default: return false
        }
    }
    func request(orderID: String, scanned: String? = nil) -> [String: Any] {
        var request: [String: Any] = ["order_id": orderID]
        switch self {
        case .authority(let handoff):
            request["type"] = scanned == nil ? "show_order_handoff" : "verify_order_handoff"
            request["kind"] = handoff.kind
            request["pass"] = scanned
        case .acknowledgment: request["type"] = "acknowledge_order_pickup"
        case .scanPickup:
            request["type"] = "verify_order_handoff"
            request["kind"] = "pickup"
            request["pass"] = scanned
        case .receipt(let reference):
            request["type"] = "show_pickup_receipt"
            request["reference"] = reference
        case .scanReceipt:
            request["type"] = "verify_pickup_receipt"
            request["receipt"] = scanned
        }
        return request
    }
}

struct OrderPickupReceiptView: View {
    let order: MarketOrder
    let confirm: () -> Void
    let present: (HandoffSheet) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if order.pickupReceiptRole != nil || order.pickupReceipt != nil { receiptSection }
            if let earlier = order.previousPickupReceipts, !earlier.isEmpty {
                DisclosureGroup("Earlier pickup receipts") {
                    ForEach(earlier, id: \.reference) { receipt in
                        VStack(alignment: .leading, spacing: 4) {
                            receiptTime("Collector acknowledged", receipt.collectedAt)
                            receiptTime("Merchant confirmed", receipt.confirmedAt)
                            Button("Show earlier receipt QR") { present(.receipt(receipt.reference)) }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var receiptSection: some View {
        if let receipt = order.pickupReceipt, receipt.state != "confirmed" {
            let expiry = Date(timeIntervalSince1970: TimeInterval(receipt.collectedAt) + 121)
            TimelineView(.explicit([Date(), expiry].sorted())) { context in currentPickup(fresh: context.date < expiry) }
        } else {
            currentPickup(fresh: true)
        }
    }

    @ViewBuilder private func currentPickup(fresh: Bool) -> some View {
        let receipt = order.pickupReceipt
        let role = order.pickupReceiptRole
        let active = ["accepted", "in-transit"].contains(order.status)
        VStack(alignment: .leading, spacing: 10) {
            Text("Pickup receipt").font(.headline)
            if let receipt { receiptTime("Collector acknowledged", receipt.collectedAt) }
            if receipt?.state == "confirmed", let at = receipt?.confirmedAt {
                receiptTime("Merchant confirmed", at)
                Button("Show receipt QR") { present(.receipt(nil)) }
            } else {
                if role == "collector" && active {
                    if receipt == nil || !fresh {
                        if !fresh { Text("The acknowledgment expired before confirmation.").font(.subheadline) }
                        Button(receipt == nil ? "Acknowledge collection" : "Renew acknowledgment") { confirm() }.buttonStyle(.borderedProminent)
                    } else {
                        Text("Waiting for merchant confirmation.").font(.subheadline).foregroundStyle(.secondary)
                        Button("Show acknowledgment QR") { present(.acknowledgment) }
                    }
                } else if role == "merchant" && active {
                    if receipt?.state == "awaiting-confirmation" {
                        if fresh { Button("Confirm handover") { confirm() }.buttonStyle(.borderedProminent) }
                        else { Text("Ask the collector to show a fresh acknowledgment QR.").font(.subheadline) }
                    } else {
                        if order.handoffs?.contains(where: { $0.kind == "pickup" && $0.action == "checked" }) == true {
                            Text("Pickup authorization checked on this device.").font(.subheadline)
                        }
                        Text("Scan the collector’s code or wait for their private acknowledgment.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Button("Scan pickup code") { present(.scanPickup) }
                } else if receipt != nil {
                    Text("Waiting for merchant confirmation.").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Text(active ? "The signed receipt will appear here after pickup." : "No pickup receipt recorded.").font(.subheadline).foregroundStyle(.secondary)
                }
                if role == "collector" || role == "observer" {
                    if receipt != nil {
                        Button("Scan returned receipt") { present(.scanReceipt) }
                    } else {
                        DisclosureGroup(role == "collector" && active ? "Offline pickup options" : "Receive receipt offline") {
                            if role == "collector" && active, let handoff = order.handoffs?.first(where: { $0.kind == "pickup" && $0.action == "show" }) {
                                Button("Show authorization code") { present(.authority(handoff)) }
                            }
                            Button("Scan returned receipt") { present(.scanReceipt) }
                        }
                    }
                }
            }
        }
    }

    private func receiptTime(_ label: String, _ time: Int64) -> some View {
        let date = Date(timeIntervalSince1970: TimeInterval(time))
        return Label(label + " · " + date.formatted(date: .abbreviated, time: .shortened), systemImage: "checkmark.circle.fill")
            .font(.subheadline)
    }
}
