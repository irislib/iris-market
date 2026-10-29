import Foundation

struct NativeAITestInput: Equatable, Sendable {
    var query = "bicycle"
    var listing = "City bicycle in working condition."
    var validationError: String? {
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || query.utf8.count > 1000 { return "Enter a test search of up to 1000 bytes." }
        if listing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || listing.utf8.count > 2000 { return "Enter an example listing of up to 2000 bytes." }
        return nil
    }
}
struct NativeAITestResult: Decodable, Equatable, Sendable {
    let matched: Bool?
    let elapsedMs: UInt64
    let provider: String
    let model: String
    let error: String?
    var summary: String {
        let label = provider == "apple" ? "Apple on-device" : provider == "litert" ? "On-device" : provider
        return summary(providerLabel: label)
    }
    func summary(providerLabel: String) -> String {
        "\(matched.map { $0 ? "Match" : "No match" } ?? "Test failed") · \(providerLabel) · \(model) · \(elapsedMs) ms"
    }
}
struct NativeAITestContext: Equatable, Sendable {
    let account: Int
    let epoch: Int
    let provider: String
    let model: String
    let endpoint: String
    let enabled: Bool
}
/// Inputs/settings edits invalidate even a completion that was already queued for the UI.
final class NativeAITestSession: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var revision: Int { lock.lock(); defer { lock.unlock() }; return value }
    func invalidate() -> Int { lock.lock(); defer { lock.unlock() }; value += 1; return value }
    func accepts(_ submitted: Int, context: NativeAITestContext, current: NativeAITestContext) -> Bool {
        submitted == revision && context == current
    }
}

@MainActor enum NativeAITestRunner {
    struct InvalidInput: Error {}
    static func run(_ sample: NativeAITestInput, classify: (String, [String: String]) async throws -> Bool) async throws -> Bool {
        guard sample.validationError == nil else { throw InvalidInput() }
        return try await classify(sample.query, ["description": sample.listing])
    }
}
