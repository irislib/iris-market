import SwiftUI

private struct InboxThread: Identifiable {
    let conversation: MarketConversation
    let key: String
    let context: MarketMessageContext?
    let messages: [MarketMessage]
    var id: String { conversation.id + "|" + key }
    var latestActivity: Int64 { messages.map(\.createdAt).max() ?? 0 }
}

/// Resolve only already available titles; opening the inbox never fetches a listing.
private func inboxContextTitle(_ context: MarketMessageContext?, snapshot: MarketSnapshot) -> String {
    if let id = context?.orderId {
        let title = snapshot.orders.first(where: { $0.id == id })?.items.map(\.title).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: ", ") ?? ""
        return title.isEmpty ? "Order" : "Order · " + title
    }
    guard let address = context?.listing else { return "Conversation" }
    let coordinate = address.hasPrefix("30402:") ? String(address.dropFirst(6)) : address
    let listings = snapshot.listings + (snapshot.savedListings ?? []) + (snapshot.profileListings?.listings ?? [])
    let title = listings.first(where: { $0.id == coordinate })?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return title.isEmpty ? "Listing inquiry" : title
}

struct InboxView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var showInvitation = false
    @State private var selected: InboxThread?
    @AppStorage("market.messageGrouping") private var grouping = "threads"
    private var threads: [InboxThread] {
        store.snapshot.conversations.flatMap { conversation -> [InboxThread] in
            if grouping == "people" { return [InboxThread(conversation: conversation, key: "*", context: nil, messages: conversation.messages)] }
            let groups = Dictionary(grouping: conversation.messages, by: \.threadKey)
            if groups.isEmpty { return [InboxThread(conversation: conversation, key: "general", context: nil, messages: [])] }
            return groups.map { key, messages in
                InboxThread(conversation: conversation, key: key, context: messages.first?.context ?? messages.first?.orderId.map(MarketMessageContext.order), messages: messages)
            }.sorted { $0.latestActivity == $1.latestActivity ? $0.id < $1.id : $0.latestActivity > $1.latestActivity }
        }.sorted { $0.latestActivity == $1.latestActivity ? $0.id < $1.id : $0.latestActivity > $1.latestActivity }
    }
    private func title(_ thread: InboxThread) -> String { inboxContextTitle(thread.context, snapshot: store.snapshot) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                HStack(alignment: .firstTextBaseline) { Text("Inbox").font(.system(size: 30, weight: .medium)).tracking(-1); Spacer(); Button { showInvitation = true } label: { Image(systemName: "square.and.pencil").font(.system(size: 20)) }.accessibilityLabel("Connect with an invitation") }
                Picker("Group conversations", selection: $grouping) { Text("Threads").tag("threads"); Text("People").tag("people") }.pickerStyle(.segmented)
                if store.snapshot.conversations.isEmpty {
                    MarketEmptyState(symbol: "bubble.left.and.bubble.right", title: "No conversations", description: "Send a private enquiry from a listing or exchange an invitation.")
                    Button { showInvitation = true } label: { Text("Connect with an invitation") }.buttonStyle(PrimaryButton())
                } else {
                    VStack(spacing: 0) {
                        ForEach(threads) { thread in
                            Button { selected = thread } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    UserRow(person: store.snapshot.people[thread.conversation.id] ?? .unnamed(thread.conversation.id), subtitle: thread.messages.last?.text ?? "No messages", size: 48)
                                    if grouping == "threads" { Text(title(thread)).font(.system(size: 12)).foregroundStyle(MarketTheme.muted).lineLimit(1).padding(.leading, 60) }
                                }.padding(.vertical, 17)
                            }.buttonStyle(.plain)
                            Divider().overlay(MarketTheme.line)
                        }
                    }
                }
            }.padding(23)
        }.foregroundStyle(MarketTheme.ink)
            .sheet(isPresented: $showInvitation) { InvitationView().marketSheetScope() }
            .sheet(item: $selected) { thread in ConversationView(conversation: thread.conversation, context: thread.context, threadKey: thread.key).id(store.snapshot.publicKey + "|" + thread.id).marketSheetScope() }
            .onAppear { openPushConversation() }
            .onChange(of: store.pushRoute) { _ in openPushConversation() }
            .onChange(of: store.snapshot.revision) { _ in openPushConversation() }
            .onChange(of: store.activeSheetCount) { _ in openPushConversation() }
            .onChange(of: scenePhase) { _ in openPushConversation() }
            .onChange(of: store.snapshot.publicKey) { _ in selected = nil }
    }
    private func openPushConversation() {
        guard scenePhase == .active, store.ready, !store.demo, let route = store.pushRoute, route.orderID == nil,
              store.activeSheetCount == 0 || selected != nil,
              let conversation = store.snapshot.conversations.first(where: { $0.id == route.peerID }) else { return }
        let key = route.threadID.map { "thread:" + $0 } ?? "general"
        let context = conversation.messages.first(where: { $0.threadKey == key })?.context ?? route.threadID.map { MarketMessageContext(threadId: $0) }
        selected = InboxThread(conversation: conversation, key: key, context: context, messages: conversation.messages.filter { $0.threadKey == key })
        store.consumePushRoute()
    }
}

struct InvitationView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("Exchange a private invitation with the person you want to talk to.").font(.system(size: 15)).lineSpacing(4).foregroundStyle(MarketTheme.muted)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Accept invitation").font(.system(size: 15, weight: .semibold))
                        TextField("Paste invitation", text: $input, prompt: Text("Paste invitation").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(2...5).font(.system(size: 13)).marketNoAutocapitalization().autocorrectionDisabled().padding(15).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 15)).accessibilityIdentifier("inviteInput")
                        Button { store.command(["type": "accept_invite", "invite": input]) { if $0 { dismiss() } } } label: { Text("Accept invitation") }.buttonStyle(PrimaryButton()).disabled(input.isEmpty || store.busy || store.demo)
                    }
                    Rectangle().fill(MarketTheme.line).frame(height: 1)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Share invitation").font(.system(size: 15, weight: .semibold))
                        if let invite = store.snapshot.invite, !invite.isEmpty {
                            ShareLink(item: invite) { Label("Share invitation", systemImage: "square.and.arrow.up") }.buttonStyle(PrimaryButton(dark: false))
                            Button { MarketPlatform.copyToClipboard(invite) } label: { Label("Copy invitation", systemImage: "doc.on.doc") }.font(.system(size: 13)).frame(maxWidth: .infinity)
                        } else {
                            Button { store.command(["type": "create_invite"]) } label: { Label("Create invitation", systemImage: "plus") }.buttonStyle(PrimaryButton(dark: false)).disabled(store.busy || store.demo)
                        }
                    }
                    MarketInlineError()
                    if store.demo { Text("Invitations are unavailable in preview mode.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
                }.padding(25)
            }.background(MarketTheme.paper).navigationTitle("Private invitation").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct MessageFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, next in next }) }
}

struct ConversationView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let conversation: MarketConversation
    @Environment(\.scenePhase) private var scenePhase
    @State private var appeared = false
    @State private var foreground = false
    @State private var displayedAccount = ""
    @Environment(\.marketSheetID) private var sheetID
    @State private var viewportIncoming = Set<String>()
    @State private var reactionMessageID: String?
    @State private var markedIDs = Set<String>()
    @State private var markingRead = false
    var context: MarketMessageContext? = nil
    var threadKey = "*"
    private var draftKey: NativeMessageDrafts.Key {
        .init(account: displayedAccount, peer: conversation.id, context: context?.key ?? threadKey)
    }
    private var text: Binding<String> {
        Binding(get: { store.messageDrafts[draftKey] }, set: { value in
            guard displayedAccount == store.snapshot.publicKey else { return }
            store.messageDrafts[draftKey] = value
        })
    }
    @State private var orderID: String?
    private var current: MarketConversation { store.snapshot.conversations.first(where: { $0.id == conversation.id }) ?? conversation }
    private var visibleMessages: [MarketMessage] { threadKey == "*" ? current.messages : current.messages.filter { $0.threadKey == threadKey } }
    private var incomingIDs: [String] { visibleMessages.filter { !$0.mine && viewportIncoming.contains($0.id) }.map(\.id) }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let id = context?.orderId {
                    Button { orderID = id } label: { Text(inboxContextTitle(context, snapshot: store.snapshot)).font(.system(size: 14, weight: .medium)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12) }
                } else if context?.listing != nil { Text(inboxContextTitle(context, snapshot: store.snapshot)).font(.system(size: 13)).foregroundStyle(MarketTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12) }
                ScrollViewReader { proxy in
                    GeometryReader { viewport in
                    ScrollView {
                        LazyVStack(spacing: 13) {
                            Label("Private conversation", systemImage: "lock.fill").font(.system(size: 11)).foregroundStyle(MarketTheme.muted).padding(.vertical, 15)
                            ForEach(visibleMessages) { message in
                                HStack {
                                    if message.mine { Spacer(minLength: 42) }
                                    VStack(alignment: .leading, spacing: 12) {
                                        if let payment = message.cashu {
                                            PaymentMessageView(payment: payment)
                                            if message.text != "Cashu payment" && !message.text.isEmpty { Text(message.text).font(.system(size: 15)).lineSpacing(3) }
                                        } else { Text(message.text).font(.system(size: 16)).lineSpacing(3) }
                                        if let id = message.orderId { Button("View order") { orderID = id }.font(.system(size: 13, weight: .semibold)) }
                                        messageFooter(message)
                                        if !(message.reactions ?? []).isEmpty {
                                            HStack(spacing: 6) {
                                                ForEach(message.reactions ?? [], id: \.emoji) { reaction in
                                                    Button { react(message.id, emoji: reaction.emoji) } label: { Text(reaction.emoji + " " + String(reaction.count)).font(.system(size: 12)) }
                                                        .buttonStyle(.bordered).disabled(store.busy || store.demo).tint(reaction.reactedByMe ? MarketTheme.green : MarketTheme.muted)
                                                        .accessibilityLabel(reaction.emoji + ", " + String(reaction.count) + " reactions")
                                                        .accessibilityValue(reaction.reactedByMe ? "Selected. Tap to remove your reaction." : "Tap to react.")
                                                }
                                            }
                                        }
                                    }.padding(.horizontal, 16).padding(.vertical, 13)
                                        .foregroundStyle(MarketTheme.ink).background(message.mine ? MarketTheme.mint : MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                                    if !message.mine { Spacer(minLength: 42) }
                                }.id(message.id)
                                    .background { GeometryReader { row in Color.clear.preference(key: MessageFramesKey.self, value: [message.id: row.frame(in: .named("messageViewport"))]) } }
                            }
                        }.padding(.horizontal, 21).padding(.bottom, 16)
                    }.coordinateSpace(name: "messageViewport")
                        .onPreferenceChange(MessageFramesKey.self) { frames in
                            viewportIncoming = NativeMessagePresentation.visibleIncoming(frames: frames, viewport: viewport.size, incoming: Set(visibleMessages.filter { !$0.mine }.map(\.id)))
                        }
                        .onChange(of: visibleMessages.count) { _ in if let last = visibleMessages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
                    }
                }
                MarketInlineError().padding(.horizontal, 18)
                HStack(spacing: 10) {
                    TextField("Write a message…", text: text, prompt: Text("Write a message…").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(1...5).padding(14).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20)).accessibilityIdentifier("messageInput")
                    Button { send() } label: { Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold)).foregroundStyle(MarketTheme.onAction).frame(width: 44, height: 44).background(MarketTheme.action, in: Circle()) }.disabled(text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || store.demo).accessibilityLabel("Send message")
                }.padding(16)
            }.background(MarketTheme.paper).navigationTitle("").marketInlineTitle()
                .toolbar {
                    ToolbarItem(placement: .principal) { UserRow(person: store.snapshot.people[current.id] ?? .unnamed(current.id), size: 30) }
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                }
                .sheet(isPresented: Binding(get: { orderID != nil }, set: { if !$0 { orderID = nil } })) { if let orderID { OrderDetailView(orderID: orderID).marketSheetScope() } }
                .onAppear { displayedAccount = store.snapshot.publicKey; appeared = true; foreground = scenePhase == .active; updateVisibleReadState() }
                .onDisappear { appeared = false; foreground = false; clearActiveContext() }
                .onChange(of: store.activeSheetID) { _ in updateVisibleReadState() }
                .onChange(of: store.profileSetupRequested) { _ in updateVisibleReadState() }
                .onChange(of: incomingIDs) { _ in updateVisibleReadState() }
                .onChange(of: scenePhase) { value in foreground = value == .active; updateVisibleReadState() }
                .onChange(of: reactionMessageID) { _ in updateVisibleReadState() }
                .onChange(of: orderID) { _ in updateVisibleReadState() }
                .onChange(of: store.snapshot.publicKey) { _ in appeared = false; clearActiveContext(); dismiss() }
        }
    }
    private var foregroundVisible: Bool {
        appeared && foreground && orderID == nil && reactionMessageID == nil && !store.profileSetupRequested && (sheetID == nil ? store.activeSheetCount == 0 : store.activeSheetID == sheetID) && !store.demo && store.ready && !displayedAccount.isEmpty && displayedAccount == store.snapshot.publicKey && store.snapshot.conversations.contains(where: { $0.id == conversation.id })
    }
    private func react(_ id: String, emoji: String) {
        guard appeared, foreground, orderID == nil, !store.profileSetupRequested, (sheetID == nil ? store.activeSheetCount == 0 : store.activeSheetID == sheetID), !store.demo, displayedAccount == store.snapshot.publicKey else { return }
        store.command(["type": "toggle_reaction", "peer_id": conversation.id, "message_id": id, "emoji": emoji])
    }
    private func messageFooter(_ message: MarketMessage) -> some View {
        HStack(spacing: 6) {
            if message.createdAt > 0 { Text(Date(timeIntervalSince1970: Double(message.createdAt)), style: .time) }
            if message.mine { Text(NativeMessagePresentation.delivery(message.delivery)) }
            Spacer(minLength: 4)
            Button { reactionMessageID = message.id } label: { Image(systemName: "face.smiling") }
                .buttonStyle(.plain).accessibilityLabel("React to message").disabled(store.demo || store.busy)
                .popover(isPresented: Binding(get: { reactionMessageID == message.id }, set: { if !$0 { reactionMessageID = nil } })) {
                    HStack(spacing: 12) {
                        ForEach(NativeMessagePresentation.emoji, id: \.self) { emoji in
                            Button { react(message.id, emoji: emoji); reactionMessageID = nil } label: { Text(emoji).font(.title2) }.buttonStyle(.plain).accessibilityLabel("React " + emoji)
                        }
                    }.padding(20)
                }
        }.font(.system(size: 10)).foregroundStyle(MarketTheme.muted)
    }
    private func clearActiveContext() {
        if store.activePushPeerID == conversation.id && store.activePushThreadID == threadKey { store.setActivePushContext(peerID: nil, threadID: nil) }
    }
    private func updateVisibleReadState() {
        guard foregroundVisible else { clearActiveContext(); return }
        store.setActivePushContext(peerID: conversation.id, threadID: threadKey)
        guard !markingRead else { return }
        let batch = Array(incomingIDs.filter { !markedIDs.contains($0) }.prefix(256))
        guard !batch.isEmpty else { return }
        let account = displayedAccount
        markingRead = true; markedIDs.formUnion(batch)
        store.command(["type": "mark_messages_read", "message_ids": batch]) { success in
            markingRead = false
            guard account == store.snapshot.publicKey else { return }
            if success { updateVisibleReadState() } else { markedIDs.subtract(batch) }
        }
    }
    private func send() {
        let pending = text.wrappedValue
        let key = draftKey
        guard !key.account.isEmpty, key.account == store.snapshot.publicKey else { return }
        var request: [String: Any] = ["type": "send_message", "peer_id": conversation.id, "text": pending]
        if let context, let value = try? MarketJSON.object(context) { request["context"] = value }
        store.command(request) { store.messageDrafts.sent(pending, for: key, success: $0) }
    }
}
