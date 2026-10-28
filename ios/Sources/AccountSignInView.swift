import SwiftUI

struct AccountSignInView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State private var secret = ""
    @State private var initialOwner = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let invitation = store.deviceLinkURL {
                        Image(systemName: "iphone.and.arrow.forward").font(.system(size: 38)).foregroundStyle(MarketTheme.green).frame(maxWidth: .infinity).padding(.vertical, 20)
                        Text("Open this link on a device signed in to Iris Chat.").foregroundStyle(MarketTheme.muted)
                        ShareLink(item: invitation) { Label("Share link", systemImage: "square.and.arrow.up") }.buttonStyle(PrimaryButton())
                        Button { MarketPlatform.copyToClipboard(invitation) } label: { Label("Copy link", systemImage: "doc.on.doc") }.frame(maxWidth: .infinity)
                        ProgressView("Waiting for approval…").frame(maxWidth: .infinity)
                    } else {
                        Button { store.beginDeviceLink() } label: { Label("Link this device", systemImage: "link") }.buttonStyle(PrimaryButton()).disabled(store.busy || store.demo)
                        Text("Or sign in with your secret key").font(.subheadline).foregroundStyle(MarketTheme.muted)
                        SecureField("Secret key", text: $secret).marketNoAutocapitalization().autocorrectionDisabled().textContentType(.password).padding(16).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 16)).accessibilityIdentifier("accountSecret")
                        Button { store.signIn(secret: secret.trimmingCharacters(in: .whitespacesAndNewlines)) { success in if success { secret = ""; dismiss() } } } label: {
                            if store.busy { ProgressView() } else { Text("Sign in") }
                        }.buttonStyle(PrimaryButton(dark: false)).disabled(secret.isEmpty || store.busy || store.demo)
                    }
                    MarketInlineError()
                }.padding(24)
            }.background(MarketTheme.paper).navigationTitle("Sign in").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { store.closeDeviceLink(); dismiss() } } }
                .onAppear { initialOwner = store.snapshot.publicKey }
                .onChange(of: store.snapshot.publicKey) { owner in if !initialOwner.isEmpty && owner != initialOwner { dismiss() } }
                .task(id: store.deviceLinkURL) {
                    while store.deviceLinkURL != nil && !Task.isCancelled {
                        store.pollDeviceLink()
                        try? await Task.sleep(nanoseconds: 4_000_000_000)
                    }
                }
        }
    }
}
