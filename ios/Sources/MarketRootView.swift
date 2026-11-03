import SwiftUI

struct MarketRootView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("market.appearance") private var appearance = MarketAppearance.system.rawValue
    #if os(macOS)
    @StateObject private var desktopNavigation = MarketDesktopNavigation()
    @State private var desktopDidAppear = false
    @State private var desktopIsActive = NSApplication.shared.isActive
    #endif
    @State private var tab = MarketTab.browse
    @State private var compose = false
    @State private var transport = false
    @State private var wallet = false
    @State private var aiSettings = false
    @State private var selected: MarketListing?
    @State private var photoFilter: Bool?
    @State private var browseQuery = ""
    @State private var browseSide = "offer"
    enum MarketTab: String, CaseIterable {
        case browse = "Home", saved = "Saved", orders = "Orders", inbox = "Inbox", profile = "Profile", settings = "Settings", wallet = "Wallet", transport = "Transport"
        var symbol: String { switch self { case .browse: return "square.grid.2x2.fill"; case .saved: return "heart.fill"; case .orders: return "shippingbox.fill"; case .inbox: return "bubble.left.and.bubble.right.fill"; case .profile: return "person.crop.circle.fill"; case .settings: return "gearshape.fill"; case .wallet: return "wallet.pass.fill"; case .transport: return "arrow.triangle.swap" } }
    }
    private var hasProfile: Bool { store.ready && !store.demo && store.snapshot.profileNameRequired != true && !store.snapshot.publicKey.isEmpty }
    private var ownPerson: MarketPerson {
        store.snapshot.people[store.snapshot.publicKey] ?? MarketPerson(author: store.snapshot.publicKey, name: NativeProfileNames.name(seed: store.snapshot.publicKey), pictureUrl: nil, connection: MarketPerson.unnamed(store.snapshot.publicKey).connection)
    }
    var body: some View {
        #if os(macOS)
        desktopBody
        #else
        mobileBody
        #endif
    }
    private var mobileBody: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                IrisMark().frame(width: 34, height: 34)
                Text("iris market").font(.system(size: 23, weight: .semibold)).tracking(-0.8).foregroundStyle(MarketTheme.ink)
                if NativeTestStorage.enabled { Text("LOCAL TEST").font(.system(size: 9, weight: .bold)).padding(5).background(MarketTheme.peach, in: Capsule()) }
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
                    Button { wallet = true } label: { Label("Wallet", systemImage: "wallet.pass.fill") }.accessibilityIdentifier("openWallet")
                    Button { transport = true } label: { Label("Transport", systemImage: "car.fill") }.accessibilityIdentifier("openTransport")
                    Button { tab = .settings } label: { Label("Settings", systemImage: "gearshape.fill") }
                    Button { aiSettings = true } label: { Label("AI settings", systemImage: "sparkles") }
                    Divider()
                    DisplayCurrencyPicker(store: store).pickerStyle(.menu)
                    Picker("Appearance", selection: $appearance) {
                        Label("Light", systemImage: "sun.max.fill").tag(MarketAppearance.light.rawValue)
                        Label("Dark", systemImage: "moon.fill").tag(MarketAppearance.dark.rawValue)
                        Label("System", systemImage: "circle.lefthalf.filled").tag(MarketAppearance.system.rawValue)
                    }
                } label: {
                    if hasProfile { UserAvatar(person: ownPerson, size: 34).frame(width: 41, height: 41).accessibilityHidden(true) }
                    else { Image(systemName: "ellipsis").font(.system(size: 20, weight: .semibold)).frame(width: 41, height: 41).foregroundStyle(MarketTheme.muted) }
                }.menuIndicator(.hidden).accessibilityElement(children: .ignore).accessibilityLabel(Text("Menu")).accessibilityIdentifier("mainMenu")
            }.padding(.horizontal, 23).padding(.top, 10).padding(.bottom, 16)
            Group {
                switch tab {
                case .browse: BrowseView(selected: $selected, query: $browseQuery, side: $browseSide, photoFilter: $photoFilter)
                case .saved: SavedView(selected: $selected)
                case .orders: OrdersView()
                case .inbox: InboxView()
                case .profile: AuthorProfileView(author: store.snapshot.publicKey, onClose: { tab = .browse })
                case .settings: ProfileView()
                case .wallet: WalletView()
                case .transport: CourierWorkspaceView()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(spacing: 0) {
                Rectangle().fill(MarketTheme.line.opacity(0.8)).frame(height: 1)
                HStack(spacing: 0) {
                    ForEach([MarketTab.browse, .saved, .orders, .inbox], id: \.self) { item in
                        Button {
                            if tab != item {
                                store.consumePushRoute()
                                tab = item
                                if item == .saved { store.filter(query: "", side: "all") }
                                else if item == .browse { resetBrowse() }
                            }
                        } label: {
                            VStack(spacing: 5) {
                                Image(systemName: item.symbol).font(.system(size: 19, weight: .medium)).frame(height: 24)
                                Text(item.rawValue).font(.system(size: 10, weight: tab == item ? .semibold : .medium))
                            }.foregroundStyle(tab == item ? MarketTheme.ink : MarketTheme.muted.opacity(0.85))
                                .frame(maxWidth: .infinity).padding(.top, 13).padding(.bottom, 8)
                                .background(alignment: .top) { if tab == item { Capsule().fill(MarketTheme.green).frame(width: 24, height: 3) } }
                        }.accessibilityIdentifier(item == .browse ? "tabExplore" : "tab\(item.rawValue)")
                    }
                }
            }.background(MarketTheme.paper)
        }.background(MarketTheme.paper)
            .sheet(isPresented: Binding(get: { store.profileSetupRequested && store.activeSheetCount == 0 }, set: { if !$0 { store.dismissProfileSetup() } })) { ProfileNameEntryView().environmentObject(store) }
            .sheet(isPresented: $aiSettings) { AISettingsView(settings: store.snapshot.settings).marketSheetScope() }
            .sheet(isPresented: $wallet) { WalletView().marketSheetScope() }
            .sheet(isPresented: $transport) { CourierWorkspaceView().marketSheetScope() }
            .sheet(isPresented: $compose) { NewListingView().marketListingEditorSheetScope() }
            .sheet(item: $selected) { listing in ListingDetailView(listing: listing, onContact: { tab = .inbox }, onOrder: { tab = .orders }).marketSheetScope() }
            .onAppear { openPushRoute() }
            .onChange(of: store.pushRoute) { _ in openPushRoute() }
            .onChange(of: scenePhase) { _ in openPushRoute() }
            .onChange(of: store.snapshot.revision) { _ in openPushRoute() }
            .onChange(of: store.activeSheetCount) { _ in openPushRoute() }
            .alert("Unable to complete action", isPresented: Binding(get: { store.alert != nil && store.activeSheetCount == 0 }, set: { if !$0 { store.alert = nil } })) { Button("OK", role: .cancel) { store.alert = nil } } message: { Text(store.alert ?? "") }
    }
    #if os(macOS)
    private var desktopBody: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 9) {
                    IrisMark().frame(width: 28, height: 28)
                    Text("iris market").font(.system(size: 21, weight: .semibold)).tracking(-0.7)
                }.padding(.top, 16)
                Button {
                    desktopNavigation.reset()
                    if store.snapshot.profileNameRequired == true && !store.demo { store.requestProfileSetup() }
                    else { compose = true }
                } label: {
                    Label("Post a listing", systemImage: "plus").frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(MarketTheme.action, in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(MarketTheme.onAction)
                }.accessibilityIdentifier("createListing")
                VStack(spacing: 5) {
                    ForEach([MarketTab.browse, .saved, .orders, .inbox, .wallet, .transport], id: \.self) { item in desktopTab(item) }
                }
                Spacer()
                VStack(spacing: 5) {
                    if hasProfile { desktopTab(.profile) }
                    else if !store.demo { Button("Sign in") { store.requestProfileSetup() }.padding(12) }
                    desktopTab(.settings)
                }
                if store.demo { Text("Preview").font(.caption).foregroundStyle(MarketTheme.muted) }
            }.padding(16).background(MarketTheme.surface).navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            NavigationStack {
                Group {
                    if let listing = selected {
                        ListingDetailView(listing: listing, onContact: { desktopNavigation.reset(); tab = .inbox }, onOrder: { desktopNavigation.reset(); tab = .orders }, desktopSearch: desktopSearchBar, onDesktopBack: { selected = nil })
                    } else {
                        switch tab {
                        case .browse: BrowseView(selected: $selected, query: $browseQuery, side: $browseSide, photoFilter: $photoFilter, desktopSearch: desktopSearchBar)
                        case .saved: SavedView(selected: $selected)
                        case .orders: OrdersView()
                        case .inbox: InboxView()
                        case .profile: AuthorProfileView(author: store.snapshot.publicKey)
                        case .settings: ProfileView()
                        case .wallet: WalletView()
                        case .transport: CourierWorkspaceView()
                        }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).background(MarketTheme.paper)
                    .navigationTitle(selected != nil ? "Listing" : (tab == .browse && !store.snapshot.query.isEmpty ? "Search results" : tab.rawValue))
                    .marketPage(isPresented: $compose) { NewListingView().marketListingEditorSheetScope() }
                    .marketPage(isPresented: $aiSettings) { AISettingsView(settings: store.snapshot.settings).marketSheetScope() }
            }.id(tab)
        }.id(desktopNavigation.generation).navigationSplitViewStyle(.balanced).environmentObject(desktopNavigation)
            .sheet(isPresented: Binding(get: { store.profileSetupRequested }, set: { if !$0 { store.dismissProfileSetup() } })) { ProfileNameEntryView().environmentObject(store).marketSheetFrame() }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in desktopIsActive = true }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in desktopIsActive = false }
            .alert("Unable to complete action", isPresented: Binding(get: { desktopIsActive && store.alert != nil }, set: { if !$0 && desktopIsActive { store.alert = nil } })) { Button("OK", role: .cancel) { store.alert = nil } } message: { Text(store.alert ?? "") }
            .onChange(of: tab) { _ in selected = nil; compose = false }
            .onAppear {
                guard !desktopDidAppear else { return }
                desktopDidAppear = true
                openPushRoute()
            }
            .onChange(of: store.pushRoute) { _ in openPushRoute() }
    }
    private var desktopSearchBar: DesktopMarketSearchBar {
        DesktopMarketSearchBar(query: $browseQuery, submit: submitDesktopSearch)
    }
    private func submitDesktopSearch() {
        let reviewing = store.localAIProgress != nil
        switch NativeAIReadiness.searchAction(intentOn: store.snapshot.settings.ai.enabled && store.snapshot.showAllResults != true, ready: store.aiSearchEnabled, busy: store.busy && !reviewing, inference: false, query: browseQuery) {
        case .wait: return
        case .settings: desktopNavigation.reset(); aiSettings = true
        case .ai, .text:
            let useAI = store.snapshot.settings.ai.enabled && store.snapshot.showAllResults != true && !browseQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            store.filter(query: browseQuery, side: browseSide, aiSearch: useAI) { success in
                guard success else { return }
                selected = nil
                tab = .browse
                if useAI { store.runAI(type: "curate") }
            }
        }
    }
    private func desktopTab(_ item: MarketTab) -> some View {
        Button {
            desktopNavigation.reset()
            store.consumePushRoute()
            guard tab != item else { return }
            tab = item
            if item == .saved { store.filter(query: "", side: "all") }
            else if item == .browse { resetBrowse() }
        } label: {
            Label(item.rawValue, systemImage: item.symbol).font(.system(size: 14, weight: tab == item ? .semibold : .regular))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 11)
                .foregroundStyle(tab == item ? MarketTheme.ink : MarketTheme.muted)
                .background(tab == item ? MarketTheme.mint : .clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }.accessibilityIdentifier(item == .browse ? "tabExplore" : "tab\(item.rawValue)").accessibilityAddTraits(tab == item ? .isSelected : [])
    }
    #endif
    private func resetBrowse() {
        browseQuery = ""
        browseSide = "offer"
        store.filter(query: "", side: "offer")
    }
    private func openPushRoute() {
        guard scenePhase == .active, store.ready, !store.demo, store.snapshot.profileNameRequired != true, let route = store.pushRoute else { return }
        #if os(macOS)
        desktopNavigation.reset()
        #endif
        compose = false; transport = false; wallet = false; aiSettings = false; selected = nil
        if let id = route.orderID {
            tab = .orders
            guard store.activeSheetCount == 0, store.snapshot.orders.contains(where: { $0.id == id }) else { return }
            store.activeOrderID = id; store.consumePushRoute()
        } else { tab = .inbox }
    }
}

#if os(macOS)
struct DesktopMarketSearchBar: View {
    @Binding var query: String
    let submit: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").font(.system(size: 18)).foregroundStyle(MarketTheme.muted)
                TextField("Search listings", text: $query).textFieldStyle(.plain).font(.system(size: 16))
                    .accessibilityIdentifier("marketSearch").onSubmit(submit)
                if !query.isEmpty {
                    Button { query = ""; submit() } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(MarketTheme.muted).frame(width: 36, height: 44)
                    }.buttonStyle(.plain).accessibilityLabel("Clear search")
                }
            }.padding(.horizontal, 16).frame(height: 52)
                .background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(MarketTheme.line, lineWidth: 1))
            Button(action: submit) {
                Text("Search").font(.system(size: 15, weight: .semibold))
                    .padding(.horizontal, 22).frame(height: 52)
                    .background(MarketTheme.action, in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(MarketTheme.onAction).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("submitSearch")
        }
    }
}
#endif

struct BrowseView: View {
    @EnvironmentObject private var store: MarketStore
    @Binding var selected: MarketListing?
    @Binding var query: String
    @Binding var side: String
    private var showAllMatches: Bool { store.snapshot.showAllResults == true }
    @AppStorage("market.listLayout") private var listLayout = false
    @State private var showMap = false
    @State private var aiSettings = false
    @State private var filtersPresented = false
    @State private var browseVisibilityID = UUID()
    @Binding var photoFilter: Bool?
    #if os(macOS)
    var desktopSearch: DesktopMarketSearchBar? = nil
    #endif
    private var curationActive: Bool { store.curationActive }
    private var searching: Bool { store.localAIProgress != nil || store.snapshot.searchDiscovery?.loading == true || curationActive && store.busy }
    private var matchCount: Int { store.snapshot.listings.filter { $0.matchesSearch }.count }
    private var unavailableCount: Int { store.snapshot.listings.filter { $0.relevance?.unavailable == true }.count }
    private var unfinishedSearch: Bool { curationActive && (store.searchPaused || store.snapshot.searchDiscovery?.hasMore == true || store.snapshot.listings.contains { $0.externalOrder == nil && $0.relevance == nil }) }
    private var matchSummary: String {
        if showAllMatches { return "All listings" }
        if matchCount > 0 { return "\(matchCount) \(matchCount == 1 ? "match" : "matches")" }
        if store.searchPaused { return "Search paused" }
        return searching || unfinishedSearch ? "No matches yet" : "0 matches"
    }
    private var wantsPhotos: Bool { NativePhotoFilter.wantsPhotos(choice: photoFilter, query: store.snapshot.query, side: store.snapshot.side, map: showMap) }
    var body: some View {
        let requireMatch = curationActive && !showAllMatches
        let visibleListings = store.snapshot.listings.filter { listing in
            (!requireMatch || listing.matchesSearch) && NativePhotoFilter.includes(imageURL: listing.imageUrl, choice: photoFilter, query: store.snapshot.query, side: store.snapshot.side, map: showMap, bitcoin: listing.isBitcoinOffer)
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                #if os(macOS)
                desktopSearch.padding(.top, 6)
                #else
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 17)).foregroundStyle(MarketTheme.muted)
                    TextField("Search listings", text: $query, prompt: Text("Search listings").foregroundColor(MarketTheme.muted)).textFieldStyle(.plain).font(.system(size: 14)).submitLabel(.search).accessibilityIdentifier("marketSearch")
                        .onSubmit { submitSearch() }
                    if !query.isEmpty { Button { query = ""; store.filter(query: "", side: side) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(MarketTheme.muted) }.accessibilityLabel("Clear search") }
                }.padding(.horizontal, 16).frame(height: 51).background(MarketTheme.surface.opacity(0.82), in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(MarketTheme.line, lineWidth: 1))
                #endif
                if store.snapshot.settings.ai.provider == "apple", let reason = store.appleAIUnavailableReason {
                    Text(reason).font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("appleAIAvailability")
                }
                if let problem = store.refreshProblem {
                    Text(problem).font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("feedRefreshStatus")
                }
                HStack(spacing: 8) {
                    filterChip("Selling", value: "offer", symbol: "tag.fill")
                    filterChip("Buying", value: "request", symbol: "hand.wave.fill")
                    Spacer()
                    Button("Filters (\((wantsPhotos ? 1 : 0) + (requireMatch ? 1 : 0)))") { filtersPresented = true }
                        .font(.subheadline).accessibilityIdentifier("listingFilters")
                }
                if searching {
                    HStack {
                        Text(store.homeFilterActive ? "Choosing listings…" : "Searching…").font(.caption).foregroundStyle(MarketTheme.muted)
                        Spacer()
                        Button("Cancel") { store.cancelLocalAI() }.font(.caption)
                    }.accessibilityIdentifier("localAIProgress")
                }
                if store.snapshot.settings.ai.enabled {
                    HStack {
                        if curationActive { Text(store.homeFilterActive ? "For you · \(matchSummary)" : matchSummary)
                            .font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
                        Spacer()
                        Button(showAllMatches ? "Show AI selected" : "Show all") {
                            if showAllMatches && !store.aiSearchEnabled { aiSettings = true }
                            else { store.selectResultView(showAll: !showAllMatches) }
                        }.accessibilityIdentifier("resultView")
                    }
                    if store.searchPaused, let status = store.localAIStatus {
                        Text(status).font(.caption).foregroundStyle(MarketTheme.muted)
                    }
                    if unavailableCount > 0 {
                        Text("AI couldn’t review \(unavailableCount) \(unavailableCount == 1 ? "listing" : "listings"). Choose Show all to search by text.")
                            .font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("unreviewedListings")
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
                    if !showMap { ListingLayoutButton(listLayout: $listLayout) }
                    Button(showMap ? "Listings" : "Map") { showMap.toggle() }.font(.subheadline).accessibilityLabel(showMap ? "Show listings" : "Show map").disabled(store.demo)
                    if store.ready { Text("\(visibleListings.count) \(visibleListings.count == 1 ? "listing" : "listings")").font(.system(size: 11)).foregroundStyle(MarketTheme.muted) }
                }.padding(.top, 2)
                if showMap && !store.demo {
                    MarketMapView(listings: visibleListings, onSelect: { selected = $0 }).frame(height: 440).clipShape(RoundedRectangle(cornerRadius: 20))
                } else if visibleListings.isEmpty {
                    MarketEmptyState(symbol: query.isEmpty ? "square.grid.2x2" : "magnifyingglass", title: curationActive ? (store.searchPaused ? "Review paused" : searching || unfinishedSearch ? "No matches yet" : "No matches") : query.isEmpty ? "No listings yet" : "No results", description: curationActive ? "New matches appear as they are reviewed. Choose Show all to search by text." : query.isEmpty ? "Sell something or post what you want to buy." : "Try another search or post what you want to buy.")
                } else {
                    LazyVGrid(columns: listLayout ? [GridItem(.flexible())] : marketListingColumns, alignment: .leading, spacing: listLayout ? 12 : 21) {
                        ForEach(visibleListings) { listing in ListingCard(listing: listing, compact: listLayout, open: { selected = listing }, save: { store.save(listing) }) }
                    }
                }
                if !showMap && (store.snapshot.searchDiscovery?.hasMore == true || curationActive && store.snapshot.listings.contains { $0.externalOrder == nil && $0.relevance == nil }) {
                    Button("Load more") { store.continueSearch() }
                        .disabled(searching || store.busy)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("loadMoreListings")
                }
                if store.demo { Text("Sample listings · nothing here will be published").font(.system(size: 10)).foregroundStyle(MarketTheme.muted).frame(maxWidth: .infinity).padding(.top, 8).padding(.bottom, 20) }
            }.padding(.horizontal, 23)
        }.marketKeyboardDismissal()
            .onAppear { store.setBrowseVisible(true, owner: browseVisibilityID) }
            .onDisappear { store.setBrowseVisible(false, owner: browseVisibilityID) }
            .refreshable { store.command(["type": "refresh"]) }
            .marketPage(isPresented: $aiSettings) { AISettingsView(settings: store.snapshot.settings).marketSheetScope() }
            .sheet(isPresented: $filtersPresented) {
                ListingFiltersView(hasPhotos: Binding(get: { wantsPhotos }, set: { photoFilter = $0 }), canReset: photoFilter != nil, reset: { photoFilter = nil }, ai: store.snapshot.settings.ai)
                    .modifier(MarketSheetScope())
            }
    }
    private func submitSearch() {
        let homeReview = store.homeFilterActive && store.localAIProgress != nil
        switch NativeAIReadiness.searchAction(intentOn: store.snapshot.settings.ai.enabled && store.snapshot.showAllResults != true, ready: store.aiSearchEnabled, busy: store.busy && !homeReview, inference: store.localAIProgress != nil && !homeReview, query: query) {
        case .wait: return
        case .settings: aiSettings = true
        case .ai: if homeReview { store.cancelLocalAI() }; store.searchAI(query: query, side: side)
        case .text: if homeReview { store.cancelLocalAI() }; store.filter(query: query, side: side)
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
    @EnvironmentObject private var store: MarketStore
    @Binding var hasPhotos: Bool
    let canReset: Bool
    let reset: () -> Void
    @State var ai: AISettings

    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 22) {
            HStack {
                Text("Filters").font(.system(size: 22, weight: .semibold))
                Spacer()
                Button("Done") { store.saveHomeFilter(enabled: ai.curateFeed, prompt: ai.interests); dismiss() }.font(.system(size: 16, weight: .semibold))
                    .accessibilityIdentifier("closeListingFilters")
            }
            if store.curationActive && store.snapshot.showAllResults != true { Text("AI selection is on.").font(.caption) }
            if let terms = store.snapshot.relatedSearchTerms, !terms.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Also searched for").font(.headline)
                    Text(terms.joined(separator: " · ")).font(.subheadline)
                }
            }
            Toggle(isOn: $hasPhotos) { Label("Has photos", systemImage: "photo") }
                .toggleStyle(.switch).padding(16)
                .background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                .accessibilityIdentifier("hasPhotosFilter")
            VStack(alignment: .leading, spacing: 10) {
                Toggle("Home feed", isOn: $ai.curateFeed).accessibilityIdentifier("homeFeedFilter")
                Text("What would you like to see?").font(.subheadline)
                TextField("Inspiring, positive and useful listings", text: $ai.interests, axis: .vertical)
                    .lineLimit(4...7).textFieldStyle(.roundedBorder).accessibilityIdentifier("homeFeedPrompt")
                    .onChange(of: ai.interests) { value in if value.count > 1000 { ai.interests = String(value.prefix(1000)) } }
                Text("Uses your selected AI when enabled. Search keeps its own query.").font(.caption).foregroundStyle(MarketTheme.muted)
            }
            Button("Reset", action: reset).disabled(!canReset)
                .accessibilityIdentifier("resetListingFilters")
        }.padding(24) }.foregroundStyle(MarketTheme.ink).tint(MarketTheme.action)
            .background(MarketTheme.paper)
        #if os(macOS)
            .frame(width: 460, height: 460)
        #else
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        #endif
    }
}

private struct ListingLayoutButton: View {
    @Binding var listLayout: Bool
    var body: some View {
        Button(listLayout ? "Grid" : "List") { listLayout.toggle() }
            .font(.subheadline).accessibilityLabel(listLayout ? "Show as grid" : "Show as list")
    }
}

struct ListingCard: View {
    let listing: MarketListing
    var compact = false
    let open: () -> Void
    let save: () -> Void
    var body: some View {
        let layout = compact ? AnyLayout(HStackLayout(alignment: .center, spacing: 12)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
        layout {
            Button(action: open) {
                Rectangle().fill(MarketTheme.surface).aspectRatio(1, contentMode: .fit)
                    .overlay {
                        if let order = listing.externalOrder {
                            VStack(spacing: 4) {
                                Image(systemName: "bitcoinsign.circle.fill")
                                Text(order.platform).font(.caption).lineLimit(1)
                            }.foregroundStyle(MarketTheme.muted)
                        } else if let urlString = listing.imageUrl, let url = URL(string: urlString) {
                            AsyncImage(url: url) { phase in
                                if let image = phase.image { image.resizable().scaledToFit() }
                                else { ListingPlaceholder(category: listing.category) }
                            }
                        } else { ListingPlaceholder(category: listing.category) }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if !compact && listing.side == "request" { Text("BUYING").font(.system(size: 8, weight: .bold)).tracking(0.8).foregroundStyle(MarketTheme.artworkInk).padding(.horizontal, 8).padding(.vertical, 6).background(.white.opacity(0.90), in: Capsule()).padding(10) }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 19))
                    .frame(width: compact ? 86 : nil, height: compact ? 86 : nil)
            }.buttonStyle(.plain).accessibilityLabel("View \(listing.title)").accessibilityIdentifier("listingOpen")
                .overlay(alignment: .topTrailing) {
                    Button(action: save) { Image(systemName: listing.saved ? "heart.fill" : "heart").font(.system(size: 13, weight: .medium)).foregroundStyle(MarketTheme.artworkInk).frame(width: 32, height: 32).background(.white.opacity(0.91), in: Circle()) }.buttonStyle(.plain).padding(9)
                        .accessibilityLabel(listing.saved ? "Unsave \(listing.title)" : "Save \(listing.title)")
                }
            Button(action: open) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(listing.title).font(.system(size: 14, weight: .medium)).foregroundStyle(MarketTheme.ink).lineLimit(2).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                    Text(listing.formattedPrice).font(.system(size: 18, weight: .semibold)).foregroundStyle(MarketTheme.ink)
                    if let terms = listing.escrow?.bitcoinTerms { Text(terms).font(.caption).foregroundStyle(MarketTheme.muted) }
                    if let order = listing.externalOrder { Text(order.methods).font(.caption).foregroundStyle(MarketTheme.muted).lineLimit(1) }
                    else { HStack(spacing: 3) { Image(systemName: "mappin").font(.system(size: 9)); Text(listing.location.isEmpty ? "Anywhere" : listing.location).lineLimit(1) }.font(.system(size: 10)).foregroundStyle(MarketTheme.muted) }
                }.padding(.horizontal, 2)
            }.buttonStyle(.plain)
        }.accessibilityElement(children: .contain)
    }
}

struct SavedView: View {
    @EnvironmentObject private var store: MarketStore
    @AppStorage("market.listLayout") private var listLayout = false
    @Binding var selected: MarketListing?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                HStack { Text("Saved listings").font(.system(size: 30, weight: .medium)).tracking(-1).foregroundStyle(MarketTheme.ink); Spacer(); ListingLayoutButton(listLayout: $listLayout) }
                let saved = store.snapshot.savedListings ?? store.snapshot.listings.filter(\.saved)
                if saved.isEmpty { MarketEmptyState(symbol: "heart", title: "No saved listings", description: "Save a listing to find it here.") }
                else { LazyVGrid(columns: listLayout ? [GridItem(.flexible())] : marketListingColumns, spacing: listLayout ? 12 : 22) { ForEach(saved) { listing in ListingCard(listing: listing, compact: listLayout, open: { selected = listing }, save: { store.save(listing) }) } } }
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
