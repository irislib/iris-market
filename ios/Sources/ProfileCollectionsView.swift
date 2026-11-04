import SwiftUI

struct ProfileCollectionsView: View {
    let feed: ProfileListingPage?
    let snapshot: MarketSnapshot
    let author: String
    let open: (MarketListing) -> Void
    let saveItem: (MarketListing) -> Void
    let select: (String?) -> Void
    let retry: () -> Void
    let more: () -> Void
    let publish: ([String: Any], @escaping (Bool) -> Void) -> Void

    @State private var expanded: String?
    @State private var editing = false
    @State private var original: MarketCollection?
    private var owner: Bool { author == snapshot.publicKey && snapshot.canSign && !snapshot.demo }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if editing && owner {
                CollectionEditor(original: original, feed: feed, saved: snapshot.savedListings ?? [], people: snapshot.people,
                                 more: more, cancel: { editing = false }, publish: publish)
            } else {
                HStack {
                    Text("Collections").font(.headline)
                    Spacer()
                    if owner {
                        Button { original = nil; editing = true } label: { Label("New collection", systemImage: "plus") }
                    }
                }
                if let issue = feed?.collectionsError {
                    HStack { Text(issue).font(.caption).foregroundStyle(MarketTheme.muted); Button("Retry", action: retry) }
                } else if feed?.collections?.isEmpty != false {
                    Text("No public collections yet.").foregroundStyle(MarketTheme.muted)
                }
                ForEach(feed?.collections ?? []) { collection in
                    VStack(alignment: .leading, spacing: 10) {
                        Button {
                            expanded = expanded == collection.id ? nil : collection.id
                            select(expanded)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(collection.title).font(.headline)
                                    Text(collection.delivery == "queued" ? "Queued to publish" : "\(collection.members.count) \(collection.members.count == 1 ? "listing" : "listings")")
                                        .font(.caption).foregroundStyle(MarketTheme.muted)
                                }
                                Spacer()
                                Image(systemName: expanded == collection.id ? "chevron.down" : "chevron.forward").foregroundStyle(MarketTheme.muted)
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        if expanded == collection.id {
                            if owner { Button("Edit collection") { original = collection; editing = true } }
                            ForEach(collection.members) { member in
                                if let item = member.listing {
                                    VStack(alignment: .leading, spacing: 4) {
                                        ListingCard(listing: item, compact: true, open: { open(item) }, save: { saveItem(item) })
                                        Text("Listed by \((snapshot.people[item.author] ?? .unnamed(item.author)).displayName)").font(.caption).foregroundStyle(MarketTheme.muted)
                                    }
                                }
                            }
                            let missing = collection.members.filter { $0.listing == nil }.count
                            if missing > 0 {
                                Text(missing == 1 ? "1 listing unavailable" : "\(missing) listings unavailable").font(.caption).foregroundStyle(MarketTheme.muted)
                            }
                        }
                    }.padding(.vertical, 4)
                    Divider()
                }
            }
        }
    }
}

private struct CollectionEditor: View {
    let original: MarketCollection?
    let feed: ProfileListingPage?
    let saved: [MarketListing]
    let people: [String: MarketPerson]
    let more: () -> Void
    let cancel: () -> Void
    let publish: ([String: Any], @escaping (Bool) -> Void) -> Void

    @State private var title: String
    @State private var selection: [String]
    @State private var submitting = false
    @State private var failure: String?

    init(original: MarketCollection?, feed: ProfileListingPage?, saved: [MarketListing], people: [String: MarketPerson],
         more: @escaping () -> Void, cancel: @escaping () -> Void,
         publish: @escaping ([String: Any], @escaping (Bool) -> Void) -> Void) {
        self.original = original; self.feed = feed; self.saved = saved; self.people = people
        self.more = more; self.cancel = cancel; self.publish = publish
        _title = State(initialValue: original?.title ?? "")
        _selection = State(initialValue: original?.members.map(\.id) ?? [])
    }

    private var candidates: [MarketCollection.Member] {
        var entries = Set<String>()
        let current = feed?.collections?.first { $0.eventId == original?.eventId } ?? original
        let eligible = ((feed?.listings ?? []) + saved).filter { $0.status == "active" && $0.id.hasPrefix($0.author + ":") }
        return ((current?.members ?? []) + eligible.map { .init(id: $0.id, listing: $0) }).filter { entries.insert($0.id).inserted }
    }
    private var name: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(original == nil ? "New collection" : "Edit collection").font(.headline)
            TextField("Collection name", text: $title).textFieldStyle(.roundedBorder)
            if name.unicodeScalars.count > 160 { Text("Use a name of 160 characters or fewer.").font(.caption).foregroundStyle(.red) }
            Text("Choose from your listings and saved items. Only the items you select will appear in this public collection.").font(.subheadline).foregroundStyle(MarketTheme.muted)
            if candidates.isEmpty { Text("Save a listing or post your own to start a collection.").font(.subheadline) }
            ForEach(candidates) { member in
                let chosen = selection.contains(member.id)
                Button {
                    if chosen { selection.removeAll { $0 == member.id } } else { selection.append(member.id) }
                } label: {
                    HStack {
                        Image(systemName: chosen ? "checkmark.circle.fill" : "circle").foregroundStyle(chosen ? MarketTheme.green : MarketTheme.muted)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(member.listing?.title ?? "Unavailable listing").lineLimit(2)
                            if let item = member.listing {
                                Text((people[item.author] ?? .unnamed(item.author)).displayName).font(.caption).foregroundStyle(MarketTheme.muted)
                            }
                        }
                        Spacer()
                    }.padding(.vertical, 4).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(chosen ? .isSelected : []).disabled(!chosen && selection.count >= 64)
            }
            if selection.count == 64 { Text("64 listings selected · collection limit reached.").font(.caption).foregroundStyle(MarketTheme.muted) }
            if feed?.canLoadMore == true { Button("Load more of my listings", action: more).disabled(feed?.loading == true) }
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
            HStack {
                Button("Cancel", action: cancel)
                Spacer()
                Button("Publish collection") {
                    var request: [String: Any] = ["type": "save_collection", "title": name, "listing_ids": selection]
                    if let original { request["identifier"] = original.identifier; request["previous_event_id"] = original.eventId }
                    submitting = true
                    failure = nil
                    publish(request) { success in
                        submitting = false
                        if success { cancel() }
                        else { failure = "Couldn’t save this collection. Your selections are still here." }
                    }
                }.buttonStyle(.borderedProminent).disabled(name.isEmpty || name.unicodeScalars.count > 160 || selection.isEmpty)
            }
        }.disabled(submitting)
    }
}
