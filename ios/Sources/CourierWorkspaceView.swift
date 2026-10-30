import SwiftUI

struct CourierWorkspaceView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var section = "work"
    @AppStorage("market.transport.type") private var typeValue = NativeTransportType.parcel.rawValue
    @State private var area = ""
    @State private var appliedArea = ""
    @State private var selected: MarketListing?
    @State private var order: TransportOrderSelection?
    @State private var compose = false
    @State private var inbox = false
    @State private var previousFilter: (query: String, side: String, ai: Bool)?
    private var type: NativeTransportType { NativeTransportType(rawValue: typeValue) ?? .parcel }
    private var jobs: [MarketOrder] {
        store.snapshot.orders.filter { !$0.archived && $0.handlesDelivery(store.snapshot.publicKey) }
            .sorted { $0.terminal == $1.terminal ? $0.updatedAt > $1.updatedAt : !$0.terminal }
    }
    private var listings: [MarketListing] {
        store.snapshot.listings.filter { listing in
            listing.status == "active" && (listing.expiresAt == nil || listing.expiresAt! > Int64(Date().timeIntervalSince1970)) &&
            type.includes(listing.tags ?? []) &&
            (section == "service" ? listing.side == "offer" && listing.author == store.snapshot.publicKey : listing.side == "request" && listing.author != store.snapshot.publicKey) &&
            (appliedArea.isEmpty || listing.location.localizedStandardContains(appliedArea))
        }.sorted { $0.createdAt > $1.createdAt }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Transport workspace", selection: $section) {
                        Text("Find work").tag("work"); Text("My jobs").tag("jobs"); Text("My service").tag("service")
                    }.pickerStyle(.segmented).accessibilityIdentifier("transportSections")
                    if section == "jobs" {
                        HStack { Label("\(jobs.filter { !$0.terminal }.count) active", systemImage: "car.fill"); Spacer(); Text("\(jobs.filter { $0.status == "delivered" }.count) completed") }.font(.subheadline).foregroundStyle(MarketTheme.muted)
                        if jobs.isEmpty { MarketEmptyState(symbol: "car.fill", title: "No jobs yet", description: "Agree on work through a private enquiry. Assigned delivery stops appear here.") }
                        ForEach(jobs) { job in jobCard(job) }
                    } else {
                        Picker("Service type", selection: $typeValue) { ForEach(NativeTransportType.allCases) { Text($0.label).tag($0.rawValue) } }.pickerStyle(.segmented).accessibilityIdentifier("transportType")
                        HStack {
                            TextField("City or area", text: $area).submitLabel(.search).onSubmit { appliedArea = area.trimmingCharacters(in: .whitespacesAndNewlines) }
                            Button("Apply") { appliedArea = area.trimmingCharacters(in: .whitespacesAndNewlines) }
                        }.padding(14).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 15))
                        if section == "service" {
                            Button { compose = true } label: { Label("Announce your service", systemImage: "plus.circle.fill") }.buttonStyle(PrimaryButton()).accessibilityIdentifier("announceTransport")
                            Text("Create a public listing with your service area, rates and availability. Exact routes stay in private orders.").font(.footnote).foregroundStyle(MarketTheme.muted)
                        } else { Text("Public requests · agree on the route and price privately before taking a job.").font(.footnote).foregroundStyle(MarketTheme.muted) }
                        if listings.isEmpty { MarketEmptyState(symbol: "mappin.and.ellipse", title: section == "service" ? "No service listings" : "No matching requests", description: section == "service" ? "Tell people where and when you can help." : "Try another area or service type. Pull down to refresh.") }
                        ForEach(listings) { listing in
                            Button { selected = listing } label: {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack { Text(listing.title).font(.headline); Spacer(); Image(systemName: "chevron.right") }
                                    Label(listing.location.isEmpty ? "Area not specified" : listing.location, systemImage: "mappin.circle.fill").font(.subheadline).foregroundStyle(MarketTheme.muted)
                                    Text(listing.formattedPrice).font(.title3.weight(.semibold))
                                }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                            }.buttonStyle(.plain)
                        }
                    }
                    if store.demo { Text("Preview stays offline. Sample jobs are not real work.").font(.footnote).foregroundStyle(MarketTheme.muted) }
                }.padding(23)
            }.background(MarketTheme.paper).foregroundStyle(MarketTheme.ink).navigationTitle("Transport").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .refreshable { store.command(["type": "refresh"]) }
                .onAppear {
                    if previousFilter == nil { previousFilter = (store.snapshot.query, store.snapshot.side, store.snapshot.aiSearch) }
                    if section != "jobs" { store.filter(query: "", side: section == "service" ? "offer" : "request") }
                }
                .onChange(of: section) { value in
                    if value != "jobs" { store.filter(query: "", side: value == "service" ? "offer" : "request") }
                }
                .onDisappear {
                    if let previousFilter { store.filter(query: previousFilter.query, side: previousFilter.side, aiSearch: previousFilter.ai) }
                }
                .sheet(item: $selected) { listing in ListingDetailView(listing: listing, onContact: { inbox = true }, onOrder: { section = "jobs" }).marketSheetScope() }
                .sheet(item: $order) { value in OrderDetailView(orderID: value.id).marketSheetScope() }
                .sheet(isPresented: $compose) { NewListingView(transport: type, area: appliedArea).marketSheetScope() }
                .sheet(isPresented: $inbox) { NavigationStack { InboxView().navigationTitle("Inbox").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { inbox = false } } } }.marketSheetScope() }
        }
    }
    private func jobCard(_ job: MarketOrder) -> some View {
        Button { order = TransportOrderSelection(id: job.id) } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text(job.title.isEmpty ? "Transport job" : job.title).font(.headline); Spacer(); Text(job.statusLabel).font(.caption.weight(.semibold)) }
                if let next = job.shipment.stops.first(where: { $0.status != "completed" && (job.seller == store.snapshot.publicKey || $0.courierPubkey == store.snapshot.publicKey) }), !job.terminal {
                    Label(next.label.isEmpty ? "Next stop" : next.label, systemImage: "location.fill").font(.subheadline)
                    if !next.address.isEmpty { Text(next.address).font(.subheadline).foregroundStyle(MarketTheme.muted) }
                    if let eta = job.shipment.eta { Text("Expected \(Date(timeIntervalSince1970: Double(eta)).formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(MarketTheme.muted) }
                }
                if job.sync == "queued" { Text("Waiting to send").font(.caption).foregroundStyle(MarketTheme.muted) }
                Text("Open job").font(.subheadline.weight(.semibold)).foregroundStyle(MarketTheme.green)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
        }.buttonStyle(.plain)
    }
}

private struct TransportOrderSelection: Identifiable { let id: String }
