import SwiftUI
import WebKit

/// Separate private-route renderer. It has no listing discovery or account/signing bridge.
struct ShipmentMapView: View {
    let shipment: MarketShipment
    @State private var unavailable = false
    @State private var retry = 0
    var body: some View {
        ZStack {
            ShipmentMapContent(shipment: shipment, retry: retry, onFailure: { unavailable = true })
                .opacity(unavailable ? 0 : 1).allowsHitTesting(!unavailable).accessibilityHidden(unavailable)
            if unavailable { MarketMapUnavailable { unavailable = false; retry += 1 } }
        }
    }
}

private struct ShipmentMapContent: MarketMapRepresentable {
    let shipment: MarketShipment
    let retry: Int
    let onFailure: () -> Void
    @Environment(\.colorScheme) private var scheme
    func makeCoordinator() -> Coordinator { Coordinator() }
    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateNSView(_ web: WKWebView, context: Context) { update(context.coordinator) }
    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) { coordinator.close(web) }
    #else
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateUIView(_ web: WKWebView, context: Context) { update(context.coordinator) }
    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) { coordinator.close(web) }
    #endif
    private func makeWebView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "marketMap")
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        #if !os(macOS)
        web.isOpaque = false; web.backgroundColor = .clear
        #endif
        web.underPageBackgroundColor = .clear
        context.coordinator.web = web
        update(context.coordinator)
        return web
    }
    private func update(_ coordinator: Coordinator) {
        coordinator.shipment = shipment; coordinator.dark = scheme == .dark; coordinator.onFailure = onFailure
        coordinator.load(retry: retry); coordinator.send()
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var web: WKWebView?
        var shipment: MarketShipment?
        var dark = false
        var onFailure: (() -> Void)?
        private var lastRetry = -1
        private var ready = false
        private var closed = false
        private var lastPayload = ""
        func load(retry: Int) {
            guard !closed, retry != lastRetry, let web else { return }
            lastRetry = retry
            web.load(URLRequest(url: URL(string: "https://market.iris.to/native-map?native=1&mode=shipment&cache=128&theme=\(dark ? "dark" : "light")")!))
        }
        private func trusted(_ url: URL?) -> Bool {
            guard let url, url.scheme == "https", url.host == "market.iris.to", url.port == nil, url.user == nil, url.password == nil, ["/native-map", "/native-map.html"].contains(url.path) else { return false }
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "mode" })?.value == "shipment"
        }
        func send() {
            guard !closed, ready, let web, trusted(web.url) else { return }
            let route = shipment?.mapProjection() ?? ["stops": []]
            guard let data = try? JSONSerialization.data(withJSONObject: route, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8) else { return }
            let script = "window.marketMap?.setShipment(\(json));window.marketMap?.setDark(\(dark ? "true" : "false"));"
            guard script != lastPayload else { return }
            lastPayload = script; web.evaluateJavaScript(script, completionHandler: nil)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !closed, message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), trusted(web?.url), let value = message.body as? [String: Any], value["type"] as? String == "ready" else { return }
            ready = true; lastPayload = ""; send()
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(!closed && trusted(navigationAction.request.url) && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { ready = false; lastPayload = "" }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if !closed, navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
                failed(); decisionHandler(.cancel)
            } else { decisionHandler(closed ? .cancel : .allow) }
        }
        private func failed(_ error: Error? = nil) {
            guard !closed else { return }
            if let error = error as NSError?, error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            ready = false; lastPayload = ""; onFailure?()
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failed() }
        func close(_ view: WKWebView) {
            closed = true; ready = false; shipment = nil; lastPayload = ""; onFailure = nil
            view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "marketMap")
            view.navigationDelegate = nil; view.loadHTMLString("", baseURL: nil); web = nil
        }
    }
}
