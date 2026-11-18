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
    @State private var search = ""
    /// Threads matching the search by person name, thread title or message text.
    private var shownThreads: [InboxThread] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return threads }
        return threads.filter { thread in
            let name = store.snapshot.people[thread.conversation.id]?.name ?? thread.conversation.name
            return ([name, title(thread)] + thread.messages.map(\.text)).contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }
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
                PrivateMatchesLink().id(store.snapshot.publicKey)
                EscrowInboxCards()
                Picker("Group conversations", selection: $grouping) { Text("Threads").tag("threads"); Text("People").tag("people") }.pickerStyle(.segmented)
                if !store.snapshot.conversations.isEmpty {
                    HStack { Image(systemName: "magnifyingglass").foregroundStyle(MarketTheme.muted); TextField("Search people and messages", text: $search).textFieldStyle(.plain).accessibilityIdentifier("inboxSearch") }
                        .padding(12).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                if store.snapshot.conversations.isEmpty {
                    MarketEmptyState(symbol: "bubble.left.and.bubble.right", title: "No conversations", description: "Send a private enquiry from a listing or exchange an invitation.")
                    Button { showInvitation = true } label: { Text("Connect with an invitation") }.buttonStyle(PrimaryButton())
                } else {
                    VStack(spacing: 0) {
                        ForEach(shownThreads) { thread in
                            Button { selected = thread } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    if isPrivateMatch(thread.conversation.id) {
                                        PrivateMatchRow(title: thread.conversation.name, subtitle: thread.messages.last?.text ?? "No messages")
                                    } else {
                                    UserRow(person: store.snapshot.people[thread.conversation.id] ?? .unnamed(thread.conversation.id), subtitle: thread.messages.last?.text ?? "No messages", size: 48)
                                    }
                                    if grouping == "threads" && !isPrivateMatch(thread.conversation.id) { Text(title(thread)).font(.system(size: 12)).foregroundStyle(MarketTheme.muted).lineLimit(1).padding(.leading, 60) }
                                }.padding(.vertical, 17)
                            }.buttonStyle(.plain)
                            Divider().overlay(MarketTheme.line)
                        }
                    }
                }
            }.padding(23)
        }.foregroundStyle(MarketTheme.ink)
            .marketPage(isPresented: $showInvitation) { InvitationView().marketSheetScope() }
            .marketPage(item: $selected) { thread in ConversationView(conversation: thread.conversation, context: thread.context, threadKey: thread.key).id(store.snapshot.publicKey + "|" + thread.id).marketSheetScope() }
            .onAppear { store.refreshInbox(); openPushConversation() }
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

/// New chat, as in Iris Chat: share your invitation (QR, share, copy), or join with someone else's.
struct InvitationView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    var body: some View {
        MarketNavigationContainer {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(spacing: 14) {
                        Text("Invite someone").font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading)
                        Text("Let them scan this code, or send them the link. Your chat stays private.").font(.system(size: 14)).foregroundStyle(MarketTheme.muted).frame(maxWidth: .infinity, alignment: .leading)
                        if let invite = store.snapshot.invite, !invite.isEmpty {
                            MarketQRCode(text: invite, label: "Invitation QR code")
                            HStack(spacing: 12) {
                                ShareLink(item: invite) { Label("Share", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }.buttonStyle(PrimaryButton())
                                Button { MarketPlatform.copyToClipboard(invite) } label: { Label("Copy link", systemImage: "doc.on.doc").frame(maxWidth: .infinity) }.buttonStyle(PrimaryButton(dark: false))
                            }
                        } else if store.demo {
                            Text("Invitations are unavailable in preview mode.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted)
                        } else {
                            ProgressView("Preparing your invitation…").frame(maxWidth: .infinity).padding(.vertical, 30)
                        }
                    }
                    Rectangle().fill(MarketTheme.line).frame(height: 1)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Have an invitation?").font(.system(size: 17, weight: .semibold))
                        TextField("Paste invitation link", text: $input, prompt: Text("Paste invitation link").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(1...4).font(.system(size: 14)).marketNoAutocapitalization().autocorrectionDisabled().padding(12).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 12)).accessibilityIdentifier("inviteInput")
                        Button { store.command(["type": "accept_invite", "invite": input.trimmingCharacters(in: .whitespacesAndNewlines)]) { if $0 { dismiss() } } } label: { Text("Join chat").frame(maxWidth: .infinity) }.buttonStyle(PrimaryButton()).disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || store.demo)
                    }
                    MarketInlineError()
                }.padding(25)
            }.background(MarketTheme.paper).navigationTitle("New chat").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { MarketDoneButton { dismiss() } } }
                // An invitation is local until shared; prepare one as soon as the screen opens.
                .task { if !store.demo && (store.snapshot.invite ?? "").isEmpty { store.command(["type": "create_invite"]) } }
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
    private var current: MarketConversation { store.snapshot.conversations.first(where: { $0.id == conversation.id }) ?? MarketConversation(id:conversation.id, name:conversation.name, messages:[]) }
    private var person: MarketPerson { store.snapshot.people[current.id] ?? .unnamed(current.id) }
    /// Alias chats have no account behind them: no profile, timers, escrow or reactions.
    private var isMatch: Bool { isPrivateMatch(conversation.id) }
    private var visibleMessages: [MarketMessage] { threadKey == "*" ? current.messages : current.messages.filter { $0.threadKey == threadKey } }
    private var incomingIDs: [String] { visibleMessages.filter { !$0.mine && viewportIncoming.contains($0.id) }.map(\.id) }
    var body: some View {
        MarketNavigationContainer {
            VStack(spacing: 0) {
                #if os(macOS)
                HStack(spacing: 8) {
                    MarketPageBackButton()
                    if isMatch { PrivateMatchRow(title: current.name, subtitle: nil).accessibilityAddTraits(.isHeader) } else {
                    UserAvatar(person: person, size: 32)
                    UserName(person: person)
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(MarketTheme.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                #endif
                if isMatch {
                    PrivateMatchChatBanner(chatID: conversation.id).padding(.horizontal, 18).padding(.top, 8)
                }
                if let id = context?.orderId {
                    Button { orderID = id } label: { Text(inboxContextTitle(context, snapshot: store.snapshot)).font(.system(size: 14, weight: .medium)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12) }
                } else if context?.listing != nil { Text(inboxContextTitle(context, snapshot: store.snapshot)).font(.system(size: 13)).foregroundStyle(MarketTheme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12) }
                ScrollViewReader { proxy in
                    GeometryReader { viewport in
                    ScrollView {
                        LazyVStack(spacing: 13) {
                            if isMatch {
                                Label("Private match", systemImage: "lock.fill").font(.system(size: 11)).foregroundStyle(MarketTheme.muted).padding(.vertical, 15)
                            } else {
                            Label("Private conversation", systemImage: "lock.fill").font(.system(size: 11)).foregroundStyle(MarketTheme.muted).padding(.vertical, 15)
                            if !current.messages.isEmpty && current.messages.allSatisfy({$0.id.hasPrefix("notice-")}) {
                                Text("New chat messages use your Market profile.").font(.caption).foregroundStyle(MarketTheme.muted)
                            } else { ChatTimerControl(peer:conversation.id) }
                            }
                            if context?.orderId == nil && !isMatch {
                                EscrowInboxCards(peer: conversation.id, listing: context?.listing)
                            }
                            ForEach(visibleMessages) { message in
                                HStack {
                                    if message.mine { Spacer(minLength: 42) }
                                    VStack(alignment: .leading, spacing: 12) {
                                        if let payment = message.cashu {
                                            PaymentMessageView(payment: payment)
                                            if message.text != "Cashu payment" && !message.text.isEmpty { Text(message.text).font(.system(size: 15)).lineSpacing(3) }
                                        } else if message.mine || message.id.hasPrefix("notice-") {
                                            Text(message.text).font(.system(size: 16)).lineSpacing(3)
                                        } else {
                                            MarketTranslation(fields: [AttributedString(message.text)]) { Text($0[0]).font(.system(size: 16)).lineSpacing(3) }
                                        }
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
                #if os(macOS)
                .navigationBarBackButtonHidden(true)
                #else
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        if isMatch { PrivateMatchRow(title: current.name, subtitle: nil) } else { UserRow(person: person, size: 30) }
                    }
                    ToolbarItem(placement: .cancellationAction) { MarketDoneButton { dismiss() } }
                }
                #endif
                .marketPage(isPresented: Binding(get: { orderID != nil }, set: { if !$0 { orderID = nil } })) { if let orderID { OrderDetailView(orderID: orderID).marketSheetScope() } }
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
            if message.id.hasPrefix("notice-") { Text("Anonymous notice") } else if isMatch { EmptyView() } else {
            Button { reactionMessageID = message.id } label: { Image(systemName: "face.smiling") }
                .buttonStyle(.plain).accessibilityLabel("React to message").disabled(store.demo || store.busy)
                .popover(isPresented: Binding(get: { reactionMessageID == message.id }, set: { if !$0 { reactionMessageID = nil } })) {
                    HStack(spacing: 12) {
                        ForEach(NativeMessagePresentation.emoji, id: \.self) { emoji in
                            Button { react(message.id, emoji: emoji); reactionMessageID = nil } label: { Text(emoji).font(.title2) }.buttonStyle(.plain).accessibilityLabel("React " + emoji)
                        }
                    }.padding(20)
                }
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


/// An alias chat is labeled by its match, never by a person.
struct PrivateMatchRow: View {
    let title: String
    let subtitle: String?
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "theatermasks.fill").font(.system(size: subtitle == nil ? 15 : 20)).foregroundStyle(MarketTheme.onAction)
                .frame(width: subtitle == nil ? 30 : 48, height: subtitle == nil ? 30 : 48).background(MarketTheme.action, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                if let subtitle { Text(subtitle).font(.system(size: 14)).foregroundStyle(MarketTheme.muted).lineLimit(1) }
            }
        }.accessibilityElement(children: .combine)
    }
}
