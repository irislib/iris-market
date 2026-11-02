import SwiftUI

struct PrivateMatchInbox: Decodable {
    struct Entry: Decodable, Identifiable {
        let id, side, summary: String
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
    @State private var open = false
    @State private var helper = "", summary = "", side = "request"
    @State private var selection = ""
    @State private var candidates: [PrivateMatchCandidate] = []
    private func act(_ action: [String: Any], done: ((Bool) -> Void)? = nil) {
        store.command(["type": "private_match", "action": action], completion: done)
    }
    var body: some View {
        Toggle("Find a match privately", isOn: Binding(get: { store.snapshot.privateMatching != nil }, set: {
            act(["op": "enable", "enabled": $0])
        }))
        if store.snapshot.privateMatching != nil {
            Button("Open private matching") { open = true }
                .sheet(isPresented: $open) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            HStack { Text("Private matching").font(.title2); Spacer(); Button("Done") { open = false } }
                            Text("A helper you choose can look for matches for up to seven days.")
                            Picker("I’m", selection: $side) {
                                Text("Looking for").tag("request"); Text("Offering").tag("offer")
                            }
                            TextField("Helper’s npub or public key", text: $helper)
                            TextField("Summary your helper may share", text: $summary)
                            Button("Send to helper privately") {
                                act(["op":"share", "helper":helper.trimmingCharacters(in:.whitespacesAndNewlines), "side":side, "summary":summary]) { if $0 { summary = "" } }
                            }.disabled(helper.isEmpty || summary.isEmpty || store.busy)
                            if let inbox = store.snapshot.privateMatching { entries(inbox); proposals(inbox) }
                        }.padding()
                    }
                    .onDisappear { helper = ""; summary = ""; candidates = []; selection = "" }
                }
        }
    }
    @ViewBuilder private func entries(_ inbox: PrivateMatchInbox) -> some View {
        ForEach(inbox.sent.keys.sorted(), id: \.self) { id in
            if let row = inbox.sent[id] {
                Text(row.summary)
                Button("Withdraw") { act(["op":"withdraw", "entry":id]) }
            }
        }
        ForEach(inbox.received.keys.sorted(), id: \.self) { id in
            if let row = inbox.received[id] {
                Text(row.summary)
                Button("Find matches") {
                    selection = id; candidates = []
                    store.privateMatchCandidates(entry:id) { if selection == id { candidates = $0 } }
                }
                if selection == id {
                    ForEach(candidates) { candidate in
                        Text(candidate.summary)
                        Button(candidate.kind == "private" ? "Ask both privately" : "Send public listing privately") {
                            if candidate.kind == "private" { act(["op":"suggest","left":id,"right":candidate.id]) }
                            else { act(["op":"send_public","entry":id,"listing":candidate.id]) }
                        }
                    }
                }
            }
        }
    }
    @ViewBuilder private func proposals(_ inbox: PrivateMatchInbox) -> some View {
        ForEach(inbox.interests.keys.sorted(), id: \.self) { id in
            if let interest = inbox.interests[id] {
                Text(interest.summary)
                if let contact = interest.contact { Text(contact).textSelection(.enabled) }
                else if interest.vote == nil {
                    Button("Agree to an introduction") { act(["op":"vote","proposal":id,"accept":true]) }
                    Button("Decline") { act(["op":"vote","proposal":id,"accept":false]) }
                }
            }
        }
        ForEach(inbox.pairs.keys.sorted(), id: \.self) { id in
            if let pair = inbox.pairs[id], pair.votes == [true,true], !pair.introduced {
                Text(pair.entries.compactMap { inbox.received[$0]?.summary }.joined(separator:" · "))
                Button("Introduce privately") { act(["op":"introduce","proposal":id]) }
            }
        }
        ForEach(inbox.publicLeads.keys.sorted(), id: \.self) { id in
            if let lead = inbox.publicLeads[id] { Text(lead.title); Text(lead.listing).textSelection(.enabled) }
        }
    }
}
