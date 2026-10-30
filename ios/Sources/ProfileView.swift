import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var store: MarketStore
    @AppStorage("market.appearance") private var appearance = "system"
    @State private var aiSettings = false
    @State private var signIn = false
    @State private var publicProfile = false
    @State private var connectionSettings = false
    @State private var transport = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 25) {
                Text("Profile").font(.system(size: 30, weight: .medium)).tracking(-1).foregroundStyle(MarketTheme.ink)
                VStack(spacing: 0) {
                    profileRow("Sign in", symbol: "person.crop.circle.badge.checkmark") { signIn = true }.disabled(store.demo)
                    Divider().padding(.leading, 61)
                    profileRow("Transport", subtitle: "Find work, manage jobs and offer your service", symbol: "car.fill") { transport = true }.accessibilityIdentifier("transportWorkspace")
                    Divider().padding(.leading, 61)
                    profileRow("My listings", symbol: "person.crop.circle.fill") { publicProfile = true }
                    Divider().padding(.leading, 61)
                    profileRow("AI settings", subtitle: store.snapshot.settings.ai.enabled ? (store.aiSearchEnabled ? "Enabled" : "Unavailable") : "Disabled", symbol: "sparkles") { aiSettings = true }.accessibilityIdentifier("aiSettingsRow")
                    Divider().padding(.leading, 61)
                    profileRow("Connections & profile", symbol: "point.3.connected.trianglepath.dotted") { connectionSettings = true }
                }.background(MarketTheme.surface.opacity(0.75), in: RoundedRectangle(cornerRadius: 23))
                Picker("Display currency", selection: Binding(get: { store.snapshot.settings.currency }, set: { value in
                    var settings = store.snapshot.settings; settings.currency = value
                    store.saveSettings(settings, key: "", replaceKey: false)
                })) { ForEach(nativeCurrencyOptions, id: \.self) { Text($0).tag($0) } }.pickerStyle(.menu)
                VStack(alignment: .leading, spacing: 14) {
                    Label("Appearance", systemImage: "circle.lefthalf.filled").font(.system(size: 14, weight: .semibold)).foregroundStyle(MarketTheme.ink)
                    Picker("Appearance", selection: $appearance) {
                        ForEach(MarketAppearance.allCases, id: \.rawValue) { option in Text(option.label).tag(option.rawValue) }
                    }.pickerStyle(.segmented).accessibilityIdentifier("appearancePicker")
                }.padding(20).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 23))
                if store.demo { Label("Preview mode uses sample listings and stays offline.", systemImage: "eye").font(.system(size: 12)).foregroundStyle(MarketTheme.muted) }
            }.padding(23)
        }.sheet(isPresented: $transport) { CourierWorkspaceView().marketSheetScope() }
            .sheet(isPresented: $signIn) { AccountSignInView().marketSheetScope() }
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
    @State private var saved = NativeAutosaveState<MarketSettings>()
    @State private var presetID = "custom"
    @State private var customModel = false
    @State private var initialized = false
    @State private var owner = ""
    @State private var aiIntentEpoch = 0
    @State private var autosave: Task<Void, Never>?
    @State private var testInput = NativeAITestInput()
    private enum TestField: Hashable { case query, listing }
    @FocusState private var testField: TestField?
    private var preset: NativeAIProvider { NativeAIProvider.presets.first { $0.id == presetID }! }
    private var local: Bool { settings.ai.provider == "apple" }
    private var canSave: Bool {
        if !settings.ai.enabled || local { return true }
        guard let url = URL(string: settings.ai.baseUrl), ["https", "http"].contains(url.scheme ?? ""), url.host != nil else { return false }
        return !settings.ai.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("AI search", isOn: $settings.ai.enabled).accessibilityIdentifier("enableAI")
                    if !local && NativeAIReadiness.canSelectLocalOnTap(provider: settings.ai.provider, model: settings.ai.model, endpoint: settings.ai.baseUrl), let reason = store.appleAIUnavailableReason {
                        Text("Apple on-device: \(reason)").font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("appleAIAvailability")
                    }
                    if store.demo && !local { Text("Preview stays offline. Remote AI search is unavailable here.").font(.caption).foregroundStyle(MarketTheme.muted) }
                    Picker("Provider", selection: $presetID) {
                        ForEach(NativeAIProvider.presets.filter { ["apple", "systemone"].contains($0.id) }) { Text($0.label).tag($0.id) }
                        Section("Other providers") { ForEach(NativeAIProvider.presets.filter { !["apple", "systemone"].contains($0.id) }) { Text($0.label).tag($0.id) } }
                    }.pickerStyle(.menu)
                    if local {
                        if let reason = store.appleAIUnavailableReason {
                            if settings.ai.enabled { Text("AI search will be ready when Apple Intelligence is available.").font(.caption).foregroundStyle(MarketTheme.muted) }
                            Text(reason).font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("appleAIAvailability") }
                        else { Label("Ready on this device", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(MarketTheme.green).accessibilityIdentifier("appleAIAvailability") }
                    } else {
                        if presetID == "custom" || presetID == "ollama" {
                            TextField("Service URL", text: $settings.ai.baseUrl).marketNoAutocapitalization().autocorrectionDisabled().marketURLKeyboard()
                        }
                        if !preset.models.isEmpty {
                            Picker("Model", selection: Binding(get: { customModel ? "__custom" : settings.ai.model }, set: { value in customModel = value == "__custom"; if !customModel { settings.ai.model = value } })) {
                                ForEach(preset.models, id: \.id) { Text($0.label).tag($0.id) }
                                Text("Custom model").tag("__custom")
                            }.pickerStyle(.menu)
                        }
                        if customModel || preset.models.isEmpty { TextField("Model name", text: $settings.ai.model).marketNoAutocapitalization().autocorrectionDisabled() }
                        if settings.ai.provider != "ollama" {
                            SecureField("API key", text: Binding(get: { apiKey }, set: { apiKey = $0; store.clearAITest(); saved.keyChanged(); scheduleSave() })).marketNoAutocapitalization().autocorrectionDisabled()
                            if let value = preset.keyURL, let url = URL(string: value) { Link(presetID == "systemone" ? "Service details" : "Get an API key", destination: url) }
                        }
                        Text(settings.ai.provider == "ollama" ? "Sends your search and public listing text to your Ollama server. Install the selected model on that server first." : "Sends your search and public listing text to this provider.").font(.caption).foregroundStyle(MarketTheme.muted)
                        if let value = preset.infoURL, let url = URL(string: value) { Link(presetID == "gemini" ? "Provider terms" : "Models and usage", destination: url).font(.caption) }
                    }
                    TextField("Test search", text: $testInput.query).focused($testField, equals: .query).accessibilityIdentifier("aiTestQuery")
                    TextField("Example listing", text: $testInput.listing, axis: .vertical).lineLimit(2...5).focused($testField, equals: .listing).accessibilityIdentifier("aiTestListing")
                    Text("Use sample text. This test does not change your feed.").font(.caption).foregroundStyle(MarketTheme.muted)
                    HStack {
                        Button("Test") { testField = nil; save { if $0 { store.testAI(testInput) } } }.accessibilityIdentifier("aiSandboxTest")
                            .disabled(store.busy || store.aiTestBusy || !canSave || testInput.validationError != nil || (store.demo && !local) || !NativeAIReadiness.canEnable(provider: settings.ai.provider, model: settings.ai.model, endpoint: settings.ai.baseUrl, localAvailable: store.appleAIUnavailableReason == nil))
                        if store.aiTestBusy { ProgressView(); Button("Stop") { store.clearAITest() }.accessibilityIdentifier("aiSandboxStop") }
                    }
                    if let result = store.aiTestResult {
                        Text(result.summary(providerLabel: preset.label)).font(.caption).accessibilityIdentifier("aiSandboxResult")
                        if let error = result.error { Text(error).font(.caption).foregroundStyle(MarketTheme.muted) }
                    }
                    if let error = store.aiTestError { Text(error).font(.caption).foregroundStyle(MarketTheme.muted).accessibilityIdentifier("aiSandboxError") }
                    if let progress = store.localAIProgress { HStack { ProgressView(); Text(progress).font(.caption); Spacer(); Button("Stop") { store.cancelLocalAI() } } }
                    MarketInlineError()
                }
            }.scrollContentBackground(.hidden).background(MarketTheme.paper).marketKeyboardDismissal().navigationTitle("AI search").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { save(); dismiss() } } }
                .onAppear {
                    owner = store.snapshot.publicKey; aiIntentEpoch = store.aiIntentEpoch; store.aiPreferencesEditing = true; store.refreshAIAvailability(); store.clearAITest()
                    presetID = NativeAIProvider.matching(settings.ai).id
                    customModel = !preset.models.contains { $0.id == settings.ai.model }
                    loadKey(); saved.reset(settings); initialized = true
                }
                .onChange(of: presetID) { value in
                    guard initialized, let choice = NativeAIProvider.presets.first(where: { $0.id == value }) else { return }
                    settings.ai.provider = choice.provider; settings.ai.baseUrl = choice.endpoint
                    settings.ai.model = choice.models.first?.id ?? ""; customModel = choice.models.isEmpty
                    loadKey(); scheduleSave()
                }
                .onChange(of: settings.ai.baseUrl) { _ in if initialized { loadKey() } }
                .onChange(of: testInput) { _ in store.clearAITest() }
                .onChange(of: settings) { _ in if initialized { store.clearAITest(); scheduleSave() } }
                .onDisappear { store.clearAITest(); autosave?.cancel(); save(); store.aiPreferencesEditing = false }
        }
    }
    private func loadKey() {
        saved.keyLoaded()
        apiKey = store.demo ? "" : ((try? SecureStore.read(SecureStore.aiAccount(settings.ai))) ?? "")
    }
    private func scheduleSave() {
        autosave?.cancel()
        autosave = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 650_000_000)
            guard !Task.isCancelled else { return }; save()
        }
    }
    private func save(completion: ((Bool) -> Void)? = nil) {
        autosave?.cancel()
        guard initialized, canSave, owner == store.snapshot.publicKey else { completion?(false); return }
        guard saved.needsSave(settings) else { completion?(true); return }
        settings.ai.interests = ""; settings.ai.curateFeed = false
        let submitted = saved.submit(settings)
        var committedEpoch = aiIntentEpoch
        let scheduledEpoch = store.saveSettings(submitted.value, key: apiKey, replaceKey: submitted.replaceKey, expectedAIIntent: aiIntentEpoch) { success in
            saved.complete(submitted, success: success)
            if success { aiIntentEpoch = max(aiIntentEpoch, committedEpoch) }
            completion?(success)
        }
        if let scheduledEpoch { committedEpoch = scheduledEpoch }
    }
}

struct ConnectionSettingsView: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.dismiss) private var dismiss
    @State var settings: MarketSettings
    @State private var servers = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Your profile") {
                    LabeledContent("Identity", value: store.demo ? "Preview profile" : "Stored securely on this device")
                    Button { MarketPlatform.copyToClipboard(store.snapshot.publicKey) } label: { Label("Copy profile ID", systemImage: "doc.on.doc") }
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
                Section { TextField("One server URL per line", text: $servers, prompt: Text("One server URL per line").foregroundColor(MarketTheme.muted), axis: .vertical).lineLimit(4...8).font(.system(size: 13)).marketNoAutocapitalization().autocorrectionDisabled() } header: { Text("Message servers") } footer: { Text("These servers help your app discover and share public listings over the internet. Nearby device exchange is planned for a later version.") }
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
