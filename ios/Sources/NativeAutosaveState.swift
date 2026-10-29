/// Tracks acknowledgements of submitted values, independently of newer edits.
struct NativeAutosaveState<Value: Equatable> {
    struct Submission {
        let value: Value
        let sequence: Int
        let keyRevision: Int
        let replaceKey: Bool
    }
    private(set) var original: Value?
    private(set) var keyDirty = false
    private var keyRevision = 0
    private var sequence = 0
    private var acknowledged = 0
    mutating func reset(_ value: Value) { original = value; keyLoaded() }
    mutating func keyLoaded() { keyRevision += 1; keyDirty = false }
    mutating func keyChanged() { keyRevision += 1; keyDirty = true }
    func needsSave(_ value: Value) -> Bool { value != original || keyDirty }
    mutating func submit(_ value: Value) -> Submission {
        sequence += 1
        return Submission(value: value, sequence: sequence, keyRevision: keyRevision, replaceKey: keyDirty)
    }
    mutating func complete(_ submission: Submission, success: Bool) {
        guard success else { return }
        if submission.sequence > acknowledged { original = submission.value; acknowledged = submission.sequence }
        if submission.replaceKey && submission.keyRevision == keyRevision { keyDirty = false }
    }
}
