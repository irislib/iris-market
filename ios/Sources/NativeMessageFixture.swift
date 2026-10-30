#if DEBUG
import Foundation

/// Visual harness only. No ratchet, keys, private message database, or network.
struct NativeMessageFixture {
    static var enabled: Bool { NativeTestStorage.enabled && (try? NativeTestStorage.directory()) != nil && ProcessInfo.processInfo.arguments.contains("--ui-test-messages") }
    static let peer = String(repeating: "b", count: 64)
    private var reactions: [String: [NativeMessageReaction]] = ["fixture-delivered": [.init(emoji: "👍", count: 2, reactedByMe: true)]]
    private(set) var readIDs = Set<String>()
    mutating func apply(_ command: [String: Any]) -> Bool {
        guard Self.enabled else { return false }
        if command["type"] as? String == "mark_messages_read", let ids = command["message_ids"] as? [String] {
            readIDs.formUnion(ids.filter { $0.hasPrefix("fixture-incoming-") }); return true
        }
        guard command["type"] as? String == "toggle_reaction", command["peer_id"] as? String == Self.peer,
              let id = command["message_id"] as? String, id.hasPrefix("fixture-"), let emoji = command["emoji"] as? String,
              NativeMessagePresentation.emoji.contains(emoji) else { return false }
        let old = reactions[id] ?? []
        let removing = old.contains { $0.emoji == emoji && $0.reactedByMe }
        var next = old.compactMap { item -> NativeMessageReaction? in
            let count = item.count - (item.reactedByMe ? 1 : 0)
            return count > 0 ? .init(emoji: item.emoji, count: count, reactedByMe: false) : nil
        }
        if !removing {
            let index = next.firstIndex { $0.emoji == emoji }
            if let index { next[index] = .init(emoji: emoji, count: next[index].count + 1, reactedByMe: true) }
            else { next.append(.init(emoji: emoji, count: 1, reactedByMe: true)) }
        }
        reactions[id] = next
        return true
    }
    func project(_ original: MarketSnapshot) -> MarketSnapshot {
        guard Self.enabled else { return original }
        var snapshot = original
        let time: Int64 = 1_798_000_000
        let examples: [(String, String, Bool, String)] = [
            ("fixture-queued", "A queued message", true, "queued"),
            ("fixture-incoming-intro", "Local UI fixture. These messages never leave this device.", false, "received"),
            ("fixture-sent", "Sent to the relay", true, "sent"),
            ("fixture-delivered", "Delivered to the other device", true, "delivered"),
            ("fixture-seen", "Seen by the recipient", true, "seen")
        ] + (0..<36).map { ("fixture-incoming-\($0)", "Local incoming message \($0 + 1). Scroll to view it.", false, "received") }
        let messages = examples.enumerated().map { index, value in
            MarketMessage(id: value.0, text: value.1, mine: value.2, createdAt: time + Int64(index * 60), delivery: value.3, reactions: reactions[value.0] ?? [], orderId: nil, cashu: nil)
        }
        snapshot.conversations = [.init(id: Self.peer, name: "Local test conversation", messages: messages)]
        snapshot.people[Self.peer] = MarketPerson(author: Self.peer, name: "Local test conversation", pictureUrl: nil, connection: MarketPerson.unnamed(Self.peer).connection)
        return snapshot
    }
}
#endif
