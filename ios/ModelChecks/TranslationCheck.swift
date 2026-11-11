import Foundation
import Translation

/// Compile alongside Sources/NativeTranslation.swift. Uses synthetic text and installed models only.
@main struct TranslationCheck {
    static func main() async throws {
        let sample = "Hyväkuntoinen polkupyörä. Nouto onnistuu Helsingistä huomenna iltapäivällä."
        let preferences = ["en-US", "fi-FI", "sv-SE"]
        let reading = MarketLanguages.reading("system", target: "en-US", preferences: preferences)
        precondition(reading == ["fi", "sv"])
        precondition(MarketLanguages.reading("system", target: "de", preferences: preferences) == ["en", "fi", "sv"])
        precondition(MarketLanguages.code("en-GB") == MarketLanguages.code("en-US"))
        precondition(MarketLanguages.code("zh-Hans") != MarketLanguages.code("zh-Hant"))
        precondition(MarketLanguages.reading("", target: "en-US", preferences: preferences).isEmpty)
        precondition(MarketLanguages.reading("de", target: "en-US", preferences: preferences) == ["de"])
        precondition(MarketLanguages.source(for: sample, target: "en-US", reading: reading) == nil)
        precondition(MarketLanguages.source(for: sample, target: "fi-FI", reading: []) == nil)
        precondition(MarketLanguages.source(for: "Nokia", target: "en", reading: []) == nil)
        precondition(MarketLanguages.source(for: "OK", target: "en", reading: []) == nil)
        guard let source = MarketLanguages.source(for: sample, target: "en-US", reading: []), source.languageCode?.identifier == "fi" else {
            fatalError("Finnish should be translatable after removing it from reading languages")
        }

        var attachment = AttributedString("Valokuva")
        attachment.link = URL(string: "https://example.com/photo1")
        let fields = [AttributedString(sample), AttributedString("Sarjanumero AB-123. ") + attachment + AttributedString(" https://example.com/listing/12")]
        let document = MarketTranslationDocument(fields)
        precondition(document.pieces.flatMap { $0 }.filter { !$0.translate }.map(\.text).contains("https://example.com/listing/12"))
        print("Language preferences, exclusions, confidence and protected spans passed")
        if #available(macOS 26, iOS 26, *) {
            let target = Locale.Language(identifier: "en-US")
            if await LanguageAvailability().status(from: source, to: target) == .installed {
                let session = TranslationSession(installedSource: source, target: target)
                let translated = try await document.translated(using: session)
                precondition(translated[0] != fields[0])
                precondition(translated[1].runs.contains { $0.link == attachment.link })
                let text = String(translated[1].characters)
                precondition(text.contains("AB-123") && text.contains("https://example.com/listing/12"))
                print("Real Finnish to English translation, original URL, serial number and link destination passed")
                return
            }
        }
        print("No installed Finnish to English session for the runtime check")
        exit(77)
    }
}
