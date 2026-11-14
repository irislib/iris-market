import SwiftUI

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
                TextField("Helper’s profile ID (npub…)", text: $helper)
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
                Text("Possible match from your helper").font(.caption).foregroundStyle(.secondary)
                Text(interest.summary).font(.headline)
                if let chat = interest.chat {
                    Text(interest.connected == true ? "Introduced. You can chat privately." : "Introduced. Connecting privately…")
                    Button {
                        // The alias chat already exists locally; it never contacts an account.
                        dismiss()
                        store.pushRoute = NativePushRoute(peerID: chat, threadID: nil, orderID: nil)
                    } label: { Label("Open private chat", systemImage: "bubble.left.fill") }
                }
                else if let contact = interest.contact {
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
                else if let vote = interest.vote { Text(vote ? "You agreed. Waiting for the other person and your helper." : "You declined.") }
                else {
                    Text("If you both agree, you’ll chat as private aliases. Your profile stays hidden unless you choose to share it.")
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
        Text(helping ? "\(entry.side == "offer" ? "Offer" : "Request") from \(name) · Until \(date)"
             : "Your \(entry.side == "offer" ? "offer" : "request") · Helper: \(name) · Until \(date)").font(.caption).foregroundStyle(.secondary)
    }
    @ViewBuilder private func helperInbox(_ inbox: PrivateMatchInbox) -> some View {
        ForEach(inbox.pairs.keys.sorted(), id: \.self) { id in
            if let pair = inbox.pairs[id] {
                Divider()
                Text(pair.entries.compactMap { inbox.received[$0]?.summary }.joined(separator:" · ")).font(.headline)
                if pair.introduced { Text("Introduced. They now chat privately, and you can’t see their messages.") }
                else if pair.votes.contains(false) { Text("One person declined.") }
                else if pair.votes == [true, true] {
                    Text("Both agreed. Introducing them shares a private alias for each, not their profiles.")
                    Button("Introduce privately") { act(["op":"introduce","proposal":id]) }
                } else { Text(pair.votes.contains(true) ? "One person agreed. Waiting for the other." : "Waiting for both to reply.") }
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

/// Shown at the top of an alias chat: who sees what, and an explicit, confirmed profile share.
struct PrivateMatchChatBanner: View {
    @EnvironmentObject private var store: MarketStore
    let chatID: String
    @State private var confirming = false
    @State private var profile: String?
    private var proposal: String { String(chatID.dropFirst("match:".count)) }
    private var interest: PrivateMatchInbox.Interest? { store.snapshot.privateMatching?.interests[proposal] }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(interest?.sharedProfile == true ? "You shared your profile in this chat." : "You appear as a private alias. They can’t see your profile.",
                  systemImage: "theatermasks.fill").font(.system(size: 13)).foregroundStyle(MarketTheme.muted)
            if let key = interest?.revealed {
                HStack(spacing: 8) {
                    Label("They shared their profile: \(store.snapshot.people[key]?.name ?? String(key.prefix(8)))", systemImage: "person.crop.circle.fill").font(.system(size: 13))
                    Button("View profile") { profile = key }.font(.system(size: 13, weight: .semibold))
                }
            }
            if interest?.sharedProfile != true && interest?.connected == true {
                Button("Share my profile…") { confirming = true }.font(.system(size: 13, weight: .semibold)).disabled(store.busy || store.demo)
                    .accessibilityIdentifier("shareMatchProfile")
            }
            if interest?.connected != true { Text("Connecting privately. You can write as soon as you’re connected.").font(.caption).foregroundStyle(MarketTheme.muted) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .confirmationDialog("Share your profile?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Share profile") { store.command(["type": "private_match", "action": ["op": "reveal", "proposal": proposal]]) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("They’ll see your name, profile and public listings, and can find you outside this chat. This can’t be undone.") }
        .marketPage(item: Binding(get: { profile.map(RevealedProfile.init) }, set: { profile = $0?.id })) { AuthorProfileView(author: $0.id).marketSheetScope() }
    }
}
private struct RevealedProfile: Identifiable { let id: String }
