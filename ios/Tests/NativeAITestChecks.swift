import Foundation
@main struct NativeAITestChecks {
    static func main() async throws {
        let sample = NativeAITestInput(query: "violin", listing: "Wooden office desk")
        var invoked = false
        let decision = try await NativeAITestRunner.run(sample) { query, listing in
            invoked = true
            precondition(query == "violin" && listing == ["description": "Wooden office desk"])
            return false
        }
        precondition(invoked && !decision, "A completed classifier No-match must not become readiness success")
        var invalid = sample; invalid.query = " "
        do { _ = try await NativeAITestRunner.run(invalid) { _, _ in preconditionFailure("Invalid input must not infer") }; preconditionFailure() } catch is NativeAITestRunner.InvalidInput {}
        invalid.query = String(repeating: "é", count: 501); precondition(invalid.validationError != nil)
        invalid.query = String(repeating: "é", count: 500); precondition(invalid.validationError == nil)
        invalid.listing = String(repeating: "x", count: 2001); precondition(invalid.validationError != nil)
        let context = NativeAITestContext(account: 1, epoch: 2, provider: "apple", model: "system", endpoint: "", enabled: true)
        let session = NativeAITestSession(); let submitted = session.invalidate()
        precondition(session.accepts(submitted, context: context, current: context))
        _ = session.invalidate(); precondition(!session.accepts(submitted, context: context, current: context), "An input edit must reject an already queued completion")
        for current in [NativeAITestContext(account: 2, epoch: 2, provider: "apple", model: "system", endpoint: "", enabled: true),NativeAITestContext(account: 1, epoch: 3, provider: "apple", model: "system", endpoint: "", enabled: true),NativeAITestContext(account: 1, epoch: 2, provider: "compatible", model: "new", endpoint: "https://example.invalid", enabled: true),NativeAITestContext(account: 1, epoch: 2, provider: "apple", model: "system", endpoint: "", enabled: false)] {
            precondition(!session.accepts(session.revision, context: context, current: current))
        }
        let off = NativeAITestContext(account: 1, epoch: 2, provider: "apple", model: "system", endpoint: "", enabled: false)
        precondition(session.accepts(session.revision, context: off, current: off), "Testing an unchanged Off context is allowed")
        let result = NativeAITestResult(matched: false, elapsedMs: 42, provider: "apple", model: "system", error: nil)
        precondition(result.summary == "No match · Apple on-device · system · 42 ms")
        print("Native AI sandbox: 14 validation/local-classifier/stale-completion checks passed")
    }
}
