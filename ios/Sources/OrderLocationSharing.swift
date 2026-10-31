import SwiftUI
import CoreLocation

/// No background mode: explicit foreground samples are discarded when the order view closes.
@MainActor private final class OrderLocationSession: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var sharing = false
    @Published var error: String?
    private var manager: CLLocationManager?
    private var expiry: Timer?
    private var wanted = false
    private var lastSample = Date.distantPast
    var publish: (([Double]) -> Void)?
    var cleared: (() -> Void)?
    func start() {
        guard !sharing else { return }
        error = nil; wanted = true
        if manager == nil { manager = CLLocationManager(); manager?.delegate = self; manager?.desiredAccuracy = kCLLocationAccuracyHundredMeters; manager?.distanceFilter = 10 }
        guard CLLocationManager.locationServicesEnabled(), let manager else { fail("Turn on location services to share your position."); return }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: begin()
        default: fail("Allow location access in system settings to share your position.")
        }
    }
    private func begin() {
        guard wanted, !sharing else { return }; sharing = true; lastSample = .distantPast; manager?.startUpdatingLocation()
        expiry?.invalidate(); expiry = Timer.scheduledTimer(withTimeInterval: 3600, repeats: false) { [weak self] _ in Task { @MainActor in self?.stop() } }
    }
    func stop(publishClear: Bool = true) {
        let wasSharing = sharing; wanted = false; sharing = false; manager?.stopUpdatingLocation(); expiry?.invalidate(); expiry = nil
        if wasSharing && publishClear { cleared?() }
    }
    func fail(_ text: String) { stop(); error = text }
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let authorization = manager.authorizationStatus
        Task { @MainActor in guard self.wanted else { return }; switch authorization { case .authorizedAlways, .authorizedWhenInUse: self.begin(); case .denied, .restricted: self.fail("Location access was not granted."); default: break } }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            guard self.sharing, Date().timeIntervalSince(self.lastSample) >= 15, location.timestamp.timeIntervalSinceNow <= 0, location.timestamp.timeIntervalSinceNow > -120, location.horizontalAccuracy >= 0, CLLocationCoordinate2DIsValid(location.coordinate) else { return }
            self.lastSample = Date(); self.publish?([location.coordinate.longitude, location.coordinate.latitude])
        }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { Task { @MainActor in self.fail("Could not get your position. Try sharing again.") } }
}

struct OrderLocationSharing: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.scenePhase) private var phase
    @StateObject private var session = OrderLocationSession()
    @State private var stopID = ""
    let order: MarketOrder
    var active = true
    private var eligible: [MarketShipmentStop] { order.shipment.stops.filter { $0.status != "completed" && (order.seller == store.snapshot.publicKey || $0.courierPubkey == store.snapshot.publicKey) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if eligible.count > 1 { Picker("Share for stop", selection: $stopID) { ForEach(eligible) { Text($0.label.isEmpty ? "Delivery stop" : $0.label).tag($0.id) } }.disabled(session.sharing) }
            Button { if session.sharing { session.stop() } else if phase == .active && active { configure(); session.start() } } label: { Label(session.sharing ? "Stop sharing location" : "Share live location", systemImage: session.sharing ? "location.slash.fill" : "location.fill") }.disabled(eligible.isEmpty || !active || store.demo)
            Text(session.sharing ? "Shared privately while this order stays open. Stops after one hour." : "Your position is shared only after you choose to start.").font(.caption).foregroundStyle(MarketTheme.muted)
            if let error = session.error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .onAppear { stopID = eligible.first?.id ?? ""; configure() }
        .onDisappear { session.stop(publishClear: !order.terminal) }
        .onChange(of: phase) { value in if value != .active { session.stop() } }
        .onChange(of: active) { value in if !value { session.stop() } }
        .onChange(of: order) { value in if value.terminal || !eligible.contains(where: { $0.id == stopID }) { session.stop(publishClear: !value.terminal); stopID = eligible.first?.id ?? "" }; configure() }
        .onChange(of: stopID) { _ in session.stop(); configure() }
    }
    private func configure() {
        let id = order.id, stop = stopID, targetStore = store
        session.publish = { [weak current = session] coordinates in targetStore.updateOrder(id, patch: ["location": ["coordinates": coordinates, "stopId": stop]]) { success in if !success { current?.fail("Location sharing stopped. Reopen the order to try again.") } } }
        session.cleared = { targetStore.updateOrder(id, patch: ["location": NSNull()]) }
    }
}
