/// Process-local drafts stay separate by account, peer, and exact conversation context.
struct NativeMessageDrafts {
    struct Key: Hashable {
        let account: String
        let peer: String
        let context: String
        init(account: String, peer: String, context: String) {
            self.account = account
            self.peer = peer
            self.context = context == "*" ? "general" : context
        }
    }
    private var values: [Key: String] = [:]
    subscript(key: Key) -> String {
        get { values[key] ?? "" }
        set {
            guard !key.account.isEmpty else { return }
            values[key] = newValue.isEmpty ? nil : newValue
        }
    }
    mutating func sent(_ text: String, for key: Key, success: Bool) {
        guard success, self[key] == text else { return }
        values.removeValue(forKey: key)
    }
}
