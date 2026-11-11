import SwiftUI
import Translation

private enum MarketPreferredLanguagesKey: EnvironmentKey {
    static var defaultValue: [String] { Locale.preferredLanguages }
}

extension EnvironmentValues {
    var marketPreferredLanguages: [String] {
        get { self[MarketPreferredLanguagesKey.self] }
        set { self[MarketPreferredLanguagesKey.self] = newValue }
    }
}

@available(iOS 18, macOS 15, *)
struct MarketTranslationSettings: View {
    @Environment(\.marketPreferredLanguages) private var preferences
    @AppStorage(MarketLanguages.automaticKey) private var automatic = false
    @AppStorage(MarketLanguages.targetKey) private var target = ""
    @AppStorage(MarketLanguages.readingKey) private var reading = "system"
    @State private var supported: [String] = []
    @State private var expanded = false

    var body: some View {
        let device = preferences.first ?? Locale.current.identifier
        let destination = target.isEmpty ? device : target
        VStack(alignment: .leading, spacing: 14) {
            Label("Translation", systemImage: "character.bubble.fill").font(.subheadline.weight(.semibold))
            Picker("Translate into", selection: $target) {
                Text("Device language (\(MarketLanguages.name(device)))").tag("")
                ForEach(supported, id: \.self) { tag in Text(MarketLanguages.name(tag)).tag(tag) }
            }.pickerStyle(.menu)
            Toggle("Always translate into \(MarketLanguages.name(MarketLanguages.code(destination)))", isOn: $automatic)
            DisclosureGroup("Languages I read", isExpanded: $expanded) {
                let selected = MarketLanguages.reading(reading, target: destination, preferences: preferences)
                let codes = Set(supported.map(MarketLanguages.code)).union(selected)
                    .sorted { MarketLanguages.name($0).localizedCaseInsensitiveCompare(MarketLanguages.name($1)) == .orderedAscending }
                if reading != "system" {
                    Button("Use device languages") { reading = "system" }.font(.caption)
                }
                ForEach(codes.filter { $0 != MarketLanguages.code(destination) }, id: \.self) { code in
                    Toggle(MarketLanguages.name(code), isOn: Binding(get: { selected.contains(code) }, set: { value in
                        var next = MarketLanguages.reading(reading, target: destination, preferences: preferences)
                        if value { next.insert(code) } else { next.remove(code) }
                        reading = next.sorted().joined(separator: ",")
                    }))
                }
            }
        }.padding(20).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 23))
            .task {
                supported = await LanguageAvailability().supportedLanguages.map(\.minimalIdentifier)
                    .sorted { MarketLanguages.name($0).localizedCaseInsensitiveCompare(MarketLanguages.name($1)) == .orderedAscending }
            }
    }
}

struct MarketTranslation<Content: View>: View {
    let fields: [AttributedString]
    var context: String = ""
    @ViewBuilder var content: ([AttributedString]) -> Content

    @EnvironmentObject private var store: MarketStore
    @Environment(\.marketPreferredLanguages) private var preferences
    @AppStorage(MarketLanguages.automaticKey) private var automatic = false
    @AppStorage(MarketLanguages.targetKey) private var target = ""
    @AppStorage(MarketLanguages.readingKey) private var reading = "system"

    var body: some View {
        if #available(iOS 18, macOS 15, *) {
            let destination = target.isEmpty ? (preferences.first ?? Locale.current.identifier) : target
            let read = MarketLanguages.reading(reading, target: destination, preferences: preferences)
            let input = TranslationInput(fields: fields, context: context, target: destination,
                                         reading: read, automatic: automatic, downloadsAllowed: !store.demo)
            OnDeviceTranslation(input: input, content: content).id(input)
        } else {
            content(fields)
        }
    }
}

private struct TranslationInput: Hashable {
    let fields: [AttributedString]
    let context: String
    let target: String
    let reading: Set<String>
    let automatic: Bool
    let downloadsAllowed: Bool
}

@available(iOS 18, macOS 15, *)
private struct OnDeviceTranslation<Content: View>: View {
    let input: TranslationInput
    let content: ([AttributedString]) -> Content
    @AppStorage(MarketLanguages.automaticKey) private var automatic = false
    @State private var source: Locale.Language?
    @State private var configuration: TranslationSession.Configuration?
    @State private var translated: [AttributedString]?
    @State private var showingOriginal = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            content(showingOriginal ? input.fields : (translated ?? input.fields))
            if let source {
                if let translated {
                    Button(showingOriginal ? "Show translation" : "Show original") { showingOriginal.toggle() }
                        .accessibilityValue(showingOriginal ? "Original" : "Translated from \(MarketLanguages.name(source.minimalIdentifier))")
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                    if !input.automatic && !showingOriginal && translated != input.fields {
                        Button("Always translate into \(MarketLanguages.name(MarketLanguages.code(input.target)))") {
                            automatic = true
                        }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                    }
                } else if configuration == nil {
                    Button(failed ? "Retry translation" : "Translate") { start(source) }
                        .accessibilityLabel(failed ? "Retry translation" : "Translate from \(MarketLanguages.name(source.minimalIdentifier))")
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
            }
        }.task {
            let text = String((input.context.isEmpty ? input.fields.map { String($0.characters) }.joined(separator: "\n") : input.context).prefix(1400))
            let sample = MarketTranslationDocument([AttributedString(text)]).pieces.flatMap { $0 }.filter(\.translate).map(\.text).joined(separator: " ")
            guard let detected = MarketLanguages.source(for: sample, target: input.target, reading: input.reading) else { return }
            let status = await LanguageAvailability().status(from: detected, to: Locale.Language(identifier: input.target))
            guard !Task.isCancelled, status == .installed || (status == .supported && input.downloadsAllowed) else { return }
            source = detected
            // Scrolling never initiates a model download. A tap can open Apple's consent sheet.
            if input.automatic && status == .installed && translated == nil { start(detected) }
        }
        .translationTask(configuration) { session in
            do {
                let result = try await MarketTranslationDocument(input.fields).translated(using: session)
                try Task.checkCancellation()
                translated = result
            } catch {
                if !Task.isCancelled { failed = true }
            }
            if !Task.isCancelled { configuration = nil }
        }
        .onDisappear {
            configuration = nil
            translated = nil
            showingOriginal = false
            failed = false
            source = nil
        }
    }

    private func start(_ source: Locale.Language) {
        failed = false
        configuration = .init(source: source, target: Locale.Language(identifier: input.target))
    }
}
