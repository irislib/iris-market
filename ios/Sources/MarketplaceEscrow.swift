import SwiftUI
import WebKit
import CryptoKit

struct EscrowInboxCards: View {
    @EnvironmentObject private var store: MarketStore
    @State private var selected: String?
    var peer: String? = nil
    var listing: String? = nil
    private struct Card: Identifiable { let id: String; let label: String }
    private var invites: [Card] {
        var seen=Set<String>()
        let rows=store.snapshot.tradeSteps ?? []
        let joined=Set(rows.filter { $0.mine && $0.step.action=="join" }.map { $0.step.tradeId })
        return rows.reversed().compactMap { row in
            guard store.snapshot.settings.escrowUi || joined.contains(row.step.tradeId) else {return nil}
            guard row.step.action == "invite", let d=row.step.deal, let title=d.title, !title.isEmpty,
                  d.taker == (row.mine ? store.snapshot.publicKey : row.peer),
                  [d.buyer,d.seller,d.provider].contains(store.snapshot.publicKey) else { return nil }
            if let peer, ![d.buyer,d.seller,d.provider].contains(peer) { return nil }
            if let listing, let id=d.listingId, listing != id && listing != "30402:" + id { return nil }
            guard seen.insert(row.step.tradeId).inserted else { return nil }
            let status = row.step.outcome == "release" ? "Release receipt" : row.step.outcome == "refund" ? "Refund receipt" : joined.contains(row.step.tradeId) ? "In progress" : "Invitation"
            let amount = d.sats.map { $0.formatted() + " sats" }
            return Card(id: row.step.tradeId, label: ["Escrow", title, amount, status].compactMap { $0 }.joined(separator: " · "))
        }
    }
    var body: some View {
        ForEach(invites) { card in
            Button { selected=card.id } label: { Label(card.label,systemImage:"lock.shield.fill") }
        }.marketPage(isPresented: Binding(get:{selected != nil},set:{if !$0 { selected=nil }})) {
            if let selected { MarketplaceEscrowView(tradeID:selected).marketSheetScope() }
        }
    }
}

struct MarketplaceEscrowView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    var listingID: String? = nil
    var tradeID: String? = nil
    var body: some View {
        MarketNavigationContainer {
            EscrowWeb(store:store, owner:store.snapshot.publicKey, listingID:listingID, tradeID:tradeID, revision:UInt64(store.snapshot.tradeSteps?.count ?? 0))
                .navigationTitle("Escrow trade").marketInlineTitle()
                .toolbar { ToolbarItem(placement:.cancellationAction) { MarketDoneButton { dismiss() } } }
                .onChange(of:store.snapshot.publicKey) { _ in dismiss() }
        }
    }
}
private actor EscrowWalletSession {
    private var wallet: MarketWallet?
    func call(_ request: String, material: WalletCredentials.Material) throws -> String {
        if wallet == nil { wallet = try MarketWallet(baseDir:material.baseDirectory.path,ownerPublicKey:material.owner,devicePublicKey:material.device,seed:material.seed) }
        guard let wallet else { throw CancellationError() }
        return try wallet.escrow(request:request)
    }
}
private struct EscrowWeb {
    let store: MarketStore, owner: String, listingID: String?, tradeID: String?, revision: UInt64
    @MainActor func makeCoordinator() -> Controller { Controller(store:store,owner:owner,listing:listingID,trade:tradeID) }
    @MainActor final class Controller: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        let store: MarketStore, owner: String, listing: String?
        var trade: String?
        weak var web: WKWebView?
        var revision: UInt64 = 0
        let wallet = EscrowWalletSession()
        let index = Bundle.main.url(forResource:"index",withExtension:"html",subdirectory:"escrow")
        init(store: MarketStore, owner:String, listing:String?, trade:String?) { self.store=store;self.owner=owner;self.listing=listing;self.trade=trade }
        private var permitted: Bool {
            store.snapshot.settings.escrowUi || (trade != nil && store.snapshot.tradeSteps?.contains { $0.mine && $0.step.tradeId==trade && $0.step.action=="join" } == true)
        }
        func begin() -> WKWebView {
            let config=WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"escrow")
            let view=WKWebView(frame:.zero,configuration:config)
            view.navigationDelegate=self;web=view
            if let index { view.loadFileURL(index,allowingReadAccessTo:index.deletingLastPathComponent()) }
            return view
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
            decisionHandler(navigationAction.targetFrame?.isMainFrame==true && navigationAction.request.url?.standardizedFileURL==index?.standardizedFileURL ? .allow : .cancel)
        }
        func update(_ next:UInt64) { if revision != next { revision=next; web?.evaluateJavaScript("window.escrowRefresh?.()") } }
        func stop() { web?.configuration.userContentController.removeScriptMessageHandler(forName:"escrow",contentWorld:.page);web?.navigationDelegate=nil;web=nil }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?,String?)->Void) {
            guard web != nil, message.frameInfo.isMainFrame, message.frameInfo.request.url?.standardizedFileURL==index?.standardizedFileURL,
                  store.snapshot.publicKey==owner, permitted, !store.demo,
                  let raw=message.body as? String, raw.utf8.count<350_000,
                  let obj=try? JSONSerialization.jsonObject(with:Data(raw.utf8)) as? [String:Any],let method=obj["method"] as? String else { replyHandler(nil,"Close this trade and reopen it.");return }
            let args=obj["args"] as? [String:Any] ?? [:]
            Task { @MainActor in
                do { let result=try await self.call(method,args);guard self.web != nil,self.store.snapshot.publicKey==self.owner else {throw CancellationError()}
                    replyHandler(try self.encode(["result":result]),nil)
                } catch { replyHandler(nil,marketErrorMessage(error)) }
            }
        }
        private func encode(_ value: Any) throws -> String { String(decoding:try JSONSerialization.data(withJSONObject:value),as:UTF8.self) }
        private func parse(_ raw: String) throws -> Any { try JSONSerialization.jsonObject(with:Data(raw.utf8)) }
        private func call(_ method:String,_ args:[String:Any]) async throws -> Any {
            let id=args["trade_id"] as? String
            switch method {
            case "selection": return trade.map {["trade_id":$0]} ?? ["listing_id":listing ?? ""]
            case "context":
                var mints=["https://mint.coinos.io","https://testnut.cashu.space"]
                #if DEBUG
                if let local=ProcessInfo.processInfo.environment["MARKET_ESCROW_TEST_MINT"],local.hasPrefix("http://127.0.0.1:") {mints.insert(local,at:0)}
                #endif
                return ["enabled":true,"allowFunding":store.snapshot.settings.escrowUi,"names":store.snapshot.people.mapValues(\.name),"owner":owner,"contacts":store.snapshot.conversations.map {["id":$0.id,"name":store.snapshot.people[$0.id]?.name ?? $0.name]},"mints":mints] as [String:Any]
            case "profileKey":return try escrowProfileKey(value:args["value"] as? String ?? "")
            case "records":
                guard let trade,id==trade else {throw CancellationError()}
                let raw=try await store.escrowRead("records",value:"",owner:owner)
                let rows=try parse(raw) as? [[String:Any]] ?? []
                return rows.filter {($0["step"] as? [String:Any])?["trade_id"] as? String == trade}
            case "listing": return try parse(await store.escrowRead("listing",value:args["id"] as? String ?? "",owner:owner,refresh:args["latest"] as? Bool == true))
            case "certificate": return try parse(await store.escrowRead("certificate",value:args["key"] as? String ?? "",owner:owner))
            case "send":
                guard let step=args["step"] as? [String:Any],let next=step["trade_id"] as? String,let peers=args["peers"] as? [String],let operation=args["operation_id"] as? String else {throw CancellationError()}
                if trade == nil {guard step["action"] as? String=="invite",let deal=step["deal"] as? [String:Any],deal["listing_id"] as? String==listing,deal["taker"] as? String==owner else {throw CancellationError()}}
                else if trade != next {throw CancellationError()}
                let ok=await withCheckedContinuation { c in store.command(["type":"send_trade_step","step":step,"peers":peers,"operation_id":operation]) {c.resume(returning:$0)} }
                guard ok else {throw NSError(domain:"IrisEscrow",code:1,userInfo:[NSLocalizedDescriptionKey:store.alert ?? "Sending failed. Reopen the trade and retry."])}
                trade=next;return true
            case "wallet":
                guard let trade,id==trade else {throw CancellationError()}
                return try parse(await wallet.call(encode(args),material:store.walletCredentials()))
            case "rate":
                guard let trade,id==trade,let profile=args["profile"] as? String,let rating=args["rating"] as? Int,(1...5).contains(rating) else {throw CancellationError()}
                _=try await store.publishReview(target:profile,rating:UInt8(rating),body:"",expectedOwner:owner);return true
            default: throw CancellationError()
            }
        }
    }
}
#if os(macOS)
extension EscrowWeb: NSViewRepresentable {
    func makeNSView(context:Context)->WKWebView { context.coordinator.begin() }
    func updateNSView(_ nsView:WKWebView,context:Context) {context.coordinator.update(revision)}
    static func dismantleNSView(_ nsView:WKWebView,coordinator:Controller){coordinator.stop()}
}
#else
extension EscrowWeb: UIViewRepresentable {
    func makeUIView(context:Context)->WKWebView {context.coordinator.begin()}
    func updateUIView(_ uiView:WKWebView,context:Context) {context.coordinator.update(revision)}
    static func dismantleUIView(_ uiView:WKWebView,coordinator:Controller){coordinator.stop()}
}
#endif
