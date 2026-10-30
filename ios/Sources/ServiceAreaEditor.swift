import SwiftUI
import WebKit
import CoreLocation

/// Edits a local public-coverage draft. This surface cannot publish or share live location.
struct ServiceAreaEditor: View {
    @Binding var areas: MarketServiceAreas?
    @Environment(\.dismiss) private var dismiss
    @State private var failed = false
    @State private var retry = 0
    var body: some View {
        NavigationStack {
            ZStack {
                ServiceAreaContent(areas: $areas, retry: retry, onFailure: { failed = true })
                if failed { MarketMapUnavailable { failed = false; retry += 1 } }
            }.navigationTitle("Service areas").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct ServiceAreaContent: MarketMapRepresentable {
    @Binding var areas: MarketServiceAreas?
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
        coordinator.changed = { areas = $0 }; coordinator.failure = onFailure
        coordinator.update(areas: areas, dark: scheme == .dark, retry: retry)
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, CLLocationManagerDelegate {
        weak var web: WKWebView?
        var changed: ((MarketServiceAreas?) -> Void)?
        var failure: (() -> Void)?
        private var areas: MarketServiceAreas?
        private var dark = false, ready = false, closed = false
        private var retry = -1
        private var manager: CLLocationManager?
        private var locationID: String?
        private var readinessTimer: Timer?
        private func trusted(_ url: URL?) -> Bool {
            guard let url, url.scheme == "https", url.host == "market.iris.to", url.port == nil, url.user == nil, url.password == nil,
                  ["/native-map", "/native-map.html"].contains(url.path) else { return false }
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "mode" })?.value == "area"
        }
        func update(areas: MarketServiceAreas?, dark: Bool, retry: Int) {
            guard !closed else { return }
            let needsUpdate = self.areas != areas || self.dark != dark
            self.areas = areas; self.dark = dark
            if self.retry != retry {
                self.retry = retry; ready = false
                web?.load(URLRequest(url: URL(string: "https://market.iris.to/native-map?native=1&mode=area&theme=\(dark ? "dark" : "light")")!))
            } else if needsUpdate { send() }
        }
        private func send() {
            guard ready, !closed, trusted(web?.url) else { return }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            guard let raw = try? encoder.encode(areas), let json = String(data: raw, encoding: .utf8) else { return }
            web?.evaluateJavaScript("window.marketArea?.setValue(\(json));window.marketArea?.setDark(\(dark));", completionHandler: nil)
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !closed, message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), trusted(web?.url),
                  let value = message.body as? [String: Any], let type = value["type"] as? String else { return }
            if type == "ready", value["mode"] as? String == "area", value["version"] as? Int == 1 { ready = true; readinessTimer?.invalidate(); send() }
            else if type == "area", Set(value.keys).isSubset(of: ["type", "areas"]), let area = value["areas"],
                    JSONSerialization.isValidJSONObject(["area": area]),
                    let data = try? JSONSerialization.data(withJSONObject: area, options: [.fragmentsAllowed]), data.count <= 32832 {
                if area is NSNull { areas = nil; changed?(nil) }
                else if let decoded = try? JSONDecoder().decode(MarketServiceAreas.self, from: data) { areas = decoded; changed?(decoded) }
            } else if type == "locate", let id = value["id"] as? String, id.count <= 20, id.allSatisfy(\.isNumber) {
                if let previous = locationID { finishLocation(previous, point: nil) }
                locationID = id
                let next = manager ?? CLLocationManager(); manager = next; next.delegate = self
                next.desiredAccuracy = kCLLocationAccuracyKilometer
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
            web?.evaluateJavaScript("(()=>{const v=\(raw);window.marketArea?.setLocation(v.id,v.point);})();", completionHandler: nil)
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
