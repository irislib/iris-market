import SwiftUI
import UniformTypeIdentifiers

private struct OrderSelection: Identifiable { let id: String }

private struct OrderHistoryExport: Transferable {
    let orders: [MarketOrder]
    let owner: String
    let people: [String: MarketPerson]

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .commaSeparatedText) { (export: Self) in
            let csv = MarketOrderHistory.csv(export.orders, owner: export.owner) { export.people[$0]?.name ?? "" }
            return Data(csv.utf8)
        }.suggestedFileName("iris-market-orders.csv")
    }
}

struct OrdersView: View {
    @EnvironmentObject private var store: MarketStore
    @State private var section = MarketOrderList.purchases
    @State private var offerService = false
    private var jobsAvailable: Bool {
        !store.demo && (store.snapshot.settings.escrowUi || store.snapshot.escrowCards.contains { $0.joined && $0.deal.provider == store.snapshot.publicKey })
    }
    @State private var period = MarketOrderPeriod.all
    @State private var basketSeller: String?
    @State private var requestedOrder: String?
    private var historySection: Bool { [.purchases, .sales, .archived].contains(section) }
    private var selection: Binding<OrderSelection?> {
        Binding(get: { store.activeOrderID.map { OrderSelection(id: $0) } }, set: { store.activeOrderID = $0?.id })
    }
    var body: some View {
        let owner = store.snapshot.publicKey
        let sectionOrders = store.snapshot.orders.filter { section.contains($0, owner: owner) }
        let orders = historySection ? sectionOrders.filter { period.includes($0.createdAt) } : sectionOrders
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Orders").font(.system(size: 30, weight: .medium)).tracking(-1)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(MarketOrderList.allCases.filter { $0 != .escrow || jobsAvailable }, id: \.self) { value in
                            Button { section = value } label: {
                                Text(value.rawValue).font(.system(size: 13, weight: .medium)).padding(.horizontal, 14).padding(.vertical, 11)
                                    .foregroundStyle(section == value ? MarketTheme.onAction : MarketTheme.ink)
                                    .background(section == value ? MarketTheme.action : MarketTheme.surface, in: Capsule())
                            }.buttonStyle(.plain).accessibilityIdentifier("orders\(value.rawValue)")
                        }
                    }
                }
                if section == .escrow && jobsAvailable {
                    EscrowInboxCards(jobsOnly: true)
                    if store.snapshot.settings.escrowUi {
                        Button("Offer escrow services") { offerService = true }
                            .disabled(!store.snapshot.canSign)
                        if !store.snapshot.canSign { Text("Use the device holding your profile key to offer escrow services.").font(.caption).foregroundStyle(MarketTheme.muted) }
                    }
                }
                if historySection && !sectionOrders.isEmpty {
                    HStack {
                        Picker("Period", selection: $period) { ForEach(MarketOrderPeriod.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.menu).accessibilityIdentifier("ordersPeriod")
                        Spacer()
                        let export = OrderHistoryExport(orders: orders, owner: owner, people: store.snapshot.people)
                        ShareLink(item: export, preview: SharePreview("\(section.rawValue) — Iris Market")) {
                            Label("Export CSV", systemImage: "square.and.arrow.up")
                        }.font(.system(size: 14, weight: .medium)).disabled(orders.isEmpty)
                    }
                    Text(MarketOrderHistory.summary(orders)).font(.caption).foregroundStyle(MarketTheme.muted)
                }
                if section == .purchases, let basket = store.snapshot.basket, !basket.isEmpty {
                    BasketSection(groups: basket) { basketSeller = $0.seller }
                }
                if section == .escrow && jobsAvailable {
                    EmptyView() // Escrow jobs are listed above.
                } else if orders.isEmpty && !sectionOrders.isEmpty {
                    MarketEmptyState(symbol: "calendar", title: "No orders in this period", description: "Choose another period to see earlier orders.")
                } else if orders.isEmpty {
                    MarketEmptyState(symbol: "shippingbox.fill", title: section == .archived ? "Nothing archived" : "No \(section.rawValue.lowercased()) yet", description: section == .purchases ? "Your orders appear here." : section == .sales ? "Order requests for your listings appear here." : section == .deliveries ? "Deliveries you handle appear here." : "Finished orders can be kept here.")
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(orders) { order in
                            Button { store.activeOrderID = order.id } label: { OrderRow(order: order) }.buttonStyle(.plain)
                        }
                    }
                }
            }.padding(23)
        }.foregroundStyle(MarketTheme.ink)
            .onChange(of: jobsAvailable) { available in if !available && section == .escrow { section = .purchases } }
            .onAppear {
                // Open on the list holding the latest activity, so a new sale is not hidden behind an empty Purchases list.
                let owner = store.snapshot.publicKey
                // A waiting basket keeps Purchases open.
                guard (store.snapshot.basket ?? []).isEmpty else { return }
                guard section == .purchases, let latest = store.snapshot.orders.filter({ !$0.archived }).max(by: { $0.updatedAt < $1.updatedAt }) else { return }
                if let list = [MarketOrderList.purchases, .sales, .deliveries].first(where: { $0.contains(latest, owner: owner) }) { section = list }
            }
            .marketPage(isPresented: $offerService) { NewListingView(providerService: true).marketListingEditorSheetScope() }
            .marketPage(item: selection) { value in OrderDetailView(orderID: value.id).marketSheetScope() }
            .marketPage(isPresented: Binding(get: { basketSeller != nil }, set: { if !$0 { basketSeller = nil } }), onDismiss: {
                // Open the new order once the review sheet has closed.
                if let id = requestedOrder, !id.isEmpty { store.activeOrderID = id }
                requestedOrder = nil
            }) {
                if let seller = basketSeller { BasketCheckoutView(seller: seller) { requestedOrder = $0 }.marketSheetScope() }
            }
    }
}

/// The basket on Purchases: one card per seller, each requested as one order.
private struct BasketSection: View {
    @EnvironmentObject private var store: MarketStore
    let groups: [MarketBasketGroup]
    let onCheckout: (MarketBasketGroup) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Basket").font(.system(size: 20, weight: .semibold))
            ForEach(groups) { group in
                VStack(alignment: .leading, spacing: 14) {
                    UserRow(person: store.snapshot.people[group.seller] ?? .unnamed(group.seller), subtitle: "Seller")
                    ForEach(group.items) { line in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(line.listing.title).font(.system(size: 16, weight: .medium)).lineLimit(2)
                                Spacer(minLength: 8)
                                Text(line.formattedTotal).font(.system(size: 15))
                            }
                            HStack(spacing: 12) {
                                Button { store.setBasketQuantity(line.listing.id, line.quantity - 1) } label: { Image(systemName: line.quantity == 1 ? "trash.fill" : "minus").frame(width: 22, height: 22) }
                                    .buttonStyle(.bordered).accessibilityLabel(line.quantity == 1 ? "Remove \(line.listing.title)" : "One fewer \(line.listing.title)")
                                Text("\(line.quantity)").font(.system(size: 16, weight: .medium)).monospacedDigit().frame(minWidth: 24).accessibilityLabel("Quantity \(line.quantity)")
                                Button { store.setBasketQuantity(line.listing.id, line.quantity + 1) } label: { Image(systemName: "plus").frame(width: 22, height: 22) }
                                    .buttonStyle(.bordered).accessibilityLabel("One more \(line.listing.title)")
                            }
                        }
                    }
                    if group.items.count > 1, let total = group.total {
                        Divider()
                        HStack { Text("Total").fontWeight(.semibold); Spacer(); Text(total.formatted).fontWeight(.semibold) }.font(.system(size: 16))
                    }
                    Button("Review order") { onCheckout(group) }
                        .buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.canSign).accessibilityIdentifier("basketRequestOrder")
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
            }
        }
    }
}

/// Reviews one seller's basket before it becomes an order request.
struct BasketCheckoutView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let seller: String
    let onRequested: (String) -> Void
    @State private var note = ""
    @State private var fulfillment: MarketFulfillment? = .merchantDelivery
    @State private var escrowReview: BasketEscrowReview?
    @State private var createdOrderID: String?
    private struct BasketEscrowReview: Identifiable { let id: String; let checkout: EscrowCheckout }
    private var group: MarketBasketGroup? { store.snapshot.basket?.first { $0.seller == seller } }
    var body: some View {
        MarketNavigationContainer {
            ScrollView {
                VStack(alignment: .leading, spacing: 23) {
                    if let group {
                        let goods = group.items.allSatisfy { $0.listing.hasGoodsFulfillment }
                        Text("\(group.count) items").font(.system(size: 30, weight: .medium))
                        if let total = group.total { Text(total.formatted).font(.system(size: 26, weight: .semibold)) }
                        UserRow(person: store.snapshot.people[seller] ?? .unnamed(seller), subtitle: "Seller")
                        if goods { FulfillmentPicker(selection: $fulfillment) }
                        TextField("Note · optional", text: $note, axis: .vertical).lineLimit(3...6).padding(16).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                            .onChange(of: note) { value in if value.count > 2000 { note = String(value.prefix(2000)) } }
                        VStack(spacing: 10) {
                            ForEach(group.items) { line in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) { Text("\(line.quantity) × \(line.listing.title)"); Spacer(minLength: 8); Text(line.formattedTotal) }.font(.system(size: 15))
                                    if !store.demo && line.offersEscrowCheckout {
                                        Button {
                                            let checkout = EscrowCheckout(quantity: line.quantity, note: note.trimmingCharacters(in: .whitespacesAndNewlines),
                                                fulfillment: goods ? fulfillment : nil, consumeBasket: true)
                                            store.startEscrowCheckout { escrowReview = BasketEscrowReview(id: line.id, checkout: checkout) }
                                        } label: {
                                            Label(store.snapshot.settings.escrowUi ? "Order this item with escrow" : "Enable escrow for this item", systemImage: "lock.shield.fill")
                                        }.disabled(store.busy || !store.snapshot.canSign).accessibilityIdentifier("basketEscrow.\(line.id)")
                                    }
                                }
                            }
                            if !store.demo && group.items.count > 1 && group.items.contains(where: { $0.offersEscrowCheckout }) {
                                Text("Escrow covers one listing at a time. Your other items stay in the basket.").font(.caption).foregroundStyle(MarketTheme.muted)
                            }
                        }
                        Text("The seller will confirm your order. No payment is taken here.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
                        MarketInlineError()
                        Button("Request order") {
                            store.requestBasketOrder(seller: seller, note: note.trimmingCharacters(in: .whitespacesAndNewlines), fulfillment: goods ? fulfillment : nil) { id in
                                guard let id else { return }
                                onRequested(id); dismiss()
                            }
                        }.buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.canSign).accessibilityIdentifier("requestBasketOrder")
                    } else {
                        MarketEmptyState(symbol: "basket.fill", title: "Basket is empty", description: "Add listings from this seller to order them together.")
                    }
                }.padding(24)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Review order").marketInlineTitle()
                .marketPage(isPresented: Binding(get: { escrowReview != nil }, set: { if !$0 { escrowReview = nil } }), onDismiss: {
                    if let createdOrderID { onRequested(createdOrderID); dismiss() }
                }) {
                    if let review = escrowReview {
                        MarketplaceEscrowView(listingID: review.id, checkout: review.checkout, onOrderCreated: { createdOrderID = $0 }).marketSheetScope()
                    }
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct OrderRow: View {
    let order: MarketOrder
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 15) {
                if let image = order.displayImage, let url = URL(string: image) {
                    AsyncImage(url: url) { phase in
                        if let picture = phase.image { picture.resizable().scaledToFill() } else { MarketTheme.paper }
                    }.frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 12)).accessibilityHidden(true)
                }
                Text(order.title.isEmpty ? "Order" : order.title).font(.system(size: 17, weight: .semibold)).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                if !order.items.isEmpty { Text(order.formattedPrice).font(.system(size: 16, weight: .medium)) }
            }
            HStack {
                Text(Date(timeIntervalSince1970: Double(order.createdAt)), format: .dateTime.day().month()).foregroundStyle(MarketTheme.muted)
                Spacer()
                Text(order.statusLabel)
            }.font(.system(size: 12))
            if order.sync == "queued" { Text("Waiting to send").font(.system(size: 11)).foregroundStyle(MarketTheme.muted) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
    }
}

private struct FulfillmentPicker: View {
    @Binding var selection: MarketFulfillment?
    var body: some View {
        Picker("Delivery or pickup", selection: $selection) {
            ForEach(MarketFulfillment.allCases, id: \.self) { option in Text(option.label).tag(Optional(option)) }
            Text("Agree in chat").tag(nil as MarketFulfillment?)
        }.accessibilityIdentifier("orderFulfillment")
        if selection == .merchantDelivery { Text("Agree on the delivery address and cost privately with the seller.").font(.caption).foregroundStyle(MarketTheme.muted) }
    }
}

struct OrderReviewView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let listing: MarketListing
    let onRequested: () -> Void
    @State private var quantity = 1
    @State private var note = ""
    @State private var pickup = MarketDeliveryPlace(label: "Pickup")
    @State private var destination = MarketDeliveryPlace(label: "Destination")
    @State private var requestError: String?
    @State private var useEscrow = false
    @State private var showingEscrow = false
    @State private var checkout: EscrowCheckout?
    @State private var createdOrderID: String?
    @State private var fulfillment: MarketFulfillment? = .merchantDelivery
    init(listing: MarketListing, preferEscrow: Bool = false, onRequested: @escaping () -> Void) {
        self.listing = listing
        self.onRequested = onRequested
        _useEscrow = State(initialValue: preferEscrow)
    }
    private var canUseEscrow: Bool { !store.demo && listing.offersOrderEscrow }
    private var submitLabel: String {
        if useEscrow { return store.snapshot.settings.escrowUi ? "Choose escrow provider" : "Enable escrow and choose provider" }
        return NativeTransportType.classify(listing.tags ?? [])?.requestLabel ?? "Request order"
    }
    var body: some View {
        MarketNavigationContainer {
            ScrollView {
                VStack(alignment: .leading, spacing: 23) {
                    Text(listing.title).font(.system(size: 30, weight: .medium))
                    Text(listing.formattedPrice).font(.system(size: 26, weight: .semibold))
                    UserRow(person: store.snapshot.people[listing.author] ?? .unnamed(listing.author))
                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...999).accessibilityIdentifier("orderQuantity")
                    TextField("Note · optional", text: $note, axis: .vertical).lineLimit(3...6).padding(16).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16)).accessibilityIdentifier("orderNote")
                        .onChange(of: note) { value in if value.count > 2000 { note = String(value.prefix(2000)) } }
                    if listing.isTransportService { PrivateDeliveryPlaceField(place: $pickup); PrivateDeliveryPlaceField(place: $destination) }
                    if listing.hasGoodsFulfillment { FulfillmentPicker(selection: $fulfillment) }
                    if let requestError { Text(requestError).foregroundStyle(.red).font(.caption) }
                    if canUseEscrow { Toggle("Use escrow", isOn: $useEscrow) }
                    Text(canUseEscrow && useEscrow ? "Choose a provider next. The seller and provider each review your request before anyone pays." : "The seller will confirm your order. No payment is taken here.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
                    MarketInlineError()
                    Button {
                        do {
                            let delivery = listing.isTransportService ? MarketDeliveryRequest(pickup: pickup, destination: destination) : nil
                            let choice = listing.hasGoodsFulfillment ? fulfillment : nil
                            if let delivery { _ = try delivery.projection() }
                            requestError = nil
                            let orderNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            if useEscrow {
                                guard canUseEscrow else { throw MarketRouteError.message("Escrow is unavailable for this listing.") }
                                let review = EscrowCheckout(quantity: quantity, note: orderNote, delivery: delivery, fulfillment: choice)
                                store.startEscrowCheckout { checkout = review; showingEscrow = true }
                            } else {
                                store.requestOrder(listing, quantity: quantity, note: orderNote, fulfillment: choice, deliveryRequest: delivery) { success in if success { dismiss(); onRequested() } }
                            }
                        } catch { requestError = error.localizedDescription }
                    } label: { Text(submitLabel) }
                        .buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.canSign).accessibilityIdentifier("requestOrder")
                }.padding(24)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Review order").marketInlineTitle()
                .marketPage(isPresented: $showingEscrow, onDismiss: {
                    if let createdOrderID { store.activeOrderID = createdOrderID; dismiss(); onRequested() }
                }) {
                    MarketplaceEscrowView(listingID: listing.id, checkout: checkout, onOrderCreated: { createdOrderID = $0 }).marketSheetScope()
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct OrderDetailView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let orderID: String
    @State private var editingRoute = false
    @State private var cancelling = false
    @State private var arrangingDelivery = false
    @State private var escrowOpen = false
    @State private var paying = false
    @State private var requestingPayment = false
    @State private var confirmingPayment = false
    @State private var showingChat = false
    @State private var relatedOrder: OrderSelection?
    @State private var profile: OrderSelection?
    private var order: MarketOrder? { store.snapshot.orders.first { $0.id == orderID } }
    var body: some View {
        MarketNavigationContainer {
            ScrollView {
                if let order { detail(order) }
                else { MarketEmptyState(symbol: "shippingbox.fill", title: "Order unavailable", description: "This order is not available for this profile.") }
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Order").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { MarketDoneButton { dismiss() } } }
                .marketPage(isPresented: $arrangingDelivery) { if let order { OrderArrangeDeliveryView(order: order).marketSheetScope() } }
                .marketPage(isPresented: $showingChat) { if let order { let peer = order.seller == store.snapshot.publicKey ? order.buyer : order.seller; ConversationView(conversation: store.snapshot.conversations.first(where: { $0.id == peer }) ?? MarketConversation(id: peer, name: "Conversation", messages: []), context: .order(order.id), threadKey: "order:" + order.id).marketSheetScope() } }
                .marketPage(isPresented: $requestingPayment) { if let order { OrderPaymentRequestView(order: order).marketSheetScope() } }
                .confirmationDialog("Confirm payment received?", isPresented: $confirmingPayment, titleVisibility: .visible) { Button("Confirm received") { if let order, let payment = order.payment { store.updateOrder(order.id, patch: ["payment": ["mint": payment.mint, "amount": payment.amount, "unit": payment.unit, "status": "received"]]) } }; Button("Cancel", role: .cancel) {} } message: { Text("Confirm after checking your wallet. This records your confirmation for the buyer.") }
                .marketPage(isPresented: $escrowOpen) {
                    if let order, let item = order.items.first, let trade = order.escrowTradeId {
                        let hasInvite = store.snapshot.escrowCards.contains { $0.matches(order) }
                        MarketplaceEscrowView(listingID: item.id, tradeID: trade,
                            checkout: !hasInvite && order.buyer == store.snapshot.publicKey ? EscrowCheckout(quantity: item.quantity, note: order.note, delivery: order.deliveryRequest, resumeOrder: order) : nil
                        ).marketSheetScope()
                    }
                }
                .marketPage(isPresented: $paying) { NativeOrderPaymentView(orderID: orderID).marketSheetScope() }
                .marketPage(item: $relatedOrder) { value in OrderDetailView(orderID: value.id).marketSheetScope() }
                .marketPage(isPresented: $editingRoute) { if let order { OrderRouteEditor(order: order).marketSheetScope() } }
                .marketPage(item: $profile) { value in AuthorProfileView(author: value.id).marketSheetScope() }
                .confirmationDialog("Cancel this order?", isPresented: $cancelling, titleVisibility: .visible) {
                    Button("Cancel order", role: .destructive) { store.updateOrder(orderID, patch: ["status": "cancelled"]) }
                    Button("Keep order", role: .cancel) { }
                }
                .onChange(of: store.snapshot.publicKey) { _ in dismiss() }
        }
    }
    @ViewBuilder private func detail(_ order: MarketOrder) -> some View {
        let seller = order.seller == store.snapshot.publicKey
        let participant = seller || order.buyer == store.snapshot.publicKey
        let other = seller ? order.buyer : order.seller
        VStack(alignment: .leading, spacing: 21) {
            Text(order.title.isEmpty ? "Order" : order.title).font(.system(size: 30, weight: .medium))
            HStack { Text(order.statusLabel).fontWeight(.semibold); Spacer(); Text(Date(timeIntervalSince1970: Double(order.createdAt)), format: .dateTime.day().month()).foregroundStyle(MarketTheme.muted) }.font(.system(size: 13))
            // A single item shows the converted order price; a basket lists each item and then its total.
            if order.items.count == 1, let item = order.items.first {
                VStack(alignment: .leading, spacing: 5) { Text("\(item.quantity) × \(order.formattedPrice)").font(.system(size: 22, weight: .semibold)); if order.displayPrice != nil { Text(item.formattedPrice).font(.caption).foregroundStyle(MarketTheme.muted) } }
            } else {
                ForEach(order.items) { item in
                    HStack { Text("\(item.quantity) × \(item.title)").font(.system(size: 16, weight: .medium)); Spacer(); Text(item.lineFormattedPrice).font(.system(size: 15)) }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text("Total").font(.system(size: 16, weight: .semibold)); Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(order.itemsTotal ?? order.formattedPrice).font(.system(size: 20, weight: .semibold))
                        if let total = order.itemsTotal, order.displayPrice != nil, total != order.formattedPrice { Text("≈ \(order.formattedPrice)").font(.caption).foregroundStyle(MarketTheme.muted) }
                    }
                }
            }
            Button { profile = OrderSelection(id: other) } label: { UserRow(person: store.snapshot.people[other] ?? .unnamed(other), subtitle: seller ? "Buyer" : "Seller") }.buttonStyle(.plain)
            if !order.note.isEmpty { Text(order.note).font(.system(size: 15)).lineSpacing(4) }
            if order.sync == "queued" { Text("Waiting to send").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
            MarketInlineError()
            if let request = order.deliveryRequest { VStack(alignment: .leading, spacing: 8) { Text("Requested route").font(.headline); Text("Pickup · " + request.pickup.address); Text("Destination · " + request.destination.address); if let collection = request.collection { Text("Pickup reference · " + collection.reference).font(.caption).foregroundStyle(MarketTheme.muted) } } }
            if let authorization = order.pickupAuthorization { VStack(alignment: .leading, spacing: 8) { Text("Authorized collection").font(.headline); UserRow(person: store.snapshot.people[authorization.courierPubkey] ?? .unnamed(authorization.courierPubkey), subtitle: "Courier"); Text("Pickup reference · " + authorization.reference).font(.caption).foregroundStyle(MarketTheme.muted) } }
            if order.escrowTradeId != nil {
                if participant, let provider = order.escrowProvider {
                    let card = store.snapshot.escrowCards.first { $0.matches(order) }
                    if store.snapshot.settings.escrowUi || card?.joined == true {
                        let name = store.snapshot.people[provider]?.name ?? MarketPerson.unnamed(provider).name
                        Text("Escrow provider · " + name).font(.subheadline)
                        if let card {
                            Button("Open escrow · " + card.status) { escrowOpen = true }
                        } else if !seller && !order.terminal {
                            Button("Finish escrow invitation") { escrowOpen = true }
                        } else {
                            Text(order.terminal ? "No escrow invitation received." : "Waiting for the buyer’s escrow invitation.").font(.caption).foregroundStyle(MarketTheme.muted)
                        }
                    } else if seller && order.status == "requested" {
                        Text("Enable escrow in Settings to review this order’s provider.").font(.caption).foregroundStyle(MarketTheme.muted)
                    }
                }
            } else {
                if let payment = order.payment { orderPayment(payment, order: order) }
                if seller && !order.terminal && order.payment == nil { Button("Request payment") { requestingPayment = true } }
                if seller && order.payment?.status == "requested" { Button("Confirm payment received") { confirmingPayment = true } }
            }
            if participant { Button("Message") { store.command(["type": "contact", "author": other]) { if $0 { showingChat = true } } } }
            if let delivery = order.deliveryOrderId { Button("Open delivery order") { relatedOrder = OrderSelection(id: delivery) } }
            if let source = order.sourceOrderId { Button("Open product order") { relatedOrder = OrderSelection(id: source) } }
            if !order.terminal {
                if seller && order.status == "requested" && order.escrowTradeId == nil { statusButton("Accept order", status: "accepted") }
                if seller && order.status == "accepted" { statusButton("Mark on the way", status: "in-transit") }
                if participant && ["accepted", "in-transit"].contains(order.status) { statusButton("Mark delivered", status: "delivered", primary: false) }
            }
            Divider().overlay(MarketTheme.line)
            Text("Delivery").font(.system(size: 21, weight: .semibold))
            if participant, let value = order.fulfillment, let choice = MarketFulfillment(rawValue: value) {
                Label(choice.label, systemImage: choice == .pickup ? "shippingbox.fill" : "truck.box.fill").font(.subheadline)
            }
            if order.canBookMerchantCourier(store.snapshot.publicKey) {
                Button("Book a courier") { arrangingDelivery = true }.buttonStyle(PrimaryButton()).disabled(store.busy).accessibilityIdentifier("merchantBookCourier")
            } else if order.canBookBuyerCourier(store.snapshot.publicKey) {
                Button("Book your own courier") { arrangingDelivery = true }.buttonStyle(.bordered).disabled(store.busy).accessibilityIdentifier("buyerBookCourier")
            }
            if seller && !order.terminal && order.status != "requested" {
                let pickup = order.fulfillment == MarketFulfillment.pickup.rawValue || order.fulfillment == MarketFulfillment.buyerCourier.rawValue
                Button(order.shipment.stops.isEmpty ? (pickup ? "Share pickup details" : "Add delivery details or tracking") : "Edit route") { editingRoute = true }
                    .accessibilityIdentifier("editOrderDelivery")
            }
            TimelineView(.periodic(from: .now, by: 15)) { context in
                if let estimate = marketArrivalEstimate(eta: order.shipment.eta, status: order.status, now: Int64(context.date.timeIntervalSince1970)), let eta = order.shipment.eta {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Estimated arrival").font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
                        Text(estimate).font(.system(size: 28, weight: .semibold))
                        Text(Date(timeIntervalSince1970: Double(eta)).formatted(date: .abbreviated, time: .shortened)).font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
                    }
                }
            }
            if order.shipment.hasMap {
                ShipmentMapView(shipment: order.shipment).frame(height: 250).clipShape(RoundedRectangle(cornerRadius: 20))
                Text("Stops joined directly; not driving directions.").font(.system(size: 11)).foregroundStyle(MarketTheme.muted)
            }
            if order.shipment.stops.isEmpty { Text(seller ? "Add delivery details after accepting the order." : "Delivery details will appear here.").font(.system(size: 14)).foregroundStyle(MarketTheme.muted) }
            ForEach(Array(order.shipment.stops.enumerated()), id: \.element.id) { index, stop in
                stopView(stop, number: index + 1, order: order, seller: seller)
            }
            if let tracking = order.shipment.trackingLink { Link(destination: tracking) { Label("Track delivery", systemImage: "arrow.up.right.square") }.font(.system(size: 14, weight: .medium)) }
            if !order.terminal && order.status != "requested" && order.handlesDelivery(store.snapshot.publicKey) && store.snapshot.liveLocationSupported { OrderLocationSharing(order: order, active: !editingRoute && !arrangingDelivery && !paying && !requestingPayment && !confirmingPayment && !showingChat && profile == nil && relatedOrder == nil) }
            if !order.terminal && participant { Button("Cancel order", role: .destructive) { cancelling = true }.disabled(store.busy).font(.system(size: 13)) }
            if order.terminal { Button(order.archived ? "Restore order" : "Archive order") { store.archiveOrder(order) { if $0 { dismiss() } } }.buttonStyle(PrimaryButton(dark: false)).disabled(store.busy) }
        }.padding(24)
    }
    private func orderPayment(_ payment: MarketOrderPayment, order: MarketOrder) -> some View {
        let amount = UInt64(payment.amount) ?? 0, rate = store.snapshot.satsDisplayPrice
        let display = NativeMoney.display(sats: amount, currency: store.snapshot.settings.currency, testOnly: NativeWalletUnits.isTest(payment.mint), rate: rate?.amount, rateCurrency: rate?.currency, stale: rate?.stale ?? false)
        return VStack(alignment: .leading, spacing: 9) {
            Text(payment.status == "received" ? "Payment received" : "Payment requested").font(.headline)
            Text(display).font(.title2.weight(.semibold)); Text(NativeWalletUnits.amount(amount, mint: payment.mint) + " · " + NativeWalletUnits.mintName(payment.mint)).font(.caption).foregroundStyle(MarketTheme.muted)
            if payment.status == "received" { Text("Confirmed by seller").font(.caption).foregroundStyle(MarketTheme.muted) }
            else if order.buyer == store.snapshot.publicKey && !order.terminal { Button("Pay order") { paying = true }.buttonStyle(PrimaryButton()).disabled(store.busy) }
            if NativeWalletUnits.isTest(payment.mint) { Text("Test money · no bitcoin value").font(.caption).foregroundStyle(MarketTheme.muted) }
        }
    }
    private func statusButton(_ label: String, status: String, primary: Bool = true) -> some View {
        Button { store.updateOrder(orderID, patch: ["status": status]) } label: { Text(label) }.buttonStyle(PrimaryButton(dark: primary)).disabled(store.busy || store.demo)
    }
    @ViewBuilder private func stopView(_ stop: MarketShipmentStop, number: Int, order: MarketOrder, seller: Bool) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(alignment: .top, spacing: 12) {
                Group { if stop.status == "completed" { Image(systemName: "checkmark.circle.fill") } else { Text("\(number)").fontWeight(.semibold) } }.frame(width: 28, height: 28).background(MarketTheme.mint, in: Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text(stop.label.isEmpty ? "Stop \(number)" : stop.label).font(.system(size: 16, weight: .semibold))
                    if !stop.address.isEmpty { Text(stop.address).font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    if !order.terminal { Text(stop.statusLabel).font(.system(size: 11)).foregroundStyle(MarketTheme.muted) }
                }
                Spacer(minLength: 0)
            }
            if let courier = stop.courierPubkey {
                Button { profile = OrderSelection(id: courier) } label: { UserRow(person: store.snapshot.people[courier] ?? .unnamed(courier), subtitle: "Courier", size: 30) }.buttonStyle(.plain)
            }
            if !order.terminal && order.status != "requested" && (seller || stop.courierPubkey == store.snapshot.publicKey) {
                if stop.status != "completed", let url = navigationURL(stop) { Link(destination: url) { Label("Navigate to stop", systemImage: "arrow.triangle.turn.up.right.diamond.fill") }.font(.system(size: 13, weight: .semibold)) }
                HStack(spacing: 18) {
                    if stop.status == "pending" { Button("Mark arrived") { store.updateOrder(orderID, patch: ["stopId": stop.id, "status": "arrived"]) } }
                    if stop.status != "completed" { Button("Complete stop") { store.updateOrder(orderID, patch: ["stopId": stop.id, "status": "completed"]) } }
                }.font(.system(size: 13, weight: .semibold)).disabled(store.busy || store.demo)
            }
        }.padding(17).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 19))
    }
}

private func navigationURL(_ stop: MarketShipmentStop) -> URL? {
    let destination: String
    if let point = stop.coordinates, MarketShipment.validCoordinates(point) { destination = "\(point[1]),\(point[0])" }
    else { destination = stop.address.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard !destination.isEmpty else { return nil }
    var url = URLComponents(string: "https://maps.apple.com/")!
    url.queryItems = [URLQueryItem(name: "daddr", value: destination), URLQueryItem(name: "dirflg", value: "d")]
    return url.url
}
