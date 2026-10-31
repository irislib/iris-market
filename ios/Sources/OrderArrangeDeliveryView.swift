import SwiftUI

struct OrderArrangeDeliveryView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let order: MarketOrder
    @State private var destination = MarketDeliveryPlace(label: "Destination")
    @State private var selected: String?
    @State private var error: String?
    @State private var prior: (query: String, side: String, ai: Bool)?
    private var services: [MarketListing] {
        store.snapshot.listings.filter { $0.side == "offer" && $0.status == "active" && $0.author != order.seller && $0.author != store.snapshot.publicKey && ($0.expiresAt == nil || $0.expiresAt! > Int64(Date().timeIntervalSince1970)) && NativeTransportType.parcel.includes($0.tags ?? []) }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let pickup = order.shipment.stops.first { Text("Pickup").font(.headline); Text(pickup.address); if let point = pickup.coordinates { ShipmentMapView(shipment: MarketShipment(stops: [MarketShipmentStop(id: "pickup", label: pickup.label, address: pickup.address, coordinates: point, status: "pending")])).frame(height: 180).clipShape(RoundedRectangle(cornerRadius: 16)) } }
                    PrivateDeliveryPlaceField(place: $destination)
                    Text("Choose a delivery service").font(.title3.weight(.semibold))
                    if services.isEmpty { Text("Looking for delivery services…").foregroundStyle(MarketTheme.muted); Button("Refresh services") { store.command(["type": "refresh"]) } }
                    ForEach(services) { service in
                        Button { selected = service.id } label: {
                            HStack(spacing: 12) { VStack(alignment: .leading, spacing: 6) { Text(service.title).font(.headline); Text(service.formattedPrice).font(.subheadline) }; Spacer(); Image(systemName: selected == service.id ? "checkmark.circle.fill" : "circle") }
                                .padding(16).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 17))
                        }.buttonStyle(.plain).accessibilityAddTraits(selected == service.id ? .isSelected : [])
                    }
                    Text("Only the delivery provider receives your destination. The merchant receives the courier’s identity and pickup reference.").font(.caption).foregroundStyle(MarketTheme.muted)
                    MarketInlineError()
                    if let error { Text(error).foregroundStyle(.red).font(.caption) }
                    Button("Request delivery") {
                        guard let service = services.first(where: { $0.id == selected }) else { return }
                        do { _ = try destination.projection(); error = nil; store.requestDelivery(sourceOrderID: order.id, listing: service, destination: destination) { success in if success { dismiss() } } }
                        catch { self.error = error.localizedDescription }
                    }.buttonStyle(PrimaryButton()).disabled(store.busy || !services.contains(where: { $0.id == selected }) || destination.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.padding(24)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Arrange delivery").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .onAppear { if prior == nil { prior = (store.snapshot.query, store.snapshot.side, store.snapshot.aiSearch); store.filter(query: "", side: "offer") } }
                .onDisappear { if let prior { store.filter(query: prior.query, side: prior.side, aiSearch: prior.ai) } }
        }
    }
}
