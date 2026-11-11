import Foundation
import NaturalLanguage
import Translation

enum MarketLanguages {
    static let automaticKey = "market.translation.automatic"
    static let targetKey = "market.translation.target"
    static let readingKey = "market.translation.reading"

    static func name(_ tag: String) -> String { Locale.current.localizedString(forIdentifier: tag) ?? tag }

    static func code(_ tag: String) -> String {
        let language = Locale.Language(identifier: tag)
        let base = language.languageCode?.identifier ?? tag.lowercased()
        if let script = language.script, script != Locale.Language(identifier: base).script {
            return base + "-" + script.identifier
        }
        return base
    }

    static func reading(_ stored: String, target: String, preferences: [String] = Locale.preferredLanguages) -> Set<String> {
        let tags = stored == "system" ? preferences : stored.split(separator: ",").map(String.init)
        return Set(tags.map(code)).subtracting([code(target)])
    }

    static func source(for sample: String, target: String, reading: Set<String>) -> Locale.Language? {
        let letters = sample.unicodeScalars.filter(CharacterSet.letters.contains)
        guard letters.count >= 5 else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(sample)
        guard let best = recognizer.languageHypotheses(withMaximum: 1).first, best.value >= 0.75 else { return nil }
        let source = code(best.key.rawValue)
        if letters.count < 12 && sample.split(whereSeparator: { !$0.isLetter }).count < 2 &&
            !["zh", "ja", "ko", "th"].contains(Locale.Language(identifier: source).languageCode?.identifier ?? "") { return nil }
        guard source != code(target), !reading.contains(source) else { return nil }
        return Locale.Language(identifier: best.key.rawValue)
    }
}

// The translator receives prose only. Link targets, payment tokens and numeric identifiers
// keep their original spelling; only markup already present in the source is reapplied.
struct MarketTranslationDocument {
    struct Piece {
        let text: String
        let attributes: AttributeContainer
        let translate: Bool
    }
    private static let protected = try! NSRegularExpression(
        pattern: #"(?i)(?:[a-z][a-z0-9+.-]*://|nostr:|lightning:|bitcoin:|mailto:|cashu[ab]|ln(?:bc|tb|bcrt)\d|(?:npub|nsec|nprofile|note|nevent|naddr|ncryptsec)1)[^\s]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[\p{L}\d_-]*\d[\p{L}\d_.,:/-]*|[\da-f]{32,}"#
    )
    let pieces: [[Piece]]
    init(_ fields: [AttributedString]) {
        pieces = fields.map { field in
            field.runs.flatMap { run -> [Piece] in
                let text = String(field[run.range].characters)
                let source = text as NSString
                var parts: [Piece] = []
                func append(_ value: String, prose: Bool) {
                    guard !value.isEmpty else { return }
                    parts.append(Piece(text: value, attributes: run.attributes, translate: prose && value.unicodeScalars.contains(where: CharacterSet.letters.contains)))
                }
                // Keep whitespace around protected spans when models trim their input.
                func appendProse(_ range: NSRange) {
                    let value = source.substring(with: range)
                    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty, let content = value.range(of: trimmed) else { append(value, prose: false); return }
                    append(String(value[..<content.lowerBound]), prose: false)
                    append(trimmed, prose: true)
                    append(String(value[content.upperBound...]), prose: false)
                }
                var start = 0
                for match in Self.protected.matches(in: text, range: NSRange(location: 0, length: source.length)) {
                    appendProse(NSRange(location: start, length: match.range.location - start))
                    append(source.substring(with: match.range), prose: false)
                    start = NSMaxRange(match.range)
                }
                appendProse(NSRange(location: start, length: source.length - start))
                return parts
            }
        }
    }

    @available(iOS 18, macOS 15, *)
    func translated(using session: TranslationSession) async throws -> [AttributedString] {
        let requests = pieces.flatMap { $0 }.filter(\.translate).enumerated().map {
            TranslationSession.Request(sourceText: $0.element.text, clientIdentifier: String($0.offset))
        }
        let responses = try await session.translations(from: requests)
        var replacements: [Int: String] = [:]
        for response in responses {
            if let id = response.clientIdentifier.flatMap(Int.init), !response.targetText.isEmpty { replacements[id] = response.targetText }
        }
        guard requests.count == replacements.count else { throw CocoaError(.coderValueNotFound) }
        var index = 0
        return pieces.map { field in
            field.reduce(into: AttributedString()) { result, part in
                let text = part.translate ? replacements[index] ?? part.text : part.text
                if part.translate { index += 1 }
                result += AttributedString(text, attributes: part.attributes)
            }
        }
    }
}
