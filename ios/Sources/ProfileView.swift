import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var store: MarketStore
    @AppStorage("market.appearance") private var appearance = "system"
    @State private var aiSettings = false
    @State private var signIn = false
    @State private var publicProfile = false
    @State private var connectionSettings = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 25) {
                Text("Account").font(.system(size: 30, weight: .medium, design: .serif)).tracking(-1).foregroundStyle(MarketTheme.ink)
                VStack(spacing: 0) {
                    profileRow("Sign in", symbol: "person.crop.circle.badge.checkmark") { signIn = true }.disabled(store.demo)
                    Divider().padding(.leading, 61)
                    profileRow("Public profile", symbol: "person.crop.circle.fill") { publicProfile = true }
                    Divider().padding(.leading, 61)
                    profileRow("AI settings", subtitle: store.snapshot.settings.ai.enabled ? "Enabled" : "Disabled", symbol: "sparkles") { aiSettings = true }.accessibilityIdentifier("aiSettingsRow")
                    Divider().padding(.leading, 61)
                    profileRow("Connections & account", symbol: "point.3.connected.trianglepath.dotted") { connectionSettings = true }
                }.background(MarketTheme.surface.opacity(0.75), in: RoundedRectangle(cornerRadius: 23))
                VStack(alignment: .leading, spacing: 14) {
                    Label("Appearance", systemImage: "circle.lefthalf.filled").font(.system(size: 14, weight: .semibold)).foregroundStyle(MarketTheme.ink)
                    Picker("Appearance", selection: $appearance) {
                        ForEach(MarketAppearance.allCases, id: \.rawValue) { option in Text(option.label).tag(option.rawValue) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("appearancePicker")
                }.padding(20).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 23))
                if store.demo { Label("Preview mode uses sample listings and stays offline.", systemImage: "eye").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
            }.padding(23)
        }.sheet(isPresented: $signIn) { AccountSignInView().marketSheetScope() }
            .sheet(isPresented: $aiSettings) { AISettingsView(settings: store.snapshot.settings).marketSheetScope() }
            .sheet(isPresented: $publicProfile) { AuthorProfileView(author: store.snapshot.publicKey).marketSheetScope() }
            .sheet(isPresented: $connectionSettings) { ConnectionSettingsView(settings: store.snapshot.settings).marketSheetScope() }
    }
    private func profileRow(_ title: String, subtitle: String? = nil, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 13) {
                Image(systemName: symbol).font(.system(size: 20)).foregroundStyle(MarketTheme.green).frame(width: 31)
                VStack(alignment: .leading, spacing: 5) { Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(MarketTheme.ink); if let subtitle { Text(subtitle).font(.system(size: 11)).foregroundStyle(MarketTheme.muted) } }
                Spacer(); Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).foregroundStyle(MarketTheme.muted)
            }.padding(.horizontal, 18).padding(.vertical, 22).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct AISettingsView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State var settings: MarketSettings
    @State private var apiKey = ""
    @State private var saved = false
    @FocusState private var modelFocused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Enable AI", isOn: $settings.ai.enabled).accessibilityIdentifier("enableAI")
                } footer: { Text("When you use AI, selected public listing text and your interests are sent to the provider below. Private conversations are never sent. Your API key stays in this device’s secure storage.") }
                Section("Provider") {
                    Picker("Provider", selection: $settings.ai.provider) { Text("OpenAI compatible").tag("compatible"); Text("Ollama").tag("ollama"); Text("Anthropic").tag("anthropic") }.accessibilityIdentifier("aiProvider")
                    TextField("Endpoint URL", text: $settings.ai.baseUrl, prompt: Text("Endpoint URL").foregroundColor(MarketTheme.muted)).marketNoAutocapitalization().autocorrectionDisabled().marketURLKeyboard().accessibilityIdentifier("aiEndpoint")
                    TextField("Model name", text: $settings.ai.model, prompt: Text("Model name").foregroundColor(MarketTheme.muted)).focused($modelFocused).submitLabel(.done).onSubmit { modelFocused = false }.marketNoAutocapitalization().autocorrectionDisabled().accessibilityIdentifier("aiModel")
                    SecureField("API key (if required)", text: $apiKey, prompt: Text("API key (if required)").foregroundColor(MarketTheme.muted)).marketNoAutocapitalization().autocorrectionDisabled().accessibilityIdentifier("aiAPIKey")
                }
                Section {
                    TextField("Interests and location (optional)", text: $settings.ai.interests, prompt: Text("Interests and location (optional)").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(3...6).accessibilityIdentifier("aiInterests")
                    Toggle("Curate listings", isOn: $settings.ai.curateFeed).accessibilityIdentifier("curateFeed")
                } header: { Text("Interests") } footer: { Text("Filter listings by your interests. If AI is unavailable, listings stay visible.") }
                Section {
                    Button { save(test: false) } label: { HStack { Spacer(); Text("Save preferences").fontWeight(.semibold); Spacer() }.padding(.vertical, 6) }.accessibilityIdentifier("saveAISettings")
                    Button { save(test: true) } label: { Label("Save & test connection", systemImage: "checkmark.circle") }.disabled(store.demo || !settings.ai.enabled || settings.ai.model.isEmpty || store.busy)
                    if saved { Label("Preferences saved", systemImage: "checkmark.circle.fill").foregroundStyle(MarketTheme.green).font(.system(size: 13)) }
                    if let issue = store.alert { Text(issue).font(.system(size: 13)).foregroundStyle(.red).accessibilityIdentifier("settingsError") }
                }
            }.scrollContentBackground(.hidden).background(MarketTheme.paper).navigationTitle("AI settings").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .onAppear { loadKey() }.onChange(of: settings.ai.provider) { _ in loadKey() }.onChange(of: settings.ai.baseUrl) { _ in loadKey() }
        }
    }
    private func loadKey() { do { apiKey = try SecureStore.read(SecureStore.aiAccount(settings.ai)) ?? "" } catch { store.alert = error.localizedDescription } }
    private func save(test: Bool) { store.saveSettings(settings, key: apiKey) { success in saved = success; if success && test { store.runAI(type: "check_ai") } } }
}

struct ConnectionSettingsView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State var settings: MarketSettings
    @State private var servers = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Your account") {
                    LabeledContent("Identity", value: store.demo ? "Preview account" : "Stored securely on this device")
                    Button { MarketPlatform.copyToClipboard(store.snapshot.publicKey) } label: { Label("Copy account ID", systemImage: "doc.on.doc") }
                }
                Section("Photos") {
                    Toggle("Use image proxy", isOn: $settings.imageProxy.enabled)
                    if settings.imageProxy.enabled {
                        TextField("Image service URL", text: $settings.imageProxy.url).marketNoAutocapitalization().autocorrectionDisabled().marketURLKeyboard()
                    }
                    Text("Loads smaller photos through the selected service.").font(.caption).foregroundStyle(MarketTheme.muted)
                }
                Section("Connection details") {
                    Text(store.snapshot.status).font(.caption).foregroundStyle(MarketTheme.muted)
                    if let error = store.snapshot.error { Text(error).font(.caption).foregroundStyle(.red) }
                    if let profile = store.snapshot.profile {
                        Text(profile.graphLabel).font(.caption)
                        Text(profile.coverage).font(.caption).foregroundStyle(MarketTheme.muted)
                        if let error = profile.error { Text(error).font(.caption).foregroundStyle(.red) }
                    }
                }
                Section { TextField("One server URL per line", text: $servers, prompt: Text("One server URL per line").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(4...8).font(.system(size: 13, design: .monospaced)).marketNoAutocapitalization().autocorrectionDisabled() } header: { Text("Message servers") } footer: { Text("These servers help your app discover and share public listings over the internet. Nearby device exchange is planned for a later version.") }
                Section {
                    MarketInlineError()
                    Button("Save connections") {
                        settings.relays = servers.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                        do { store.command(["type": "set_settings", "settings": try MarketJSON.object(settings)]) { if $0 { dismiss() } } } catch { store.alert = error.localizedDescription }
                    }
                }
            }.scrollContentBackground(.hidden).background(MarketTheme.paper).navigationTitle("Connections").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .onAppear { servers = settings.relays.joined(separator: "\n") }
        }
    }
}
