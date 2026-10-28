import SwiftUI

struct ConnectionBadge: View {
    let connection: MarketConnection
    var body: some View {
        if let badge = connection.badge {
            Image(systemName: "checkmark.seal.fill")
                .foregroundColor(badge == "following" ? .blue : badge == "trusted" ? .orange : MarketTheme.muted)
                .accessibilityLabel(connection.description)
        } else if let distance = connection.followDistance {
            Text("\(distance) hops").font(.caption2).foregroundStyle(MarketTheme.muted).accessibilityLabel(connection.description)
        }
    }
}

struct AuthorProfileView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var author: String
    @State private var history: [String] = []
    @State private var selection = "known"
    @State private var selectedListing: MarketListing?
    init(author: String) { _author = State(initialValue: author) }
    private var profile: PublicMarketProfile? { store.snapshot.profile?.person.author == author ? store.snapshot.profile : nil }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let profile {
                        HStack(spacing: 15) {
                            UserAvatar(person: profile.person, size: 64)
                            VStack(alignment: .leading, spacing: 7) {
                                UserName(person: profile.person).font(.title2.weight(.semibold))
                                Text(profile.person.connection.description).font(.caption).foregroundStyle(MarketTheme.muted)
                            }
                        }
                        if profile.loading { ProgressView("Loading profile…") }
                        if !profile.about.isEmpty { Text(profile.about).font(.body).textSelection(.enabled) }
                        if let website = profile.website, let url = URL(string: website) { Link(website, destination: url).font(.subheadline).lineLimit(2) }
                        let authorListings = store.snapshot.listings.filter { $0.author == author }
                        if !authorListings.isEmpty {
                            Text("Listings in this feed").font(.headline)
                            ForEach(authorListings) { listing in Button { selectedListing = listing } label: {
                                HStack { Text(listing.title).multilineTextAlignment(.leading); Spacer(); Text(listing.formattedPrice).fontWeight(.medium) }.foregroundStyle(MarketTheme.ink).padding(.vertical, 6)
                            } }
                        }
                        Text(profile.graphLabel).font(.caption.weight(.medium)).foregroundStyle(MarketTheme.green)
                        if !profile.loading && (!profile.graphContextLoaded || profile.error != nil) {
                            HStack {
                                Text("Some connections are unavailable.").font(.caption).foregroundStyle(MarketTheme.muted)
                                Spacer()
                                Button("Retry") { store.command(["type": "load_profile", "author": author]) }.font(.caption)
                            }
                        }
                        Picker("People", selection: $selection) {
                            Text("Known \(profile.followedByKnown.count)").tag("known")
                            Text("Following \(profile.followingCount)").tag("following")
                            Text("Followers \(profile.followers.count)+").tag("followers")
                        }.pickerStyle(.segmented)
                        let people = selection == "following" ? profile.following : selection == "followers" ? profile.followers : profile.followedByKnown
                        if people.isEmpty { Text(profile.loading ? "Loading…" : "No connections to show.").font(.subheadline).foregroundStyle(MarketTheme.muted).padding(.vertical, 20) }
                        ForEach(people) { person in
                            Button { history.append(author); author = person.author } label: {
                                UserRow(person: person, subtitle: person.connection.description)
                            }.buttonStyle(.plain)
                        }
                    } else { ProgressView("Loading profile…").frame(maxWidth: .infinity).padding(.vertical, 60) }
                }.padding(23)
            }.background(MarketTheme.paper).navigationTitle("Profile").marketInlineTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { if !history.isEmpty { Button("Back") { author = history.removeLast() } } }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
                .sheet(item: $selectedListing) { listing in ListingDetailView(listing: listing).marketSheetScope() }
                .task(id: author) { store.command(["type": "load_profile", "author": author]) }
        }
    }
}
