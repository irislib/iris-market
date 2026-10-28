import SwiftUI
import UIKit

struct InboxView: View {
    @EnvironmentObject private var store: MarketStore
    @State private var showInvitation = false
    @State private var selected: MarketConversation?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 23) {
                HStack(alignment: .firstTextBaseline) { Text("Inbox").font(.system(size: 30, weight: .medium, design: .serif)).tracking(-1); Spacer(); Button { showInvitation = true } label: { Image(systemName: "square.and.pencil").font(.system(size: 20)) }.accessibilityLabel("Connect with an invitation") }
                if store.snapshot.conversations.isEmpty {
                    MarketEmptyState(symbol: "bubble.left.and.bubble.right", title: "No conversations", description: "Send a private enquiry from a listing or exchange an invitation.")
                    Button { showInvitation = true } label: { Text("Connect with an invitation") }.buttonStyle(PrimaryButton())
                } else {
                    VStack(spacing: 0) {
                        ForEach(store.snapshot.conversations) { conversation in
                            Button { selected = conversation } label: {
                                HStack(spacing: 13) {
                                    Text(String(conversation.name.prefix(1)).uppercased()).font(.system(size: 22, weight: .medium, design: .serif)).frame(width: 53, height: 53).background(MarketTheme.mint.opacity(0.65), in: RoundedRectangle(cornerRadius: 19))
                                    VStack(alignment: .leading, spacing: 5) { Text(conversation.name).font(.system(size: 16, weight: .semibold)); Text(conversation.messages.last?.text ?? "No messages").font(.system(size: 13)).foregroundStyle(MarketTheme.muted).lineLimit(1) }
                                    Spacer(); Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(MarketTheme.muted)
                                }.foregroundStyle(MarketTheme.ink).padding(.vertical, 17)
                            }.buttonStyle(.plain)
                            Divider().overlay(MarketTheme.line)
                        }
                    }
                }
                Label("Private messages are never public listings.", systemImage: "lock.fill").font(.system(size: 11)).foregroundStyle(MarketTheme.muted).frame(maxWidth: .infinity).padding(.top, 8)
            }.padding(23)
        }.foregroundStyle(MarketTheme.ink)
            .sheet(isPresented: $showInvitation) { InvitationView().marketSheetScope() }
            .sheet(item: $selected) { conversation in ConversationView(conversation: conversation).marketSheetScope() }
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
                        TextField("Paste invitation", text: $input, prompt: Text("Paste invitation").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(2...5).font(.system(size: 13)).textInputAutocapitalization(.never).autocorrectionDisabled().padding(15).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 15)).accessibilityIdentifier("inviteInput")
                        Button { store.command(["type": "accept_invite", "invite": input]) { if $0 { dismiss() } } } label: { Text("Accept invitation") }.buttonStyle(PrimaryButton()).disabled(input.isEmpty || store.busy || store.demo)
                    }
                    Rectangle().fill(MarketTheme.line).frame(height: 1)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Share invitation").font(.system(size: 15, weight: .semibold))
                        if let invite = store.snapshot.invite, !invite.isEmpty {
                            ShareLink(item: invite) { Label("Share invitation", systemImage: "square.and.arrow.up") }.buttonStyle(PrimaryButton(dark: false))
                            Button { UIPasteboard.general.string = invite } label: { Label("Copy invitation", systemImage: "doc.on.doc") }.font(.system(size: 13)).frame(maxWidth: .infinity)
                        } else {
                            Button { store.command(["type": "create_invite"]) } label: { Label("Create invitation", systemImage: "plus") }.buttonStyle(PrimaryButton(dark: false)).disabled(store.busy || store.demo)
                        }
                    }
                    MarketInlineError()
                    if store.demo { Text("Invitations are unavailable in preview mode.").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
                }.padding(25)
            }.background(MarketTheme.paper).navigationTitle("Private invitation").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}

struct ConversationView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    let conversation: MarketConversation
    @State private var text = ""
    private var current: MarketConversation { store.snapshot.conversations.first(where: { $0.id == conversation.id }) ?? conversation }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 13) {
                            Label("Private conversation", systemImage: "lock.fill").font(.system(size: 11)).foregroundStyle(MarketTheme.muted).padding(.vertical, 15)
                            ForEach(current.messages) { message in
                                HStack {
                                    if message.mine { Spacer(minLength: 42) }
                                    Text(message.text).font(.system(size: 16)).lineSpacing(3).padding(.horizontal, 16).padding(.vertical, 13)
                                        .foregroundStyle(MarketTheme.ink).background(message.mine ? MarketTheme.mint : MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                                    if !message.mine { Spacer(minLength: 42) }
                                }.id(message.id)
                            }
                        }.padding(.horizontal, 21).padding(.bottom, 16)
                    }.onChange(of: current.messages.count) { _ in if let last = current.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
                }
                MarketInlineError().padding(.horizontal, 18)
                HStack(spacing: 10) {
                    TextField("Write a message…", text: $text, prompt: Text("Write a message…").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(1...5).padding(14).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 20)).accessibilityIdentifier("messageInput")
                    Button { send() } label: { Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold)).foregroundStyle(MarketTheme.onAction).frame(width: 44, height: 44).background(MarketTheme.action, in: Circle()) }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy || store.demo).accessibilityLabel("Send message")
                }.padding(16)
            }.background(MarketTheme.paper).navigationTitle(current.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("Done") { dismiss() } } }
        }
    }
    private func send() { let pending = text; store.command(["type": "send_message", "peer_id": conversation.id, "text": pending]) { if $0 { text = "" } } }
}
