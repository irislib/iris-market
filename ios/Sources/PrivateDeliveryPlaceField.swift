import SwiftUI

struct PrivateDeliveryPlaceField: View {
    @Binding var place: MarketDeliveryPlace
    @State private var choosing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(place.label).font(.headline)
            TextField("Address or meeting point", text: Binding(get: { place.address }, set: { place.address = String($0.prefix(500)); place.coordinates = nil }), axis: .vertical).lineLimit(2...4).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("deliveryPlaceAddress." + place.label.lowercased())
            Button { choosing = true } label: { Label(place.coordinates == nil ? "Choose on map" : "Edit map point", systemImage: "mappin.and.ellipse") }
            if place.coordinates != nil { Text("Map point selected").font(.caption).foregroundStyle(MarketTheme.muted) }
        }.sheet(isPresented: $choosing) { PrivatePlaceMapEditor(place: Binding(get: { place }, set: { if let value = $0 { place = value } })).marketSheetScope() }
    }
}

import WebKit
import CoreLocation

/// An isolated private meeting-point draft. No account or order identifier enters the map.
struct PrivatePlaceMapEditor: View {
    @Binding var place: MarketDeliveryPlace?
    @Environment(\.dismiss) private var dismiss
    @State private var failed = false
    @State private var retry = 0
    var body: some View {
        NavigationStack {
            ZStack {
                PrivatePlaceMapContent(place: $place, retry: retry, onFailure: { failed = true })
                if failed { MarketMapUnavailable { failed = false; retry += 1 } }
            }.navigationTitle("Choose a place").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct PrivatePlaceMapContent: MarketMapRepresentable {
    @Binding var place: MarketDeliveryPlace?
    let retry: Int
    let onFailure: () -> Void
    @Environment(\.colorScheme) private var scheme
    func makeCoordinator() -> Coordinator { Coordinator() }
    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { make(context) }
    func updateNSView(_ view: WKWebView, context: Context) { update(context) }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { coordinator.close() }
    #else
    func makeUIView(context: Context) -> WKWebView { make(context) }
    func updateUIView(_ view: WKWebView, context: Context) { update(context) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { coordinator.close() }
    #endif
    private func make(_ context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "marketMap")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        update(context)
        return web
    }
    private func update(_ context: Context) {
        let coordinator = context.coordinator
        coordinator.changed = { place = $0 }; coordinator.failure = onFailure
        coordinator.update(place: place, dark: scheme == .dark, retry: retry)
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, CLLocationManagerDelegate {
        weak var web: WKWebView?
        var changed: ((MarketDeliveryPlace?) -> Void)?
        var failure: (() -> Void)?
        private var place: MarketDeliveryPlace?
        private var dark = false, ready = false, closed = false
        private var retry = -1
        private var manager: CLLocationManager?
        private var locationID: String?
        private var readinessTimer: Timer?
        private func trusted(_ url: URL?) -> Bool {
            guard let url, url.scheme == "https", url.host == "market.iris.to", url.port == nil, url.user == nil, url.password == nil,
                  ["/native-map", "/native-map.html"].contains(url.path) else { return false }
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "mode" })?.value == "place"
        }
        func update(place: MarketDeliveryPlace?, dark: Bool, retry: Int) {
            guard !closed else { return }
            let needsUpdate = self.place != place || self.dark != dark
            self.place = place; self.dark = dark
            if self.retry != retry {
                self.retry = retry; ready = false
                web?.load(URLRequest(url: URL(string: "https://market.iris.to/native-map?native=1&mode=place&theme=\(dark ? "dark" : "light")")!))
            } else if needsUpdate { send() }
        }
        private func send() {
            guard ready, !closed, trusted(web?.url) else { return }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            guard let raw = try? encoder.encode(place), let json = String(data: raw, encoding: .utf8) else { return }
            web?.evaluateJavaScript("window.marketPlace?.setValue(\(json));window.marketPlace?.setDark(\(dark));", completionHandler: nil)
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !closed, message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), trusted(web?.url),
                  let value = message.body as? [String: Any], let type = value["type"] as? String else { return }
            if type == "ready", value["mode"] as? String == "place", value["version"] as? Int == 1 { ready = true; readinessTimer?.invalidate(); send() }
            else if type == "place", Set(value.keys).isSubset(of: ["type", "place"]), let area = value["place"],
                    JSONSerialization.isValidJSONObject(["area": area]),
                    let data = try? JSONSerialization.data(withJSONObject: area, options: [.fragmentsAllowed]), data.count <= 4096 {
                if area is NSNull { place = nil; changed?(nil) }
                else if let decoded = try? JSONDecoder().decode(MarketDeliveryPlace.self, from: data), decoded.label.count <= 120, decoded.address.count <= 500, decoded.coordinates == nil || MarketShipment.validCoordinates(decoded.coordinates) { place = decoded; changed?(decoded) }
            } else if type == "locate", let id = value["id"] as? String, id.count <= 20, id.allSatisfy(\.isNumber) {
                if let previous = locationID { finishLocation(previous, point: nil) }
                locationID = id
                let next = manager ?? CLLocationManager(); manager = next; next.delegate = self
                next.desiredAccuracy = kCLLocationAccuracyHundredMeters
                switch next.authorizationStatus {
                case .authorizedAlways, .authorizedWhenInUse: next.requestLocation()
                case .notDetermined: next.requestWhenInUseAuthorization()
                default: finishLocation(id, point: nil)
                }
            }
        }
        func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
            guard let id = locationID, !closed else { return }
            switch manager.authorizationStatus {
            case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
            case .denied, .restricted: finishLocation(id, point: nil)
            default: break
            }
        }
        func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            guard let id = locationID else { return }
            guard let location = locations.last, abs(location.timestamp.timeIntervalSinceNow) < 120, location.horizontalAccuracy >= 0,
                  CLLocationCoordinate2DIsValid(location.coordinate) else { finishLocation(id, point: nil); return }
            finishLocation(id, point: [location.coordinate.longitude, location.coordinate.latitude])
        }
        func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { if let id = locationID { finishLocation(id, point: nil) } }
        private func finishLocation(_ id: String, point: [Double]?) {
            locationID = nil; manager?.stopUpdatingLocation()
            guard !closed, ready, trusted(web?.url), let data = try? JSONSerialization.data(withJSONObject: ["id": id, "point": point as Any? ?? NSNull()]),
                  let raw = String(data: data, encoding: .utf8) else { return }
            web?.evaluateJavaScript("(()=>{const v=\(raw);window.marketPlace?.setLocation(v.id,v.point);})();", completionHandler: nil)
        }
        func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(!closed && trusted(action.request.url) && action.targetFrame?.isMainFrame != false ? .allow : .cancel) }
        func webView(_ view: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            ready = false; locationID = nil; manager?.stopUpdatingLocation(); readinessTimer?.invalidate()
            readinessTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in guard let self, !self.closed, !self.ready else { return }; self.failure?() }
        }
        func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 { failure?(); decisionHandler(.cancel) } else { decisionHandler(closed ? .cancel : .allow) }
        }
        func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { failure?() } }
        func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failure?() }
        func webViewWebContentProcessDidTerminate(_ view: WKWebView) { failure?() }
        func close() { closed = true; readinessTimer?.invalidate(); manager?.stopUpdatingLocation(); manager?.delegate = nil; locationID = nil; web?.stopLoading(); web?.configuration.userContentController.removeScriptMessageHandler(forName: "marketMap"); web?.navigationDelegate = nil; web = nil }
    }
}
