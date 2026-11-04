import SwiftUI

struct ListingDetailView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let listing: MarketListing
    var onContact: (() -> Void)? = nil
    var onOrder: (() -> Void)? = nil
    #if os(macOS)
    var desktopSearch: DesktopMarketSearchBar? = nil
    var onDesktopBack: (() -> Void)? = nil
    #endif
    @State private var expiryClockStart = Date()
    @State private var invitation = false
    @State private var showEscrow = false
    @State private var authorProfile = false
    @State private var reviewOrder = false
    @State private var orderRequested = false
    private var latest: MarketListing? {
        store.snapshot.listings.first { $0.id == listing.id }
            ?? store.snapshot.savedListings?.first { $0.id == listing.id }
            ?? store.snapshot.profileListings?.listings.first { $0.id == listing.id }
            ?? store.snapshot.profileListings?.collections?.lazy.flatMap(\.members).compactMap(\.listing).first { $0.id == listing.id }
    }
    private var current: MarketListing { latest ?? listing }
    private var quoteAvailable: Bool { listing.externalOrder == nil || latest != nil }
    private func closeListing() {
        #if os(macOS)
        if let onDesktopBack { onDesktopBack(); return }
        #endif
        dismiss()
    }
    var body: some View {
        MarketNavigationContainer {
            ScrollView {
                VStack(alignment: .leading, spacing: 23) {
                    #if os(macOS)
                    HStack(spacing: 12) { MarketPageBackButton(action: onDesktopBack); desktopSearch }
                    #endif
                    if current.externalOrder == nil { Group {
                        if let raw = current.imageUrl, let url = URL(string: raw) { AsyncImage(url: url) { phase in if let image = phase.image { image.resizable().scaledToFill() } else { ListingPlaceholder(category: current.category) } } }
                        else { ListingPlaceholder(category: current.category) }
                    }.frame(height: 285).clipped().clipShape(RoundedRectangle(cornerRadius: 28)) }
                    HStack { Text(current.isBitcoinOffer ? (current.side == "request" ? "BUYING BITCOIN" : "SELLING BITCOIN") : (current.side == "request" ? "BUYING" : current.category.uppercased())).font(.system(size: 10, weight: .bold)).tracking(1.5).foregroundStyle(MarketTheme.green); Spacer(); Text(current.delivery == "queued" ? "Waiting to send" : current.delivery == "failed" ? "Not sent" : "").font(.caption).foregroundStyle(MarketTheme.muted) }
                    Text(current.title).font(.system(size: 32, weight: .medium)).tracking(-0.7).foregroundStyle(MarketTheme.ink)
                    HStack { Text(current.formattedPrice).font(.system(size: 28, weight: .semibold)); Spacer(); Label(current.location.isEmpty ? "Anywhere" : current.location, systemImage: "mappin.circle.fill").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }.foregroundStyle(MarketTheme.ink)
                    if let terms = current.escrow?.bitcoinTerms { Text(terms).font(.subheadline).foregroundStyle(MarketTheme.muted) }
                    TimelineView(.periodic(from: expiryClockStart, by: 60)) { context in
                        Text(NativeListingExpiry.detail(deadline: current.expiresAt, now: Int64(context.date.timeIntervalSince1970))).font(.system(size: 13)).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("listingExpiryDetail")
                    }
                    if let quote = current.externalOrder { Text(quote.platform).font(.subheadline).foregroundStyle(MarketTheme.muted) }
                    else { Button { authorProfile = true } label: {
                        UserRow(person: store.snapshot.people[current.author] ?? .unnamed(current.author))
                    }.accessibilityIdentifier("listingAuthor") }
                    Rectangle().fill(MarketTheme.line).frame(height: 1)
                    if current.externalOrder != nil { Text(verbatim: current.description).textSelection(.enabled) }
                    else { Text((try? AttributedString(markdown: current.description, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(current.description)).font(.system(size: 16)).lineSpacing(6).foregroundStyle(MarketTheme.ink.opacity(0.90))
                    ReviewsView(target: current.reviewAddress, product: true) }
                    if let relevance = current.relevance { Label(relevance.reason, systemImage: "sparkles").font(.system(size: 13)).foregroundStyle(MarketTheme.green).padding(15).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.mint.opacity(0.4), in: RoundedRectangle(cornerRadius: 16)) }
                    MarketInlineError()
                    if store.snapshot.settings.escrowUi && current.escrow != nil && (current.isBitcoinOffer || current.side == "request") && !current.mine && !store.demo {
                        Button { showEscrow = true } label: { Label("Arrange escrow", systemImage:"lock.shield.fill") }
                            .disabled(!store.snapshot.messagingReady)
                    }
                    if let quote = current.externalOrder {
                        Button("Copy link") { MarketPlatform.copyToClipboard(quote.link) }
                    } else if current.mine {
                        Button { store.command(["type": "close", "id": current.id]) { if $0 { closeListing() } } } label: { Text("Mark as unavailable") }.buttonStyle(PrimaryButton())
                    } else if current.side == "offer" && !current.isBitcoinOffer {
                        Button { reviewOrder = true } label: { Label(NativeTransportType.classify(current.tags ?? [])?.requestLabel ?? "Buy", systemImage: NativeTransportType.classify(current.tags ?? []) == nil ? "bag.fill" : "car.fill") }
                            .buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.messagingReady).accessibilityIdentifier("buyListing")
                        if store.demo { Text("Ordering is unavailable in preview mode.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
                    } else {
                        Button {
                            store.command(["type": "contact", "author": current.author, "listing_id": current.id]) { success in
                                if success { closeListing(); onContact?() }
                            }
                        } label: {
                            Label("Private enquiry", systemImage: "bubble.left.fill")
                        }.buttonStyle(PrimaryButton()).disabled(store.demo || store.busy || !store.snapshot.messagingReady).accessibilityIdentifier("privateEnquiry")
                        Text(store.demo ? "Private enquiries are unavailable in preview mode." : "Your conversation stays private.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                        Button("Connect with an invitation instead") { invitation = true }.font(.system(size: 12)).frame(maxWidth: .infinity)
                    }
                    if !store.demo && !current.mine && current.externalOrder == nil && current.side == "offer" {
                        MerchantNoticeButton(listingID: current.id)
                            .id([current.id, store.snapshot.publicKey])
                    }
                }.padding(23)
            }.background(MarketTheme.paper)
                #if os(macOS)
                .navigationBarBackButtonHidden(true)
                #endif
                .onChange(of: quoteAvailable) { available in if !available { closeListing() } }
                .task(id: current.expiresAt) {
                    guard current.externalOrder != nil, let deadline = current.expiresAt else { return }
                    let delay = Double(deadline) - Date().timeIntervalSince1970
                    if delay > 0 { try? await Task.sleep(for: .seconds(min(delay, 86400 * 365))) }
                    if !Task.isCancelled && Double(deadline) <= Date().timeIntervalSince1970 { closeListing() }
                }
                .marketPage(isPresented: $showEscrow) { MarketplaceEscrowView(listingID:current.id).marketSheetScope() }
                .marketPage(isPresented: $authorProfile) { AuthorProfileView(author: current.author).marketSheetScope() }.navigationTitle("Listing").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { MarketDoneButton { closeListing() } }; ToolbarItem(placement: .confirmationAction) { Button { store.save(current) } label: { Image(systemName: current.saved ? "heart.fill" : "heart") }.accessibilityLabel("Save listing") } }
                .marketPage(isPresented: $invitation) { InvitationView().marketSheetScope() }
                .marketPage(isPresented: $reviewOrder, onDismiss: { if orderRequested { closeListing(); onOrder?() } }) { OrderReviewView(listing: current) { orderRequested = true }.marketSheetScope() }
        }
    }
}

struct NewListingView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var side = "offer"
    @State private var title = ""
    @State private var description = ""
    @State private var price = ""
    @State private var currency = "EUR"
    @State private var location = ""
    @State private var category = "Other"
    @State private var imageURL = ""
    @State private var uploading = false
    @State private var expiry: NativeListingExpiry = .never
    @State private var transport: NativeTransportType? = nil
    @State private var serviceAreas: MarketServiceAreas?
    @State private var chooseServiceAreas = false
    @State private var reviewPublish = false
    @State private var offerEscrow = false
    @State private var bitcoinTrade = false
    @State private var bitcoinAmount = ""
    @State private var fiatMethod = "bank_transfer"
    private var escrowEnabled: Bool { offerEscrow && store.snapshot.settings.escrowUi }
    private var validBitcoin: Bool {
        !escrowEnabled || !bitcoinTrade || ((UInt64(bitcoinAmount) ?? 0) > 0 && currency != "BTC" && expiry != .never && (Decimal(string: price) ?? 0) > 0)
    }
    let providerService: Bool
    private var advertisingProvider: Bool { providerService && side == "offer" && store.snapshot.settings.escrowUi }
    init(providerService: Bool = false, transport: NativeTransportType? = nil, area: String = "", serviceAreas: MarketServiceAreas? = nil) {
        self.providerService = providerService
        _serviceAreas = State(initialValue: serviceAreas)
        _transport = State(initialValue: transport)
        _location = State(initialValue: area)
        _category = State(initialValue: providerService ? "Services" : transport == nil ? "Other" : "Transport")
        _title = State(initialValue: providerService ? "Escrow services" : transport?.serviceTitle ?? "")
    }
    @FocusState private var entryFocused: Bool
    private let categories = ["Electronics", "Home", "Clothing", "Books", "Transport", "Services", "Garden", "Music", "Other"]
    var body: some View {
        #if os(macOS)
        // Keep both steps in the same desktop navigation destination.
        if reviewPublish { publicationReview } else { editor }
        #else
        editor
        #endif
    }
    private var editor: some View {
        MarketNavigationContainer {
            Form {
                Section {
                    Picker("Listing type", selection: $side) { Text("Selling").tag("offer"); Text("Buying").tag("request") }.pickerStyle(.segmented).accessibilityIdentifier("listingSide")
                    TextField("Title", text: $title, prompt: Text("Title").foregroundColor(MarketTheme.muted)).labelsHidden().focused($entryFocused).accessibilityIdentifier("listingTitle")
                    TextField("Description", text: $description, prompt: Text("Description").foregroundColor(MarketTheme.muted), axis: .vertical).labelsHidden().lineLimit(4...8).accessibilityIdentifier("listingDescription")
                    Picker("Category", selection: $category) { ForEach(categories, id: \.self) { Text($0) } }
                    if category == "Transport" {
                        Picker("Service type", selection: $transport) {
                            Text("Other transport").tag(Optional<NativeTransportType>.none)
                            ForEach(NativeTransportType.allCases) { Text($0.label).tag(Optional($0)) }
                        }.accessibilityIdentifier("listingTransportType")
                    }
                }
                if store.snapshot.settings.escrowUi {
                    Section("Trade options") {
                        Toggle(side == "offer" ? "Allow buyers to propose escrow" : "Allow sellers to propose escrow", isOn: $offerEscrow)
                        if offerEscrow {
                            Text("The other trader can suggest a provider. You and the provider decide whether to accept each invitation.").font(.footnote).foregroundStyle(MarketTheme.muted)
                            Picker("Trade", selection: $bitcoinTrade) { Text("Goods or services").tag(false); Text("Bitcoin for fiat").tag(true) }
                            if bitcoinTrade {
                                TextField("Bitcoin amount in sats", text: $bitcoinAmount)
                                Picker("Fiat payment method", selection: $fiatMethod) { Text("Bank transfer").tag("bank_transfer"); Text("Cash in person").tag("cash") }
                                Text("Enter the total fiat price and an expiry below.").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }.onChange(of: bitcoinTrade) { value in if value && expiry == .never { expiry = .week } }
                }
                Section("Details") {
                    HStack { TextField("Price or budget", text: $price, prompt: Text("Price or budget").foregroundColor(MarketTheme.muted)).labelsHidden().marketDecimalKeyboard().accessibilityIdentifier("listingPrice"); Picker("Currency", selection: $currency) { Text("EUR").tag("EUR"); Text("USD").tag("USD"); Text("GBP").tag("GBP"); Text("BTC").tag("BTC") }.labelsHidden().frame(width: 90) }
                    Picker("Expires in", selection: $expiry) { ForEach(NativeListingExpiry.presets, id: \.self) { Text($0.label).tag($0) } }.accessibilityIdentifier("listingExpiry")
                    TextField(transport == nil ? "Town, area, or #geohash" : "Pickup area", text: $location, prompt: Text(transport == nil ? "Town, area, or #geohash" : "Pickup area").foregroundColor(MarketTheme.muted)).labelsHidden().accessibilityIdentifier("listingLocation")
                    PlaceSearchButton(value: MarketDeliveryPlace(label: location, address: location)) { place in location = place.label }
                    if transport != nil && category == "Transport" {
                        Button { chooseServiceAreas = true } label: { Label(serviceAreas == nil ? "Choose pickup and destination areas" : "Edit service areas", systemImage: "map.fill") }.disabled(store.demo).accessibilityIdentifier("transportServiceAreas")
                        Text("Search a place, drop a pin, and choose your range. Boundaries become public only when you publish.").font(.footnote).foregroundStyle(MarketTheme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    TextField("Photo link · optional", text: $imageURL, prompt: Text("Photo link · optional").foregroundColor(MarketTheme.muted)).labelsHidden().marketNoAutocapitalization().autocorrectionDisabled().marketURLKeyboard()
                    ListingUploadButton(uploading: $uploading) { upload in
                        if upload.isImage { imageURL = upload.url }
                        else { let name = upload.name.replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: ""); description += (description.isEmpty ? "" : "\n\n") + "[\(name)](\(upload.url))\n\(upload.fileLink)" }
                    }
                }
                Section {
                    if store.demo { Label("Preview mode: publishing is turned off.", systemImage: "eye").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    else if !store.snapshot.canSign { Text("Sign in with your profile’s secret key to publish listings.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted) }
                    else { Text("Your listing will be public, and people can contact you privately. Keep exact addresses and private contact details out of your listing.").font(.system(size: 13)).foregroundStyle(MarketTheme.muted).fixedSize(horizontal: false, vertical: true) }
                    MarketInlineError()
                    Button { reviewPublish = true } label: { HStack { Spacer(); Text("Review listing").fontWeight(.semibold); Spacer() }.padding(.vertical, 8) }
                        .disabled(!validBitcoin || store.demo || store.busy || uploading || !store.snapshot.canSign || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category == "Transport" && transport != nil && serviceAreas == nil).accessibilityIdentifier("publishListing")
                }
            }.formStyle(.grouped).scrollContentBackground(.hidden).background(MarketTheme.paper).marketKeyboardDismissal().navigationTitle("New listing").marketInlineTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { MarketDoneButton(label: "Cancel") { dismiss() } }
                    #if !os(macOS)
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { entryFocused = false }.accessibilityIdentifier("dismissKeyboard") }
                    #endif
                }
            .marketPage(isPresented: $chooseServiceAreas) { ServiceAreaEditor(areas: $serviceAreas).marketSheetScope() }
            #if !os(macOS)
            .marketPage(isPresented: $reviewPublish) { publicationReview.marketListingEditorSheetScope() }
            #endif
        }
    }
    private var publicationReview: some View {
        MarketNavigationContainer {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(title).font(.title2.weight(.semibold))
                    reviewDetail("Listing", (side == "offer" ? "Selling" : "Buying") + (escrowEnabled && bitcoinTrade ? " bitcoin" : ""))
                    reviewDetail("Description", description.isEmpty ? "No description" : description)
                    reviewDetail(escrowEnabled && bitcoinTrade ? "Total fiat price" : (side == "offer" ? "Price" : "Budget"), price.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Negotiable" : price + " " + currency)
                    if escrowEnabled {
                        reviewDetail("Payment protection", bitcoinTrade ? "Escrow · " + bitcoinAmount + " sats · " + (fiatMethod == "cash" ? "Cash in person" : "Bank transfer") : "Escrow offered")
                    }
                    if advertisingProvider { reviewDetail("Escrow directory", "People can find you and privately invite you to a job.") }
                    reviewDetail("Category", category)
                    if category == "Transport" { reviewDetail("Service type", transport?.label ?? "Other transport") }
                    reviewDetail("Location", location.isEmpty ? "Not specified" : location)
                    reviewDetail("Expires in", expiry.label)
                    if category == "Transport", transport != nil { reviewDetail("Service areas", serviceAreas == nil ? "Not selected" : "Pickup and destination areas selected") }
                    if !imageURL.isEmpty { Label("Photo included", systemImage: "photo") }
                    Text("Your listing will be public. Conversations stay private.").font(.callout).foregroundStyle(MarketTheme.muted)
                    MarketInlineError()
                    Button("Publish listing") { publish() }.buttonStyle(PrimaryButton())
                        .disabled(!validBitcoin || store.demo || store.busy || uploading || !store.snapshot.canSign)
                        .accessibilityIdentifier("confirmPublishListing")
                }.padding(24).frame(maxWidth: 600, alignment: .leading).frame(maxWidth: .infinity)
            }.background(MarketTheme.paper).navigationTitle("Review listing").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Keep editing") { reviewPublish = false } } }
        }
    }
    private func reviewDetail(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption).foregroundStyle(MarketTheme.muted)
            Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func publish() {
        var draft: [String: Any] = ["title": title, "description": description, "side": side, "price": price, "currency": currency, "location": location, "category": category, "tags": category == "Transport" ? (transport?.tags ?? []) : [], "image_url": imageURL.isEmpty ? NSNull() : imageURL as Any]
        if advertisingProvider { draft["tags"] = (draft["tags"] as? [String] ?? []) + ["escrow-provider"] }
        if category == "Transport", let serviceAreas, let data = try? JSONEncoder().encode(serviceAreas), let geometry = try? JSONSerialization.jsonObject(with: data) { draft["service_areas"] = geometry }
        if escrowEnabled {
            if bitcoinTrade, let sats = UInt64(bitcoinAmount) { draft["escrow"] = ["trade":"bitcoin_fiat", "sats":sats, "method":fiatMethod] as [String:Any] }
            else if !bitcoinTrade { draft["escrow"] = ["trade":"goods"] }
            else { return }
        }
        store.command(["type": "publish", "draft": draft], publishExpiry: expiry) { if $0 { dismiss() } }
    }
}

extension View {
    /// Apply editor dimensions at the sheet boundary, without the default narrow sheet frame.
    @ViewBuilder func marketListingEditorSheetScope() -> some View {
        #if os(macOS)
        frame(maxWidth: 800, maxHeight: .infinity).frame(maxWidth: .infinity)
        #else
        marketSheetScope()
        #endif
    }
}

private struct MerchantNoticeButton: View {
    @EnvironmentObject private var store: MarketStore
    let listingID: String
    @State private var status = ""
    @State private var requested = false
    @State private var problem = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if status == "available" || status == "no-inbox" {
                Button("Notify seller anonymously") { requested = true }
                    .disabled(requested || status == "no-inbox").accessibilityIdentifier("merchantNotice")
                Text(status == "no-inbox" ? "This seller hasn’t published an inbox for anonymous notices." : "Sends “Someone wants to buy from you on market.iris.to. Open Iris Market to set up private messaging.”")
            } else if status == "queued" {
                Text("Anonymous notice queued.")
            } else if status == "sent" {
                Text("Notice accepted by the seller’s inbox relay.")
            }
            if problem { Text("Could not save the notice. Try again.") }
        }
        .font(.footnote)
        .task(id: requested) {
            do {
                if requested { problem = false }
                status = try await store.merchantNotice(listingID: listingID, send: requested)
                while status == "queued" {
                    try await Task.sleep(for: .seconds(2))
                    status = try await store.merchantNotice(listingID: listingID, send: false)
                }
            } catch {
                if requested && !Task.isCancelled { requested = false; problem = true }
            }
        }
    }
}
