import SwiftUI

struct PrivateMatchInbox: Decodable {
    struct Entry: Decodable, Identifiable {
        let id, side, summary, peer: String
        let expiresAt: Int64
    }
    struct Pair: Decodable { let entries: [String]; let votes: [Bool?]; let introduced: Bool }
    struct Interest: Decodable { let summary: String; let vote: Bool?; let contact: String? }
    struct Lead: Decodable { let title, listing: String }
    let sent, received: [String: Entry]
    let pairs: [String: Pair]
    let interests: [String: Interest]
    let publicLeads: [String: Lead]
}
struct PrivateMatchCandidate: Decodable, Identifiable {
    let id, kind, summary: String
}

struct PrivateMatchingSettings: View {
    @EnvironmentObject private var store: MarketStore
    var body: some View {
        Toggle("Find a match privately", isOn: Binding(get: { store.snapshot.privateMatching != nil }, set: {
            store.command(["type": "private_match", "action": ["op": "enable", "enabled": $0]])
        }))
        PrivateMatchesLink()
    }
}

struct PrivateMatchesLink: View {
    @EnvironmentObject private var store: MarketStore
    @State private var open = false
    var body: some View {
        if let inbox = store.snapshot.privateMatching {
            Button { open = true } label: { Label("Private matches", systemImage: "person.2.fill") }
                .sheet(isPresented: $open) {
                    PrivateMatchesView(startHelping: inbox.interests.isEmpty && !inbox.received.isEmpty)
                        .id(store.snapshot.publicKey)
                }
        }
    }
}

private struct PrivateMatchesView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var helping: Bool
    @State private var composing = false
    @State private var helper = ""
    @State private var summary = ""
    @State private var side = "request"
    @State private var selection = ""
    @State private var candidates: [PrivateMatchCandidate] = []
    @State private var searching = false

    init(startHelping: Bool) { _helping = State(initialValue: startHelping) }
    private func act(_ action: [String: Any], done: ((Bool) -> Void)? = nil) {
        store.command(["type": "private_match", "action": action], completion: done)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack { Text("Private matches").font(.title2); Spacer(); Button("Done") { dismiss() } }
                Picker("Private matches view", selection: $helping) {
                    Text("My matches").tag(false); Text("Helping").tag(true)
                }.pickerStyle(.segmented).labelsHidden()
                if let inbox = store.snapshot.privateMatching {
                    if helping { helperInbox(inbox) } else { myMatches(inbox) }
                }
                MarketInlineError()
            }.padding()
        }
    }
    @ViewBuilder private func myMatches(_ inbox: PrivateMatchInbox) -> some View {
        DisclosureGroup("Ask a helper", isExpanded: $composing) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Your helper may show this summary privately to someone with a possible match. Leave names and contact details out. It expires in seven days.").font(.callout)
                Picker("I’m", selection: $side) { Text("Looking for").tag("request"); Text("Offering").tag("offer") }
                if !store.snapshot.conversations.isEmpty {
                    Menu("Choose from your conversations") {
                        ForEach(store.snapshot.conversations) { conversation in
                            Button("\(conversation.name) · \(conversation.id.suffix(6))") { helper = conversation.id }
                        }
                    }
                }
                TextField("Helper’s npub or public key", text: $helper)
                TextField("Shareable summary", text: $summary)
                Button("Send to helper privately") {
                    act(["op":"share", "helper":helper.trimmingCharacters(in:.whitespacesAndNewlines), "side":side, "summary":summary]) {
                        if $0 { summary = ""; composing = false }
                    }
                }.disabled(helper.isEmpty || summary.isEmpty || store.busy)
            }
        }
        ForEach(inbox.interests.keys.sorted(), id: \.self) { id in
            if let interest = inbox.interests[id] {
                Divider()
                Text(interest.summary).font(.headline)
                if let contact = interest.contact {
                    Text("You have been introduced.")
                    Button("Open private chat") {
                        store.command(["type": "contact", "author": contact]) { ok in
                            if ok {
                                dismiss()
                                store.pushRoute = NativePushRoute(peerID: contact, threadID: nil, orderID: nil)
                            }
                        }
                    }
                }
                else if let vote = interest.vote { Text(vote ? "You agreed. Waiting for the introduction." : "You declined.") }
                else {
                    Text("If you both agree, your helper can share your Iris messaging identity with the other person.")
                    Button("Agree to introduction") { act(["op":"vote","proposal":id,"accept":true]) }
                    Button("Decline") { act(["op":"vote","proposal":id,"accept":false]) }
                }
            }
        }
        ForEach(inbox.publicLeads.keys.sorted(), id: \.self) { id in
            if let lead = inbox.publicLeads[id] {
                Divider(); Text(lead.title).font(.headline); Text("Public listing from your helper"); Text(lead.listing).textSelection(.enabled)
            }
        }
        ForEach(inbox.sent.keys.sorted(), id: \.self) { id in
            if let entry = inbox.sent[id] {
                Divider(); entryTitle(entry)
                Button("Withdraw") { act(["op":"withdraw", "entry":id]) }
            }
        }
        if inbox.sent.isEmpty && inbox.interests.isEmpty && inbox.publicLeads.isEmpty {
            Text("Your private offers, requests and replies will appear here.").foregroundStyle(.secondary)
        }
    }
    @ViewBuilder private func entryTitle(_ entry: PrivateMatchInbox.Entry) -> some View {
        Text(entry.summary).font(.headline)
        let date = Date(timeIntervalSince1970: Double(entry.expiresAt)).formatted(date: .abbreviated, time: .omitted)
        let name = store.snapshot.people[entry.peer]?.name ?? String(entry.peer.prefix(8))
        let person = helping ? "from" : "with"
        Text("\(entry.side == "offer" ? "Offer" : "Request") \(person) \(name) · Expires \(date)").font(.caption).foregroundStyle(.secondary)
    }
    @ViewBuilder private func helperInbox(_ inbox: PrivateMatchInbox) -> some View {
        ForEach(inbox.pairs.keys.sorted(), id: \.self) { id in
            if let pair = inbox.pairs[id] {
                Divider()
                Text(pair.entries.compactMap { inbox.received[$0]?.summary }.joined(separator:" · ")).font(.headline)
                if pair.introduced { Text("Introduction started") }
                else if pair.votes.contains(false) { Text("Declined") }
                else if pair.votes == [true, true] {
                    Text("Both agreed")
                    Button("Introduce privately") { act(["op":"introduce","proposal":id]) }
                } else { Text("Waiting for replies") }
            }
        }
        ForEach(inbox.received.keys.sorted(), id: \.self) { id in
            if let entry = inbox.received[id] {
                Divider(); entryTitle(entry)
                Button("Find matches") {
                    selection = id; candidates = []; searching = true
                    store.privateMatchCandidates(entry:id) { if selection == id { candidates = $0; searching = false } }
                }
                if selection == id && !searching {
                    let available = candidates.filter { candidate in
                        candidate.kind != "private" || !inbox.pairs.values.contains { $0.entries.contains(id) && $0.entries.contains(candidate.id) }
                    }
                    if available.isEmpty { Text("No new matches right now.").font(.caption) }
                    ForEach(available) { candidate in
                        Text(candidate.summary)
                        Button(candidate.kind == "private" ? "Ask both privately" : "Send public listing privately") {
                            if candidate.kind == "private" { act(["op":"suggest","left":id,"right":candidate.id]) }
                            else { act(["op":"send_public","entry":id,"listing":candidate.id]) }
                        }
                    }
                }
            }
        }
        if inbox.received.isEmpty { Text("Offers and requests shared with you will appear here.").foregroundStyle(.secondary) }
    }
}
