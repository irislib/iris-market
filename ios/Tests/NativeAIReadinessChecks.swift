@main struct NativeAIReadinessChecks {
    static func main() {
        var policy = NativeLocalAIDefault()
        var available = false
        let readAvailability = { available }
        func attempt(_ owner: String = "profile", configured: Bool = false, editing: Bool = false, preview: Bool = false) -> Bool {
            policy.shouldOffer(owner: owner, configured: configured, available: readAvailability(), editing: editing, preview: preview)
        }
        precondition(!attempt(), "An unready OS model must not opt in")
        available = true
        precondition(attempt(), "Foreground/poll readiness callback must catch a delayed model")
        precondition(!attempt(), "Polling must not repeatedly write the same default")
        precondition(!attempt(configured: true), "A saved choice must win")
        available = false; precondition(!attempt("off-profile", configured: true))
        available = true; precondition(!attempt("off-profile", configured: true), "Readiness transition must preserve explicit Off")
        precondition(!attempt("editing-profile", editing: true))
        precondition(attempt("editing-profile"), "Closing preferences may apply an untouched default")
        precondition(!attempt("preview-profile", preview: true))
        precondition(NativeAIReadiness.isOn(enabled: true, provider: "apple", model: "apple-system", endpoint: "", localAvailable: true))
        precondition(!NativeAIReadiness.isOn(enabled: true, provider: "apple", model: "apple-system", endpoint: "", localAvailable: false))
        precondition(!NativeAIReadiness.isOn(enabled: false, provider: "apple", model: "apple-system", endpoint: "", localAvailable: true))
        precondition(!NativeAIReadiness.canEnable(provider: "compatible", model: "", endpoint: "https://service.invalid/v1", localAvailable: true))
        precondition(NativeAIReadiness.canEnable(provider: "compatible", model: "model", endpoint: "https://service.invalid/v1", localAvailable: false))
        precondition(!NativeAIReadiness.canEnable(provider: "compatible", model: "model", endpoint: "https://service.invalid/v1", localAvailable: false, preview: true))
        precondition(!NativeAIReadiness.canEnable(provider: "compatible", model: "model", endpoint: "http://10.evil.invalid/v1", localAvailable: false))
        precondition(NativeAIReadiness.canEnable(provider: "ollama", model: "model", endpoint: "http://172.16.2.3:11434", localAvailable: false))
        precondition(NativeAIReadiness.canSelectLocalOnTap(provider: "compatible", model: "", endpoint: "https://api.openai.com/v1"))
        precondition(!NativeAIReadiness.canSelectLocalOnTap(provider: "compatible", model: "chosen-model", endpoint: "https://api.openai.com/v1"))
        precondition(!NativeAIReadiness.canSelectLocalOnTap(provider: "compatible", model: "", endpoint: "https://api.groq.com/openai/v1"))
        precondition(NativeAIReadiness.searchAction(intentOn: true, ready: true, busy: true, inference: false, query: "bicycle") == .wait)
        precondition(NativeAIReadiness.searchAction(intentOn: false, ready: false, busy: false, inference: true, query: "bicycle") == .wait)
        precondition(NativeAIReadiness.searchAction(intentOn: true, ready: true, busy: false, inference: false, query: "bicycle") == .ai)
        precondition(NativeAIReadiness.searchAction(intentOn: false, ready: false, busy: false, inference: false, query: "bicycle") == .text)
        precondition(NativeAIReadiness.searchAction(intentOn: true, ready: false, busy: false, inference: false, query: "bicycle") == .settings, "On intent must never fall through to literal when unavailable")
        precondition(NativeAIReadiness.searchAction(intentOn: true, ready: false, busy: false, inference: false, query: "") == .text, "An empty submission may clear the feed")
        precondition(NativeAIReadiness.tapAction(enabled: true, ready: false, localFallback: false) == .off, "Unavailable On must still turn Off")
        precondition(NativeAIReadiness.tapAction(enabled: true, ready: true, localFallback: true) == .off)
        precondition(NativeAIReadiness.tapAction(enabled: false, ready: false, localFallback: true) == .local)
        precondition(NativeAIReadiness.tapAction(enabled: false, ready: true, localFallback: true) == .on, "Chosen ready provider wins over local fallback")
        precondition(NativeAIReadiness.tapAction(enabled: false, ready: false, localFallback: false) == .settings)
        let gate = NativeAIIntentGate()
        let oldEditor = gate.current
        var enabled = true
        let urgentOff = gate.advance()
        _ = gate.perform(at: urgentOff) { enabled = false }
        let staleWrite: Void? = gate.perform(at: oldEditor) { enabled = true }
        precondition(staleWrite == nil && !enabled, "An older queued editor must not re-enable urgent Off")
        let newerOn = gate.advance()
        _ = gate.perform(at: newerOn) { enabled = true }
        precondition(enabled, "A new explicit On intent remains possible")
        print("Native AI readiness: 33 lifecycle/availability/intent/search/queued-write checks passed")
    }
}
