import SwiftUI

struct OrderArrangeDeliveryView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let order: MarketOrder
    @State private var pickup = MarketDeliveryPlace(label: "Pickup")
    @State private var confirm = false
    @State private var destination = MarketDeliveryPlace(label: "Destination")
    @State private var selected: String?
    @State private var error: String?
    @State private var prior: (query: String, side: String, ai: Bool)?
    private var merchant: Bool { order.seller == store.snapshot.publicKey }
    private var mayRequest: Bool { merchant ? order.canBookMerchantCourier(store.snapshot.publicKey) : order.canBookBuyerCourier(store.snapshot.publicKey) }
    private var services: [MarketListing] {
        let now = Int64(Date().timeIntervalSince1970)
        return store.snapshot.listings.filter { service in
            service.side == "offer" && service.status == "active" && (service.expiresAt ?? .max) > now &&
                service.author != order.seller && service.author != order.buyer && NativeTransportType.parcel.includes(service.tags ?? [])
        }
    }
    var body: some View {
        MarketNavigationContainer {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if merchant { PrivateDeliveryPlaceField(place: $pickup) }
                    else if let pickup = order.shipment.stops.first { Text("Pickup").font(.headline); Text(pickup.address); if let point = pickup.coordinates { ShipmentMapView(shipment: MarketShipment(stops: [MarketShipmentStop(id: "pickup", label: pickup.label, address: pickup.address, coordinates: point, status: "pending")])).frame(height: 180).clipShape(RoundedRectangle(cornerRadius: 16)) } }
                    PrivateDeliveryPlaceField(place: $destination)
                    Text("Choose a delivery service").font(.title3.weight(.semibold))
                    let options = services
                    let provider = options.first { $0.id == selected }
                    if options.isEmpty { Text("No delivery services found.").foregroundStyle(MarketTheme.muted); Button("Refresh services") { store.command(["type": "refresh"]) } }
                    ForEach(options) { service in
                        Button { selected = service.id } label: {
                            HStack(spacing: 12) { VStack(alignment: .leading, spacing: 6) { Text(service.title).font(.headline); Text(service.formattedPrice).font(.subheadline) }; Spacer(); Image(systemName: selected == service.id ? "checkmark.circle.fill" : "circle") }
                                .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 17))
                        }.buttonStyle(.plain).accessibilityAddTraits(selected == service.id ? .isSelected : [])
                    }
                    Text(merchant ? "You pay for delivery separately. Confirm the address with the buyer in your order chat." : "You pay for delivery separately. The seller receives the courier’s profile and a pickup reference.").font(.caption).foregroundStyle(MarketTheme.muted)
                    MarketInlineError()
                    if let error { Text(error).foregroundStyle(.red).font(.caption) }
                    Button("Review delivery request") {
                        do {
                            if merchant { _ = try pickup.projection() }
                            _ = try destination.projection()
                            error = nil
                            confirm = true
                        } catch { self.error = error.localizedDescription }
                    }.buttonStyle(PrimaryButton()).disabled(store.busy || !mayRequest || provider == nil)
                        .accessibilityIdentifier("reviewCourierRequest")
                        .confirmationDialog("Send a private delivery request?", isPresented: $confirm, titleVisibility: .visible, presenting: provider) { service in
                            Button("Send request") {
                                guard mayRequest, services.contains(where: { $0.id == service.id }) else { return }
                                store.requestDelivery(sourceOrderID: order.id, listing: service, pickup: merchant ? pickup : nil, destination: destination) { success in if success { dismiss() } }
                            }
                            Button("Cancel", role: .cancel) {}
                        } message: { service in
                            Text("\(service.title) · \(service.formattedPrice)\nPickup: \(merchant ? pickup.address : order.shipment.stops.first?.address ?? "")\nDestination: \(destination.address)\nSending this request shares both addresses privately with the selected delivery service.")
                        }
                }.padding(24)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Arrange delivery").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .onAppear { if prior == nil { prior = (store.snapshot.query, store.snapshot.side, store.snapshot.aiSearch); store.filter(query: "", side: "offer") } }
                .onDisappear { if let prior { store.filter(query: prior.query, side: prior.side, aiSearch: prior.ai) } }
        }
    }
}
