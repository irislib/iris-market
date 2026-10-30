import Foundation
import CoreGraphics

struct NativeMessageReaction: Decodable, Hashable {
    let emoji: String
    let count: Int
    let reactedByMe: Bool
}
enum NativeMessagePresentation {
    static let emoji = ["❤️", "👍", "😂", "🎉", "😮", "😢"]
    static func delivery(_ state: String?) -> String {
        switch state { case "pending": return "Pending"; case "queued": return "Queued"; case "sent": return "Sent"; case "delivered": return "Delivered"; case "seen": return "Seen"; case "failed": return "Not sent"; default: return "" }
    }
    /// Require a meaningful slice of the actual row inside the unobscured scroll viewport.
    static func visibleIncoming(frames: [String: CGRect], viewport: CGSize, incoming: Set<String>) -> Set<String> {
        guard viewport.width > 0, viewport.height > 0 else { return [] }
        let viewport = CGRect(origin: .zero, size: viewport)
        return Set(frames.compactMap { id, frame in
            let intersection = frame.intersection(viewport)
            guard incoming.contains(id), frame.height > 0, !intersection.isNull, intersection.width > 0,
                  intersection.height >= min(24, frame.height * 0.5) else { return nil }
            return id
        })
    }
}
