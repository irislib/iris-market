import SwiftUI
import WebKit
import CryptoKit

struct EscrowInboxCards: View {
    @EnvironmentObject private var store: MarketStore
    @State private var selected: String?
    var peer: String? = nil
    var listing: String? = nil
    var jobsOnly = false
    private var invites: [EscrowCard] {
        store.snapshot.escrowCards.filter { card in
            let d = card.deal
            if jobsOnly && d.provider != store.snapshot.publicKey { return false }
            if let peer, ![d.buyer, d.seller, d.provider].contains(peer) { return false }
            if let listing, let id = d.listingId, listing != id && listing != "30402:" + id { return false }
            return true
        }
    }
    var body: some View {
        if jobsOnly && invites.isEmpty {
            MarketEmptyState(symbol: "lock.shield.fill", title: "No escrow jobs yet", description: "Private invitations to provide escrow appear here. You choose which jobs to accept.")
        }
        ForEach(invites) { card in
            let role = card.deal.provider == store.snapshot.publicKey ? "Escrow job" : "Escrow"
            let amount = card.deal.sats.map { $0.formatted() + " sats" }
            let label = [role, card.deal.title, amount, card.status].compactMap { $0 }.joined(separator: " · ")
            Button { selected = card.id } label: { Label(label, systemImage: "lock.shield.fill") }
        }.marketPage(isPresented: Binding(get:{selected != nil},set:{if !$0 { selected=nil }})) {
            if let selected { MarketplaceEscrowView(tradeID:selected).marketSheetScope() }
        }
    }
}

struct EscrowCheckout {
    let quantity: Int
    let note: String
    var delivery: MarketDeliveryRequest?
    var resumeOrder: MarketOrder?

    var selection: [String: Any] {
        var value: [String: Any] = ["quantity": quantity, "note": note]
        if let resumeOrder {
            value["resume"] = true
            value["provider"] = resumeOrder.escrowProvider
        }
        return value
    }
}

struct MarketplaceEscrowView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    var listingID: String? = nil
    var tradeID: String? = nil
    var checkout: EscrowCheckout?
    var onOrderCreated: ((String) -> Void)?
    @State private var chatPeer: String?
    var body: some View {
        MarketNavigationContainer {
            EscrowWeb(store:store, owner:store.snapshot.publicKey, listingID:listingID, tradeID:tradeID, checkout:checkout, onOrderCreated:onOrderCreated, onContact:{ chatPeer = $0 }, revision:UInt64(store.snapshot.tradeSteps?.count ?? 0))
                .navigationTitle("Escrow trade").marketInlineTitle()
                .toolbar { ToolbarItem(placement:.cancellationAction) { MarketDoneButton { dismiss() } } }
                .marketPage(isPresented: Binding(get: { chatPeer != nil }, set: { if !$0 { chatPeer = nil } })) {
                    if let peer = chatPeer {
                        ConversationView(conversation: store.snapshot.conversations.first { $0.id == peer } ?? MarketConversation(id: peer, name: "Conversation", messages: []),
                            context: nil, threadKey: "general").marketSheetScope()
                    }
                }
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
    let store: MarketStore, owner: String, listingID: String?, tradeID: String?, checkout: EscrowCheckout?, onOrderCreated: ((String) -> Void)?, onContact: (String) -> Void, revision: UInt64
    @MainActor func makeCoordinator() -> Controller { Controller(store:store,owner:owner,listing:listingID,trade:tradeID,checkout:checkout,onOrderCreated:onOrderCreated,onContact:onContact) }
    @MainActor final class Controller: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
        let store: MarketStore, owner: String, listing: String?
        let checkout: EscrowCheckout?
        let onOrderCreated: ((String) -> Void)?
        let onContact: (String) -> Void
        var trade: String?
        weak var web: WKWebView?
        var revision: UInt64 = 0
        let wallet = EscrowWalletSession()
        let index = Bundle.main.url(forResource:"index",withExtension:"html",subdirectory:"escrow")
        init(store: MarketStore, owner: String, listing: String?, trade: String?, checkout: EscrowCheckout?, onOrderCreated: ((String) -> Void)?, onContact: @escaping (String) -> Void) {
            self.store = store; self.owner = owner; self.listing = listing; self.trade = trade
            self.checkout = checkout; self.onOrderCreated = onOrderCreated; self.onContact = onContact
        }
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
            case "selection":
                var selection: [String: Any] = [:]
                selection["listing_id"] = listing
                selection["trade_id"] = trade
                selection["order"] = checkout?.selection
                return selection
            case "createOrder":
                guard let checkout, let listing, let id, let provider = args["provider"] as? String,
                      store.snapshot.settings.escrowUi, (trade == nil || trade == id), args["listing_id"] as? String == listing,
                      args["quantity"] as? Int == checkout.quantity, args["note"] as? String == checkout.note else { throw CancellationError() }
                func matchingOrder() -> MarketOrder? {
                    store.snapshot.orders.first { $0.escrowTradeId == id && $0.escrowProvider == provider && $0.buyer == owner &&
                        $0.items.first?.id == listing && $0.items.first?.quantity == checkout.quantity && $0.note == checkout.note }
                }
                if let existing = matchingOrder() {
                    if checkout.resumeOrder == nil { onOrderCreated?(existing.id) }
                    return existing.id
                }
                guard checkout.resumeOrder == nil else { throw MarketRouteError.message("The order changed. Reopen it to continue.") }
                var request: [String: Any] = ["type":"request_order", "listing_id":listing, "escrow_trade_id":id,
                    "escrow_provider":provider, "quantity":checkout.quantity, "note":checkout.note]
                if let delivery = checkout.delivery { request["delivery_request"] = try delivery.projection() }
                let ok = await withCheckedContinuation { c in store.command(request) { c.resume(returning: $0) } }
                guard ok, let order = matchingOrder() else { throw MarketRouteError.message(store.alert ?? "Could not save this order.") }
                onOrderCreated?(order.id)
                return order.id
            case "acceptOrder":
                guard store.snapshot.settings.escrowUi, let trade, trade == id,
                      let order = store.snapshot.orders.first(where: { $0.id == args["id"] as? String && $0.seller == owner }),
                      order.escrowProvider == args["provider"] as? String,
                      let card = store.snapshot.escrowCards.first(where: { $0.id == trade && $0.matches(order) }),
                      card.status != "Declined", ["requested", "accepted", "in-transit"].contains(order.status)
                else { throw MarketRouteError.message("Review the current order and its provider before accepting.") }
                if order.status == "requested" {
                    let ok = await withCheckedContinuation { c in store.updateOrder(order.id, patch: ["status":"accepted"]) { c.resume(returning: $0) } }
                    guard ok else { throw MarketRouteError.message(store.alert ?? "Could not accept this order.") }
                }
                return true
            case "order":
                guard let order = store.snapshot.orders.first(where: { $0.id == args["id"] as? String }),
                      [order.buyer, order.seller].contains(owner), let item = order.items.first,
                      let provider = order.escrowProvider, let trade = order.escrowTradeId else {
                    throw MarketRouteError.message("The linked order has not reached this device yet.")
                }
                return ["id":order.id, "buyer":order.buyer, "seller":order.seller, "listing_id":item.id,
                    "provider":provider, "trade_id":trade, "status":order.status, "quantity":item.quantity] as [String: Any]
            case "contact":
                guard let peer = args["peer"] as? String, peer != owner, let trade, trade == id,
                      store.snapshot.escrowCards.contains(where: { $0.id == trade && [$0.deal.buyer, $0.deal.seller, $0.deal.provider].contains(peer) })
                else { throw MarketRouteError.message("Choose another participant in this trade.") }
                let ok = await withCheckedContinuation { c in store.command(["type":"contact","author":peer]) { c.resume(returning: $0) } }
                guard ok else { throw MarketRouteError.message(store.alert ?? "Could not open this conversation.") }
                onContact(peer)
                return true
            case "context":
                var mints=["https://mint.coinos.io","https://testnut.cashu.space"]
                #if DEBUG
                if let local=ProcessInfo.processInfo.environment["MARKET_ESCROW_TEST_MINT"],local.hasPrefix("http://127.0.0.1:") {mints.insert(local,at:0)}
                #endif
                let names = store.snapshot.people.mapValues(\.name)
                var contacts: [String: [String: Any]] = [:]
                for (key, name) in names where !name.isEmpty { contacts[key] = ["id": key, "name": name] }
                for chat in store.snapshot.conversations {
                    contacts[chat.id] = ["id": chat.id, "name": names[chat.id] ?? chat.name, "contact": true]
                }
                return ["enabled":true, "canProvide":store.snapshot.canSign, "allowFunding":store.snapshot.settings.escrowUi, "names":names, "owner":owner,
                    "contacts":Array(contacts.values), "mints":mints] as [String:Any]
            case "discoverProviders":
                guard trade == nil, store.snapshot.settings.escrowUi, let listing, listing == args["listing_id"] as? String else { throw CancellationError() }
                let ok = await withCheckedContinuation { c in store.command(["type":"discover_escrow_providers"]) { c.resume(returning: $0) } }
                guard ok else { throw MarketRouteError.message(store.alert ?? "Could not check public escrow services.") }
                let result = try parse(await store.escrowRead("listing", value: listing, owner: owner)) as? [String: Any]
                return result?["escrow_candidates"] as? [[String: Any]] ?? []
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
                let op = args["op"] as? String
                if op == "fund" && !store.snapshot.settings.escrowUi { throw MarketRouteError.message("Enable escrow in Settings before funding this order.") }
                if ["fund", "prepare", "cosign", "complete"].contains(op ?? "") && !store.snapshot.messagingReady {
                    throw MarketRouteError.message("Approve this device for private messages before moving funds.")
                }
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
