/// A controlled completion queue exercises edits while persistence is in flight.
@main struct NativeAutosaveChecks {
    static func main() {
        var state = NativeAutosaveState<String>()
        state.reset("initial")
        var current = "A"
        let a = state.submit(current)
        var completions: [() -> Void] = []
        completions.append { state.complete(a, success: true) }
        current = "B"
        completions.removeFirst()()
        precondition(state.needsSave(current), "A completion must leave unsent B dirty")
        let b = state.submit(current)
        state.complete(b, success: true)
        precondition(!state.needsSave(current))
        state.complete(a, success: true)
        precondition(!state.needsSave(current), "Late A must not roll back B acknowledgement")
        state.keyChanged()
        let keyA = state.submit(current)
        state.keyChanged()
        state.complete(keyA, success: true)
        precondition(state.keyDirty, "Older key acknowledgement must preserve a newer edit")
        let keyB = state.submit(current)
        state.complete(keyB, success: false)
        precondition(state.needsSave(current) && state.keyDirty, "Key-only failure must remain retryable")
        let retry = state.submit(current)
        state.complete(retry, success: true)
        precondition(!state.needsSave(current))
        print("Native autosave: 6 callback ordering/retry checks passed")
    }
}
