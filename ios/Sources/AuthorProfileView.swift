import SwiftUI

struct ConnectionBadge: View {
    let connection: MarketConnection
    var body: some View {
        if let badge = connection.badge {
            Image(systemName: "checkmark.seal.fill")
                .foregroundColor(badge == "following" ? .blue : badge == "trusted" ? .orange : MarketTheme.muted)
                .accessibilityLabel(connection.description)
        } else if let distance = connection.followDistance {
            Text("\(distance) away").font(.caption2).foregroundStyle(MarketTheme.muted).accessibilityLabel(connection.description)
        }
    }
}

struct AuthorProfileView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var author: String
    @State private var history: [String] = []
    @State private var selection: String?
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
                                Text(profile.person.connection.followDistance == nil ? "No known connections" : profile.person.connection.description).font(.caption).foregroundStyle(MarketTheme.muted)
                            }
                        }
                        if profile.loading { ProgressView("Loading profile…") }
                        if !profile.about.isEmpty { Text(profile.about).font(.body).textSelection(.enabled) }
                        if let website = profile.website, let url = URL(string: website) { Link(website, destination: url).font(.subheadline).lineLimit(2) }
                        HStack(spacing: 18) {
                            connectionControl("Known", count: profile.followedByKnown.count, value: "known")
                            connectionControl("Following", count: profile.followingCount, value: "following")
                            connectionControl("Followers", count: profile.followersLoaded == true ? profile.followers.count : nil, value: "followers")
                        }
                        if let selection {
                            if !profile.loading && (!profile.graphContextLoaded || profile.error != nil) {
                                HStack {
                                    Text("Some connections are unavailable.").font(.caption).foregroundStyle(MarketTheme.muted)
                                    Spacer()
                                    Button("Retry") { store.command(["type": "load_profile", "author": author]) }.font(.caption)
                                }
                            }
                            let people = selection == "following" ? profile.following : selection == "followers" ? profile.followers : profile.followedByKnown
                            if people.isEmpty { Text((selection == "followers" ? profile.followersLoading == true : profile.loading) ? "Loading…" : "No connections to show.").font(.subheadline).foregroundStyle(MarketTheme.muted).padding(.vertical, 12) }
                            ForEach(people) { person in
                                Button { history.append(author); switchAuthor(person.author) } label: {
                                    UserRow(person: person, subtitle: person.connection.description)
                                }.buttonStyle(.plain)
                            }
                        } else {
                            let feed = store.snapshot.profileListings.flatMap { $0.author == author ? $0 : nil }
                            let authorListings = feed?.listings ?? []
                            Text("Listings").font(.headline).accessibilityIdentifier("profileListings")
                            if authorListings.isEmpty && feed?.loading != true { Text("No listings to show yet.").font(.subheadline).foregroundStyle(MarketTheme.muted).padding(.vertical, 12) }
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 22) {
                                ForEach(authorListings) { listing in
                                    ListingCard(listing: listing, open: { selectedListing = listing }, save: { store.save(listing) })
                                }
                            }
                            if feed?.loading == true { ProgressView("Loading listings…").font(.caption) }
                            if let issue = feed?.error {
                                HStack { Text(issue).font(.caption).foregroundStyle(MarketTheme.muted); Spacer(); Button("Retry") { loadMore() } }
                            } else if feed?.canLoadMore == true {
                                Button("Load more") { loadMore() }.frame(maxWidth: .infinity).disabled(feed?.loading == true).accessibilityIdentifier("profileLoadMore")
                            }
                        }
                    } else { ProgressView("Loading profile…").frame(maxWidth: .infinity).padding(.vertical, 60) }
                }.padding(23)
            }.background(MarketTheme.paper).navigationTitle("Profile").marketInlineTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { if !history.isEmpty { Button("Back") { switchAuthor(history.removeLast()) } } }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
                .sheet(item: $selectedListing) { listing in ListingDetailView(listing: listing).marketSheetScope() }
                .task(id: author) { store.command(["type": "load_profile", "author": author]) }
                .onDisappear { cancelFollowers(); store.command(["type": "close_profile", "author": author]) }
        }
    }
    private func loadFollowers() { store.command(["type": "load_profile_followers", "author": author]) }
    private func cancelFollowers() { store.command(["type": "cancel_profile_followers", "author": author]) }
    private func switchAuthor(_ next: String) { cancelFollowers(); selection = nil; author = next }
    private func loadMore() { store.command(["type": "load_more_profile_listings", "author": author]) }
    private func connectionControl(_ label: String, count: Int?, value: String) -> some View {
        Button {
            let next = selection == value ? nil : value
            if selection == "followers" && next != "followers" { cancelFollowers() }
            selection = next
            if next == "followers", profile?.followersLoaded != true, profile?.followersLoading != true { loadFollowers() }
        } label: {
            HStack(spacing: 4) { if let count { Text("\(count)").fontWeight(.semibold) }; Text(label) }
                .font(.caption).foregroundStyle(selection == value ? MarketTheme.green : MarketTheme.muted)
        }.buttonStyle(.plain).accessibilityIdentifier("profile\(label)")
            .accessibilityAddTraits(selection == value ? .isSelected : [])
    }

}
