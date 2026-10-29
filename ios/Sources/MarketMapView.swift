import SwiftUI
import WebKit

#if os(macOS)
typealias MarketMapRepresentable = NSViewRepresentable
#else
typealias MarketMapRepresentable = UIViewRepresentable
#endif

/// Only public markers cross this bridge. Account keys and messages never enter WebKit.
struct MarketMapView: MarketMapRepresentable {
    let listings: [MarketListing]
    let onSelect: (MarketListing) -> Void
    @Environment(\.colorScheme) private var scheme
    func makeCoordinator() -> Coordinator { Coordinator() }
    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateNSView(_ nsView: WKWebView, context: Context) { updateWebView(context: context) }
    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) { dismantleWebView(nsView) }
    #else
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateUIView(_ uiView: WKWebView, context: Context) { updateWebView(context: context) }
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) { dismantleWebView(uiView) }
    #endif

    private func makeWebView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "marketMap")
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        #if !os(macOS)
        web.isOpaque = false
        web.backgroundColor = .clear
        #endif
        web.underPageBackgroundColor = .clear
        context.coordinator.web = web
        context.coordinator.update(listings: listings, dark: scheme == .dark, onSelect: onSelect)
        web.load(URLRequest(url: URL(string: "https://market.iris.to/native-map?native=1&cache=512&theme=\(scheme == .dark ? "dark" : "light")")!))
        return web
    }
    private func updateWebView(context: Context) {
        context.coordinator.update(listings: listings, dark: scheme == .dark, onSelect: onSelect)
        context.coordinator.send()
    }
    private static func dismantleWebView(_ web: WKWebView) {
        web.stopLoading(); web.configuration.userContentController.removeScriptMessageHandler(forName: "marketMap"); web.navigationDelegate = nil
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var web: WKWebView?
        private var listings: [MarketListing] = []
        private var dark = false
        private var ready = false
        private var callback: ((MarketListing) -> Void)?
        private var lastPayload = ""
        func update(listings: [MarketListing], dark: Bool, onSelect: @escaping (MarketListing) -> Void) { self.listings = listings; self.dark = dark; callback = onSelect }
        private func trusted(_ url: URL?) -> Bool { url?.scheme == "https" && url?.host == "market.iris.to" && url?.port == nil && url?.user == nil && url?.password == nil && ["/native-map", "/native-map.html"].contains(url?.path ?? "") }
        func send() {
            guard ready, let web, trusted(web.url) else { return }
            let markers: [[String: Any]] = listings.compactMap { listing in
                guard let coordinates = listing.coordinates, coordinates.count == 2, coordinates.allSatisfy(\.isFinite) else { return nil }
                return ["id": listing.id, "title": listing.title, "coordinates": coordinates]
            }
            guard let data = try? JSONSerialization.data(withJSONObject: markers, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8) else { return }
            let script = "window.marketMap?.setListings(\(json));window.marketMap?.setDark(\(dark ? "true" : "false"));"
            guard script != lastPayload else { return }; lastPayload = script
            web.evaluateJavaScript(script, completionHandler: nil)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), trusted(web?.url), let value = message.body as? [String: Any] else { return }
            if value["type"] as? String == "ready" { ready = true; lastPayload = ""; send() }
            if value["type"] as? String == "select", let id = value["id"] as? String, let listing = listings.first(where: { $0.id == id }) { callback?(listing) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if trusted(navigationAction.request.url) && navigationAction.targetFrame?.isMainFrame != false { decisionHandler(.allow) }
            else {
                if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, url.scheme == "https" { MarketPlatform.openExternalURL(url) }
                decisionHandler(.cancel)
            }
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { ready = false; lastPayload = "" }
    }
}
