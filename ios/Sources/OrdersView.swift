import SwiftUI

private struct OrderSelection: Identifiable { let id: String }

struct OrdersView: View {
    @EnvironmentObject private var store: MarketStore
    @State private var section = MarketOrderList.purchases
    private var orders: [MarketOrder] { store.snapshot.orders.filter { section.contains($0, owner: store.snapshot.publicKey) } }
    private var selection: Binding<OrderSelection?> {
        Binding(get: { store.activeOrderID.map { OrderSelection(id: $0) } }, set: { store.activeOrderID = $0?.id })
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Orders").font(.system(size: 30, weight: .medium)).tracking(-1)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(MarketOrderList.allCases, id: \.self) { value in
                            Button { section = value } label: {
                                Text(value.rawValue).font(.system(size: 13, weight: .medium)).padding(.horizontal, 14).padding(.vertical, 11)
                                    .foregroundStyle(section == value ? MarketTheme.onAction : MarketTheme.ink)
                                    .background(section == value ? MarketTheme.action : MarketTheme.surface, in: Capsule())
                            }.buttonStyle(.plain).accessibilityIdentifier("orders\(value.rawValue)")
                        }
                    }
                }
                if orders.isEmpty {
                    MarketEmptyState(symbol: "shippingbox.fill", title: section == .archived ? "Nothing archived" : "No \(section.rawValue.lowercased()) yet", description: section == .purchases ? "Your orders appear here." : section == .sales ? "Order requests for your listings appear here." : section == .deliveries ? "Deliveries you handle appear here." : "Finished orders can be kept here.")
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(orders) { order in
                            Button { store.activeOrderID = order.id } label: { OrderRow(order: order) }.buttonStyle(.plain)
                        }
                    }
                }
            }.padding(23)
        }.foregroundStyle(MarketTheme.ink)
            .sheet(item: selection) { value in OrderDetailView(orderID: value.id).marketSheetScope() }
    }
}

private struct OrderRow: View {
    let order: MarketOrder
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 15) {
                Text(order.title.isEmpty ? "Order" : order.title).font(.system(size: 17, weight: .semibold)).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                if let first = order.items.first { Text(first.formattedPrice).font(.system(size: 16, weight: .medium)) }
            }
            HStack {
                Text(Date(timeIntervalSince1970: Double(order.createdAt)), format: .dateTime.day().month()).foregroundStyle(MarketTheme.muted)
                Spacer()
                Text(order.statusLabel)
            }.font(.system(size: 12))
            if order.sync == "queued" { Text("Waiting to send").font(.system(size: 11)).foregroundStyle(MarketTheme.muted) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
    }
}

struct OrderReviewView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let listing: MarketListing
    let onRequested: () -> Void
    @State private var quantity = 1
    @State private var note = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 23) {
                    Text(listing.title).font(.system(size: 30, weight: .medium))
                    Text(listing.formattedPrice).font(.system(size: 26, weight: .semibold))
                    UserRow(person: store.snapshot.people[listing.author] ?? .unnamed(listing.author))
                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...999).accessibilityIdentifier("orderQuantity")
                    TextField("Note · optional", text: $note, axis: .vertical).lineLimit(3...6).padding(16).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16)).accessibilityIdentifier("orderNote")
                        .onChange(of: note) { value in if value.count > 2000 { note = String(value.prefix(2000)) } }
                    Text("The seller will confirm your order. No payment is taken here.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
                    MarketInlineError()
                    Button {
                        store.requestOrder(listing, quantity: quantity, note: note.trimmingCharacters(in: .whitespacesAndNewlines)) { success in
                            if success { dismiss(); onRequested() }
                        }
                    } label: { if store.busy { ProgressView() } else { Text(NativeTransportType.classify(listing.tags ?? [])?.requestLabel ?? "Request order") } }
                        .buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.canSign).accessibilityIdentifier("requestOrder")
                }.padding(24)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Review order").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct OrderDetailView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let orderID: String
    @State private var editingRoute = false
    @State private var cancelling = false
    @State private var profile: OrderSelection?
    private var order: MarketOrder? { store.snapshot.orders.first { $0.id == orderID } }
    var body: some View {
        NavigationStack {
            ScrollView {
                if let order { detail(order) }
                else { MarketEmptyState(symbol: "shippingbox.fill", title: "Order unavailable", description: "This order is not available for this profile.") }
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Order").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .sheet(isPresented: $editingRoute) { if let order { OrderRouteEditor(order: order).marketSheetScope() } }
                .sheet(item: $profile) { value in AuthorProfileView(author: value.id).marketSheetScope() }
                .confirmationDialog("Cancel this order?", isPresented: $cancelling, titleVisibility: .visible) {
                    Button("Cancel order", role: .destructive) { store.updateOrder(orderID, patch: ["status": "cancelled"]) }
                    Button("Keep order", role: .cancel) { }
                }
                .onChange(of: store.snapshot.publicKey) { _ in dismiss() }
        }
    }
    @ViewBuilder private func detail(_ order: MarketOrder) -> some View {
        let seller = order.seller == store.snapshot.publicKey
        let participant = seller || order.buyer == store.snapshot.publicKey
        let other = seller ? order.buyer : order.seller
        VStack(alignment: .leading, spacing: 21) {
            Text(order.title.isEmpty ? "Order" : order.title).font(.system(size: 30, weight: .medium))
            HStack { Text(order.statusLabel).fontWeight(.semibold); Spacer(); Text(Date(timeIntervalSince1970: Double(order.createdAt)), format: .dateTime.day().month()).foregroundStyle(MarketTheme.muted) }.font(.system(size: 13))
            ForEach(order.items) { item in Text("\(item.quantity) × \(item.formattedPrice)").font(.system(size: 22, weight: .semibold)) }
            Button { profile = OrderSelection(id: other) } label: { UserRow(person: store.snapshot.people[other] ?? .unnamed(other), subtitle: seller ? "Buyer" : "Seller") }.buttonStyle(.plain)
            if !order.note.isEmpty { Text(order.note).font(.system(size: 15)).lineSpacing(4) }
            if order.sync == "queued" { Text("Waiting to send").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
            MarketInlineError()
            if !order.terminal {
                if seller && order.status == "requested" { statusButton("Accept order", status: "accepted") }
                if seller && order.status == "accepted" { statusButton("Mark on the way", status: "in-transit") }
                if participant && ["accepted", "in-transit"].contains(order.status) { statusButton("Mark delivered", status: "delivered", primary: false) }
            }
            Divider().overlay(MarketTheme.line)
            HStack {
                Text("Delivery").font(.system(size: 21, weight: .semibold)); Spacer()
                if seller && !order.terminal && order.status != "requested" { Button("Edit route") { editingRoute = true }.font(.system(size: 13, weight: .semibold)) }
            }
            TimelineView(.periodic(from: .now, by: 15)) { context in
                if let estimate = marketArrivalEstimate(eta: order.shipment.eta, status: order.status, now: Int64(context.date.timeIntervalSince1970)), let eta = order.shipment.eta {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Estimated arrival").font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
                        Text(estimate).font(.system(size: 28, weight: .semibold))
                        Text(Date(timeIntervalSince1970: Double(eta)).formatted(date: .abbreviated, time: .shortened)).font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
                    }
                }
            }
            if order.shipment.hasMap {
                ShipmentMapView(shipment: order.shipment).frame(height: 250).clipShape(RoundedRectangle(cornerRadius: 20))
                Text("Stops joined directly; not driving directions.").font(.system(size: 11)).foregroundStyle(MarketTheme.muted)
            }
            if order.shipment.stops.isEmpty { Text(seller ? "Add delivery details after accepting the order." : "Delivery details will appear here.").font(.system(size: 14)).foregroundStyle(MarketTheme.muted) }
            ForEach(Array(order.shipment.stops.enumerated()), id: \.element.id) { index, stop in
                stopView(stop, number: index + 1, order: order, seller: seller)
            }
            if let tracking = order.shipment.trackingLink { Link(destination: tracking) { Label("Track delivery", systemImage: "arrow.up.right.square") }.font(.system(size: 14, weight: .medium)) }
            if !order.terminal && order.handlesDelivery(store.snapshot.publicKey) && !store.snapshot.liveLocationSupported {
                Text("Live location is not available in this app yet.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
            }
            if !order.terminal && participant { Button("Cancel order", role: .destructive) { cancelling = true }.disabled(store.busy).font(.system(size: 13)) }
            if order.terminal { Button(order.archived ? "Restore order" : "Archive order") { store.archiveOrder(order) { if $0 { dismiss() } } }.buttonStyle(PrimaryButton(dark: false)).disabled(store.busy) }
        }.padding(24)
    }
    private func statusButton(_ label: String, status: String, primary: Bool = true) -> some View {
        Button { store.updateOrder(orderID, patch: ["status": status]) } label: { Text(label) }.buttonStyle(PrimaryButton(dark: primary)).disabled(store.busy || store.demo)
    }
    @ViewBuilder private func stopView(_ stop: MarketShipmentStop, number: Int, order: MarketOrder, seller: Bool) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top, spacing: 12) {
                Group { if stop.status == "completed" { Image(systemName: "checkmark.circle.fill") } else { Text("\(number)").fontWeight(.semibold) } }.frame(width: 28, height: 28).background(MarketTheme.mint, in: Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text(stop.label.isEmpty ? "Stop \(number)" : stop.label).font(.system(size: 16, weight: .semibold))
                    if !stop.address.isEmpty { Text(stop.address).font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    if !order.terminal { Text(stop.statusLabel).font(.system(size: 11)).foregroundStyle(MarketTheme.muted) }
                }
                Spacer(minLength: 0)
            }
            if let courier = stop.courierPubkey {
                Button { profile = OrderSelection(id: courier) } label: { UserRow(person: store.snapshot.people[courier] ?? .unnamed(courier), subtitle: "Courier", size: 30) }.buttonStyle(.plain)
            }
            if !order.terminal && order.status != "requested" && (seller || stop.courierPubkey == store.snapshot.publicKey) {
                if stop.status != "completed", let url = navigationURL(stop) { Link(destination: url) { Label("Navigate to stop", systemImage: "arrow.triangle.turn.up.right.diamond.fill") }.font(.system(size: 13, weight: .semibold)) }
                HStack(spacing: 18) {
                    if stop.status == "pending" { Button("Mark arrived") { store.updateOrder(orderID, patch: ["stopId": stop.id, "status": "arrived"]) } }
                    if stop.status != "completed" { Button("Complete stop") { store.updateOrder(orderID, patch: ["stopId": stop.id, "status": "completed"]) } }
                }.font(.system(size: 13, weight: .semibold)).disabled(store.busy || store.demo)
            }
        }.padding(17).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 19))
    }
}

private func navigationURL(_ stop: MarketShipmentStop) -> URL? {
    let destination: String
    if let point = stop.coordinates, MarketShipment.validCoordinates(point) { destination = "\(point[1]),\(point[0])" }
    else { destination = stop.address.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard !destination.isEmpty else { return nil }
    var url = URLComponents(string: "https://maps.apple.com/")!
    url.queryItems = [URLQueryItem(name: "daddr", value: destination), URLQueryItem(name: "dirflg", value: "d")]
    return url.url
}
