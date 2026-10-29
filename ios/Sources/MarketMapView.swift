import SwiftUI
import WebKit

#if os(macOS)
typealias MarketMapRepresentable = NSViewRepresentable
#else
typealias MarketMapRepresentable = UIViewRepresentable
#endif

/// Only public markers and signed service areas cross this bridge. Account keys and messages never enter WebKit.
struct MarketMapView: View {
    let listings: [MarketListing]
    let onSelect: (MarketListing) -> Void
    @State private var unavailable = false
    @State private var retry = 0
    var body: some View {
        ZStack {
            MarketMapContent(listings: listings, onSelect: onSelect, retry: retry, onFailure: { unavailable = true })
                .opacity(unavailable ? 0 : 1).allowsHitTesting(!unavailable).accessibilityHidden(unavailable)
            if unavailable { MarketMapUnavailable { unavailable = false; retry += 1 } }
        }
    }
}

struct MarketMapUnavailable: View {
    let retry: () -> Void
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "map.fill").font(.title2).foregroundStyle(MarketTheme.muted)
            Text("Map unavailable").font(.subheadline).foregroundStyle(MarketTheme.ink)
            Button("Try again", action: retry).buttonStyle(.bordered).accessibilityIdentifier("mapRetry")
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(MarketTheme.surface)
    }
}

private struct MarketMapContent: MarketMapRepresentable {
    let listings: [MarketListing]
    let onSelect: (MarketListing) -> Void
    let retry: Int
    let onFailure: () -> Void
    @Environment(\.colorScheme) private var scheme
    func makeCoordinator() -> Coordinator { Coordinator() }
    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateNSView(_ nsView: WKWebView, context: Context) { updateWebView(context: context) }
    static func dismantleNSView(_ nsView: WKWebView, coordinator: Coordinator) { coordinator.close(nsView) }
    #else
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateUIView(_ uiView: WKWebView, context: Context) { updateWebView(context: context) }
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) { coordinator.close(uiView) }
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
        context.coordinator.onFailure = onFailure
        context.coordinator.update(listings: listings, dark: scheme == .dark, onSelect: onSelect)
        context.coordinator.load(retry: retry)
        return web
    }
    private func updateWebView(context: Context) {
        context.coordinator.onFailure = onFailure
        context.coordinator.update(listings: listings, dark: scheme == .dark, onSelect: onSelect)
        context.coordinator.load(retry: retry)
        context.coordinator.send()
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var web: WKWebView?
        var onFailure: (() -> Void)?
        private var lastRetry = -1
        private var listings: [MarketListing] = []
        private var dark = false
        private var ready = false
        private var closed = false
        private var callback: ((MarketListing) -> Void)?
        private var lastPayload = ""
        func update(listings: [MarketListing], dark: Bool, onSelect: @escaping (MarketListing) -> Void) { self.listings = listings; self.dark = dark; callback = onSelect }
        func load(retry: Int) {
            guard !closed, retry != lastRetry, let web else { return }
            lastRetry = retry
            web.load(URLRequest(url: URL(string: "https://market.iris.to/native-map?native=1&cache=512&theme=\(dark ? "dark" : "light")")!))
        }
        private func trusted(_ url: URL?) -> Bool { url?.scheme == "https" && url?.host == "market.iris.to" && url?.port == nil && url?.user == nil && url?.password == nil && ["/native-map", "/native-map.html"].contains(url?.path ?? "") }
        func send() {
            guard !closed, ready, let web, trusted(web.url) else { return }
            var areaBytes = 0
            let markers: [[String: Any]] = listings.prefix(1000).compactMap { listing in
                var row: [String: Any] = ["id": listing.id, "title": String(listing.title.prefix(160))]
                if let point = listing.coordinates, point.count == 2, point.allSatisfy(\.isFinite), abs(point[0]) <= 180, abs(point[1]) <= 90 { row["coordinates"] = point }
                if let areas = listing.serviceAreas, let data = try? MarketJSON.encoder().encode(areas), data.count <= 32832, areaBytes + data.count <= 1048576,
                   let geometry = try? JSONSerialization.jsonObject(with: data) { row["serviceAreas"] = geometry; areaBytes += data.count }
                return row["coordinates"] != nil || row["serviceAreas"] != nil ? row : nil
            }
            guard let data = try? JSONSerialization.data(withJSONObject: markers, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8) else { return }
            let script = "window.marketMap?.setListings(\(json));window.marketMap?.setDark(\(dark ? "true" : "false"));"
            guard script != lastPayload else { return }; lastPayload = script
            web.evaluateJavaScript(script, completionHandler: nil)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !closed, message.frameInfo.isMainFrame, trusted(message.frameInfo.request.url), trusted(web?.url), let value = message.body as? [String: Any] else { return }
            if value["type"] as? String == "ready" { ready = true; lastPayload = ""; send() }
            if value["type"] as? String == "select", let id = value["id"] as? String, let listing = listings.first(where: { $0.id == id }) { callback?(listing) }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if !closed && trusted(navigationAction.request.url) && navigationAction.targetFrame?.isMainFrame != false { decisionHandler(.allow) }
            else {
                if !closed, navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url, url.scheme == "https" { MarketPlatform.openExternalURL(url) }
                decisionHandler(.cancel)
            }
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
            closed = true; ready = false; listings = []; callback = nil; onFailure = nil; lastPayload = ""
            view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "marketMap")
            view.navigationDelegate = nil; web = nil
        }
    }
}
