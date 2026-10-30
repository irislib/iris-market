import SwiftUI

struct MarketRootView: View {
    @EnvironmentObject private var store: MarketStore
    @AppStorage("market.appearance") private var appearance = MarketAppearance.system.rawValue
    @State private var tab = MarketTab.browse
    @State private var compose = false
    @State private var transport = false
    @State private var aiSettings = false
    @State private var selected: MarketListing?
    @State private var photoFilter: Bool?
    enum MarketTab: String, CaseIterable {
        case browse = "Explore", saved = "Saved", orders = "Orders", inbox = "Inbox", profile = "Profile", settings = "Settings"
        var symbol: String { switch self { case .browse: return "square.grid.2x2.fill"; case .saved: return "heart.fill"; case .orders: return "shippingbox.fill"; case .inbox: return "bubble.left.and.bubble.right.fill"; case .profile: return "person.crop.circle.fill"; case .settings: return "gearshape.fill" } }
    }
    private var hasProfile: Bool { store.ready && !store.demo && store.snapshot.profileNameRequired != true && !store.snapshot.publicKey.isEmpty }
    private var ownPerson: MarketPerson {
        store.snapshot.people[store.snapshot.publicKey] ?? MarketPerson(author: store.snapshot.publicKey, name: NativeProfileNames.name(seed: store.snapshot.publicKey), pictureUrl: nil, connection: MarketPerson.unnamed(store.snapshot.publicKey).connection)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                IrisMark().frame(width: 34, height: 34)
                Text("iris market").font(.system(size: 23, weight: .semibold)).tracking(-0.8).foregroundStyle(MarketTheme.ink)
                if store.demo { Text("PREVIEW").font(.system(size: 9, weight: .bold)).tracking(1).padding(.horizontal, 7).padding(.vertical, 5).background(MarketTheme.peach.opacity(0.65), in: Capsule()).accessibilityIdentifier("previewBadge") }
                Spacer(minLength: 2)
                Button { if store.snapshot.profileNameRequired == true && !store.demo { store.requestProfileSetup() } else { compose = true } } label: { Image(systemName: "plus").font(.system(size: 20, weight: .medium)).frame(width: 41, height: 41).background(MarketTheme.action, in: Circle()).foregroundStyle(MarketTheme.onAction) }
                    .accessibilityLabel("Create a listing").accessibilityIdentifier("createListing")
                Menu {
                    if hasProfile {
                        Button { tab = .profile } label: { Label("\(ownPerson.displayName) · View profile", systemImage: "person.crop.circle.fill") }
                    } else if !store.demo {
                        Button { store.requestProfileSetup() } label: { Label("Sign in", systemImage: "person.crop.circle.fill") }.disabled(!store.ready)
                    }
                    Divider()
                    Button { transport = true } label: { Label("Transport", systemImage: "car.fill") }.accessibilityIdentifier("openTransport")
                    Button { tab = .settings } label: { Label("Settings", systemImage: "gearshape.fill") }
                    Button { aiSettings = true } label: { Label("AI settings", systemImage: "sparkles") }
                    Divider()
                    Picker("Appearance", selection: $appearance) {
                        Label("Light", systemImage: "sun.max.fill").tag(MarketAppearance.light.rawValue)
                        Label("Dark", systemImage: "moon.fill").tag(MarketAppearance.dark.rawValue)
                        Label("System", systemImage: "circle.lefthalf.filled").tag(MarketAppearance.system.rawValue)
                    }
                } label: {
                    if hasProfile { UserAvatar(person: ownPerson, size: 34).frame(width: 41, height: 41) }
                    else { Image(systemName: "ellipsis").font(.system(size: 20, weight: .semibold)).frame(width: 41, height: 41).foregroundStyle(MarketTheme.muted) }
                }.menuIndicator(.hidden).accessibilityLabel("Menu").accessibilityIdentifier("mainMenu")
            }.padding(.horizontal, 23).padding(.top, 10).padding(.bottom, 16)
            Group {
                switch tab {
                case .browse: BrowseView(selected: $selected, photoFilter: $photoFilter)
                case .saved: SavedView(selected: $selected)
                case .orders: OrdersView()
                case .inbox: InboxView()
                case .profile: AuthorProfileView(author: store.snapshot.publicKey, onClose: { tab = .browse })
                case .settings: ProfileView()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(spacing: 0) {
                Rectangle().fill(MarketTheme.line.opacity(0.8)).frame(height: 1)
                HStack(spacing: 0) {
                    ForEach([MarketTab.browse, .saved, .orders, .inbox], id: \.self) { item in
                        Button {
                            if tab != item {
                                tab = item
                                if item == .saved { store.filter(query: "", side: "all") }
                                else if item == .browse { store.filter(query: "", side: "offer") }
                            }
                        } label: {
                            VStack(spacing: 5) {
                                Image(systemName: item.symbol).font(.system(size: 19, weight: .medium)).frame(height: 24)
                                Text(item.rawValue).font(.system(size: 10, weight: tab == item ? .semibold : .medium))
                            }.foregroundStyle(tab == item ? MarketTheme.ink : MarketTheme.muted.opacity(0.85))
                                .frame(maxWidth: .infinity).padding(.top, 13).padding(.bottom, 8)
                                .background(alignment: .top) { if tab == item { Capsule().fill(MarketTheme.green).frame(width: 24, height: 3) } }
                        }.accessibilityIdentifier("tab\(item.rawValue)")
                    }
                }
            }.background(MarketTheme.paper)
        }.background(MarketTheme.paper)
            .sheet(isPresented: Binding(get: { store.profileSetupRequested && store.activeSheetCount == 0 }, set: { if !$0 { store.dismissProfileSetup() } })) { ProfileNameEntryView().environmentObject(store) }
            .sheet(isPresented: $aiSettings) { AISettingsView(settings: store.snapshot.settings).marketSheetScope() }
            .sheet(isPresented: $transport) { CourierWorkspaceView().marketSheetScope() }
            .sheet(isPresented: $compose) { NewListingView().marketSheetScope() }
            .sheet(item: $selected) { listing in ListingDetailView(listing: listing, onContact: { tab = .inbox }, onOrder: { tab = .orders }).marketSheetScope() }
            .alert("Unable to complete action", isPresented: Binding(get: { store.alert != nil && store.activeSheetCount == 0 }, set: { if !$0 { store.alert = nil } })) { Button("OK", role: .cancel) { store.alert = nil } } message: { Text(store.alert ?? "") }
    }
}

struct BrowseView: View {
    @EnvironmentObject private var store: MarketStore
    @Binding var selected: MarketListing?
    @State private var query = ""
    @State private var side = "offer"
    @State private var showAllMatches = false
    @State private var showMap = false
    @State private var aiSettings = false
    @State private var filtersPresented = false
    @Binding var photoFilter: Bool?
    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]
    private var curationActive: Bool { store.snapshot.aiSearch && store.snapshot.settings.ai.enabled && !store.snapshot.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var searching: Bool { store.localAIProgress != nil || store.snapshot.searchDiscovery?.loading == true || curationActive && store.busy }
    private var matchCount: Int { store.snapshot.listings.filter { $0.relevance?.show == true }.count }
    private var wantsPhotos: Bool { NativePhotoFilter.wantsPhotos(choice: photoFilter, query: store.snapshot.query, side: store.snapshot.side, map: showMap) }
    private var visibleListings: [MarketListing] {
        store.snapshot.listings.filter { listing in
            (!curationActive || showAllMatches || listing.relevance?.show == true) && NativePhotoFilter.includes(imageURL: listing.imageUrl, choice: photoFilter, query: store.snapshot.query, side: store.snapshot.side, map: showMap)
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 17)).foregroundStyle(MarketTheme.muted)
                    TextField("Search listings", text: $query, prompt: Text("Search listings").foregroundColor(MarketTheme.muted)).font(.system(size: 14)).submitLabel(.search).accessibilityIdentifier("marketSearch")
                        .onSubmit { submitSearch() }
                    Group {
                        if store.busy || searching { ProgressView().controlSize(.small) }
                        else { Image(systemName: "sparkles").foregroundStyle(store.aiSearchEnabled ? MarketTheme.green : MarketTheme.muted) }
                    }.frame(width: 36, height: 40).contentShape(Rectangle())
                        .gesture(LongPressGesture(minimumDuration: 0.5).exclusively(before: TapGesture()).onEnded { value in
                            switch value {
                            case .first: aiSettings = true
                            case .second: showAllMatches = false; store.toggleAI { aiSettings = true }
                            }
                        })
                        .accessibilityElement(children: .ignore).accessibilityAddTraits(.isButton).accessibilityLabel("AI search")
                        .accessibilityValue(store.aiSearchStateLabel)
                        .accessibilityHint("Long press to open AI settings")
                        .accessibilityAction { store.toggleAI { aiSettings = true } }
                        .accessibilityAction(named: Text("Open AI settings")) { aiSettings = true }
                        .accessibilityIdentifier("aiSearchToggle")
                    if !query.isEmpty { Button { query = ""; store.filter(query: "", side: side) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(MarketTheme.muted) }.accessibilityLabel("Clear search") }
                }.padding(.horizontal, 16).frame(height: 51).background(MarketTheme.surface.opacity(0.82), in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(MarketTheme.line, lineWidth: 1))
                if store.snapshot.settings.ai.provider == "apple", let reason = store.appleAIUnavailableReason {
                    Text(reason).font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("appleAIAvailability")
                }
                HStack(spacing: 8) {
                    filterChip("Selling", value: "offer", symbol: "tag.fill")
                    filterChip("Buying", value: "request", symbol: "hand.wave.fill")
                    Spacer()
                    Button { filtersPresented = true } label: { Image(systemName: "line.3.horizontal.decrease.circle.fill").font(.system(size: 21)).foregroundStyle(MarketTheme.muted).frame(width: 40, height: 40) }
                        .accessibilityLabel("Filters").accessibilityValue(wantsPhotos ? "Has photos" : "All listings").accessibilityIdentifier("listingFilters")
                }
                if searching {
                    HStack {
                        Text("Searching…").font(.caption).foregroundStyle(MarketTheme.muted)
                        Spacer()
                        Button("Cancel") { store.cancelLocalAI() }.font(.caption)
                    }.accessibilityIdentifier("localAIProgress")
                }
                if curationActive {
                    HStack {
                        Text(showAllMatches ? "All listings" : "\(matchCount) \(matchCount == 1 ? "match" : "matches")")
                            .font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
                        Spacer()
                        Button(showAllMatches ? "Show matches" : "Show all") { showAllMatches.toggle() }
                            .font(.system(size: 12, weight: .semibold)).accessibilityIdentifier("toggleCuratedView")
                    }
                }
                HStack {
                    Text(query.isEmpty ? "Listings" : "Search results").font(.system(size: 20, weight: .semibold)).foregroundStyle(MarketTheme.ink)
                    Spacer()
                    Menu {
                        Button("Relevance") { store.command(["type": "set_sort", "sort": "suggested"]) }
                        Button("Newest") { store.command(["type": "set_sort", "sort": "newest"]) }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down").font(.system(size: 16, weight: .semibold)).frame(width: 44, height: 44)
                    }.accessibilityLabel("Sort listings").accessibilityValue(store.snapshot.sort == "newest" ? "Newest" : "Relevance").accessibilityIdentifier("listingSort")
                    Button { showMap.toggle() } label: { Image(systemName: showMap ? "square.grid.2x2.fill" : "map.fill") }.accessibilityLabel(showMap ? "Show grid" : "Show map").disabled(store.demo)
                    if store.ready { Text("\(visibleListings.count) \(visibleListings.count == 1 ? "listing" : "listings")").font(.system(size: 11)).foregroundStyle(MarketTheme.muted) }
                }.padding(.top, 2)
                if showMap && !store.demo {
                    MarketMapView(listings: visibleListings, onSelect: { selected = $0 }).frame(height: 440).clipShape(RoundedRectangle(cornerRadius: 20))
                } else if !store.ready { ProgressView("Loading listings…").frame(maxWidth: .infinity).padding(.vertical, 50) }
                else if visibleListings.isEmpty && searching {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 50)
                } else if visibleListings.isEmpty {
                    MarketEmptyState(symbol: query.isEmpty ? "square.grid.2x2" : "magnifyingglass", title: query.isEmpty ? "No listings" : "No results", description: query.isEmpty ? "Sell something or post what you want to buy." : "Try another search or post what you want to buy.")
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 21) {
                        ForEach(visibleListings) { listing in ListingCard(listing: listing, open: { selected = listing }, save: { store.save(listing) }) }
                    }
                }
                if !showMap && (store.snapshot.searchDiscovery?.hasMore == true || curationActive && store.snapshot.listings.contains { $0.relevance == nil }) {
                    Button("Load more") { store.continueSearch() }
                        .disabled(searching || store.busy)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("loadMoreListings")
                }
                if store.demo { Text("Sample listings · nothing here will be published").font(.system(size: 10)).foregroundStyle(MarketTheme.muted).frame(maxWidth: .infinity).padding(.top, 8).padding(.bottom, 20) }
            }.padding(.horizontal, 23)
        }.marketKeyboardDismissal()
            .onChange(of: store.snapshot.query) { _ in showAllMatches = false }
            .onChange(of: store.snapshot.side) { _ in showAllMatches = false }
            .refreshable { store.command(["type": "refresh"]) }
            .sheet(isPresented: $aiSettings) { AISettingsView(settings: store.snapshot.settings).marketSheetScope() }
            .sheet(isPresented: $filtersPresented) {
                ListingFiltersView(hasPhotos: Binding(get: { wantsPhotos }, set: { photoFilter = $0 }), canReset: photoFilter != nil, reset: { photoFilter = nil })
                    .modifier(MarketSheetScope())
            }
    }
    private func submitSearch() {
        switch NativeAIReadiness.searchAction(intentOn: store.snapshot.settings.ai.enabled, ready: store.aiSearchEnabled, busy: store.busy, inference: store.localAIProgress != nil, query: query) {
        case .wait: return
        case .settings: aiSettings = true
        case .ai: store.searchAI(query: query, side: side)
        case .text: store.filter(query: query, side: side)
        }
    }
    private func filterChip(_ label: String, value: String, symbol: String) -> some View {
        Button { side = value; store.filter(query: store.snapshot.query, side: value, aiSearch: store.snapshot.aiSearch) } label: {
            HStack(spacing: 6) { Image(systemName: symbol).font(.system(size: 11)); Text(label).font(.system(size: 12, weight: .medium)) }
                .foregroundStyle(side == value ? MarketTheme.onAction : MarketTheme.ink).padding(.horizontal, 15).padding(.vertical, 11)
                .background(side == value ? MarketTheme.action : MarketTheme.surface.opacity(0.70), in: Capsule())
        }.accessibilityIdentifier("filter\(label)").accessibilityAddTraits(side == value ? .isSelected : [])
    }
}

private struct ListingFiltersView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var hasPhotos: Bool
    let canReset: Bool
    let reset: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Text("Filters").font(.system(size: 22, weight: .semibold))
                Spacer()
                Button("Done") { dismiss() }.font(.system(size: 16, weight: .semibold))
                    .accessibilityIdentifier("closeListingFilters")
            }
            Toggle(isOn: $hasPhotos) { Label("Has photos", systemImage: "photo") }
                .toggleStyle(.switch).padding(16)
                .background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                .accessibilityIdentifier("hasPhotosFilter")
            Button("Reset", action: reset).disabled(!canReset)
                .accessibilityIdentifier("resetListingFilters")
        }.padding(24).foregroundStyle(MarketTheme.ink).tint(MarketTheme.action)
            .background(MarketTheme.paper)
        #if os(macOS)
            .frame(width: 400)
        #else
            .presentationDetents([.height(230), .medium])
            .presentationDragIndicator(.visible)
        #endif
    }
}

struct ListingCard: View {
    let listing: MarketListing
    let open: () -> Void
    let save: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: open) {
                Rectangle().fill(MarketTheme.surface).aspectRatio(1, contentMode: .fit)
                    .overlay {
                        if let urlString = listing.imageUrl, let url = URL(string: urlString) {
                            AsyncImage(url: url) { phase in
                                if let image = phase.image { image.resizable().scaledToFit() }
                                else { ListingPlaceholder(category: listing.category) }
                            }
                        } else { ListingPlaceholder(category: listing.category) }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if listing.side == "request" { Text("BUYING").font(.system(size: 8, weight: .bold)).tracking(0.8).foregroundStyle(MarketTheme.artworkInk).padding(.horizontal, 8).padding(.vertical, 6).background(.white.opacity(0.90), in: Capsule()).padding(10) }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 19))
            }.buttonStyle(.plain).accessibilityLabel("View \(listing.title)").accessibilityIdentifier("listingOpen")
                .overlay(alignment: .topTrailing) {
                    Button(action: save) { Image(systemName: listing.saved ? "heart.fill" : "heart").font(.system(size: 13, weight: .medium)).foregroundStyle(MarketTheme.artworkInk).frame(width: 32, height: 32).background(.white.opacity(0.91), in: Circle()) }.buttonStyle(.plain).padding(9)
                        .accessibilityLabel(listing.saved ? "Unsave \(listing.title)" : "Save \(listing.title)")
                }
            Button(action: open) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(listing.title).font(.system(size: 14, weight: .medium)).foregroundStyle(MarketTheme.ink).lineLimit(2).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                    Text(listing.formattedPrice).font(.system(size: 18, weight: .semibold)).foregroundStyle(MarketTheme.ink)
                    HStack(spacing: 3) { Image(systemName: "mappin").font(.system(size: 9)); Text(listing.location.isEmpty ? "Anywhere" : listing.location).lineLimit(1) }.font(.system(size: 10)).foregroundStyle(MarketTheme.muted)
                }.padding(.horizontal, 2)
            }.buttonStyle(.plain)
        }.accessibilityElement(children: .contain)
    }
}

struct SavedView: View {
    @EnvironmentObject private var store: MarketStore
    @Binding var selected: MarketListing?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                Text("Saved listings").font(.system(size: 30, weight: .medium)).tracking(-1).foregroundStyle(MarketTheme.ink)
                let saved = store.snapshot.savedListings ?? store.snapshot.listings.filter(\.saved)
                if saved.isEmpty { MarketEmptyState(symbol: "heart", title: "No saved listings", description: "Save a listing to find it here.") }
                else { LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 22) { ForEach(saved) { listing in ListingCard(listing: listing, open: { selected = listing }, save: { store.save(listing) }) } } }
            }.padding(23)
        }
    }
}

struct ProfileNameEntryView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @FocusState private var nameFocused: Bool
    @State private var existingProfile = false
    private func close() { store.dismissProfileSetup(); dismiss() }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                IrisMark().frame(width: 48, height: 48)
                Text("What should we call you?").font(.system(size: 30, weight: .semibold))
                VStack(alignment: .leading, spacing: 8) {
                    Text("Your name (optional)").font(.subheadline).foregroundStyle(MarketTheme.muted)
                    TextField(NativeProfileNames.name(seed: store.snapshot.publicKey), text: $name)
                    .textContentType(.nickname).submitLabel(.continue).textFieldStyle(.roundedBorder).focused($nameFocused)
                    .accessibilityIdentifier("profileName").onSubmit { complete() }
                }
                Button("Continue") { complete() }.buttonStyle(PrimaryButton()).disabled(store.busy || !store.ready).accessibilityIdentifier("completeProfileName")
                Button("Existing profile") { existingProfile = true }.frame(maxWidth: .infinity)
                MarketInlineError()
                Spacer(minLength: 0)
            }.padding(28).padding(.top, 24).frame(maxWidth: .infinity, maxHeight: .infinity).background(MarketTheme.paper)
                .navigationTitle("Sign in").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { close() } } }
                .sheet(isPresented: $existingProfile) { AccountSignInView().environmentObject(store) }
                .onChange(of: store.snapshot.profileNameRequired) { required in if required != true { close() } }
                .task {
                    #if os(macOS)
                    nameFocused = true
                    #endif
                }
        }
    }
    private func complete() {
        guard store.ready && !store.busy else { return }
        let chosen = name.trimmingCharacters(in: .whitespacesAndNewlines)
        store.command(["type": "update_profile", "name": chosen]) { success in if success { close() } }
    }
}
