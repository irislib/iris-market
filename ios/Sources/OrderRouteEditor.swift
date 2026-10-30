import SwiftUI

struct OrderRouteEditor: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let order: MarketOrder
    @State private var stops: [MarketStopDraft]
    @State private var tracking: String
    @State private var hasETA: Bool
    @State private var eta: Date
    @State private var error: String?
    init(order: MarketOrder) {
        self.order = order
        _stops = State(initialValue: order.shipment.stops.map { MarketStopDraft(stop: $0) })
        _tracking = State(initialValue: order.shipment.trackingUrl ?? "")
        _hasETA = State(initialValue: order.shipment.eta != nil)
        _eta = State(initialValue: order.shipment.eta.map { Date(timeIntervalSince1970: Double($0)) } ?? Date())
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach($stops) { $stop in
                        StopEditor(stop: $stop, number: (stops.firstIndex { $0.id == stop.id } ?? 0) + 1, people: store.snapshot.people, owner: store.snapshot.publicKey,
                                   remove: { stops.removeAll { $0.id == stop.id } }, moveUp: { moveUp(stop.id) })
                    }
                    if stops.count < 12 { Button { stops.append(MarketStopDraft()) } label: { Label("Add stop", systemImage: "plus") }.buttonStyle(PrimaryButton(dark: false)).accessibilityIdentifier("addDeliveryStop") }
                    TextField("Tracking link · optional", text: $tracking).marketURLKeyboard().marketNoAutocapitalization().autocorrectionDisabled().padding(15).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 15))
                    Toggle("Expected arrival", isOn: $hasETA)
                    if hasETA { DatePicker("Arrival", selection: $eta, displayedComponents: [.date, .hourAndMinute]).labelsHidden() }
                    if let error { Text(error).font(.system(size: 13)).foregroundStyle(.red) }
                    MarketInlineError()
                    Button { save() } label: { Text("Save route") }.buttonStyle(PrimaryButton()).disabled(store.busy || store.demo).accessibilityIdentifier("saveDeliveryRoute")
                }.padding(24)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Delivery route").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
    private func moveUp(_ id: String) { if let index = stops.firstIndex(where: { $0.id == id }), index > 0 { stops.swapAt(index, index - 1) } }
    private func save() {
        do {
            let patch = try marketRoutePatch(stops: stops, tracking: tracking, eta: hasETA ? eta : nil)
            error = nil
            store.updateOrder(order.id, patch: patch) { if $0 { dismiss() } }
        } catch { self.error = error.localizedDescription }
    }
}

private struct StopEditor: View {
    @Binding var stop: MarketStopDraft
    let number: Int
    let people: [String: MarketPerson]
    let owner: String
    let remove: () -> Void
    let moveUp: () -> Void
    @State private var showPosition = false
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack {
                Text("Stop \(number)").font(.system(size: 15, weight: .semibold)); Spacer()
                if number > 1 { Button(action: moveUp) { Image(systemName: "arrow.up") }.accessibilityLabel("Move stop \(number) up") }
                Button(action: remove) { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove stop \(number)")
            }
            TextField("Stop name", text: $stop.label)
            TextField("Address", text: $stop.address, axis: .vertical).lineLimit(1...3)
            DisclosureGroup("Map position", isExpanded: $showPosition) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Latitude", text: $stop.latitude).marketNoAutocapitalization().autocorrectionDisabled()
                    TextField("Longitude", text: $stop.longitude).marketNoAutocapitalization().autocorrectionDisabled()
                }.padding(.top, 12)
            }.font(.system(size: 13))
            if !stop.courier.isEmpty { UserRow(person: people[stop.courier] ?? .unnamed(stop.courier), subtitle: "Courier", size: 32) }
            Menu {
                Button("No courier") { stop.courier = "" }
                Button("I'll handle this stop") { stop.courier = owner }
                ForEach(people.values.filter { $0.author != owner }.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }.prefix(80)) { person in
                    Button { stop.courier = person.author } label: { Text(person.displayName) }
                }
            } label: { Label(stop.courier.isEmpty ? "Assign courier" : "Change courier", systemImage: "person.crop.circle") }.font(.system(size: 13, weight: .medium))
        }.textFieldStyle(.plain).padding(18).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
            .onAppear { showPosition = !stop.latitude.isEmpty || !stop.longitude.isEmpty }
    }
}
