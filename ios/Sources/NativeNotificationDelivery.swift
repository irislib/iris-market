import Foundation
import UserNotifications

/// Server-visible fields are never copied into a local notification preview.
enum NativeNotificationDelivery {
    static func safeUserInfo(_ userInfo: [AnyHashable: Any]) -> [AnyHashable: Any] {
        guard JSONSerialization.isValidJSONObject(userInfo),
              let data = try? JSONSerialization.data(withJSONObject: userInfo), data.count <= 65536 else { return [:] }
        var result = userInfo
        result.removeValue(forKey: "aps")
        result.removeValue(forKey: "market_message_id")
        return result
    }
    static func fallback(filtering: Bool, userInfo: [AnyHashable: Any] = [:]) -> UNNotificationContent {
        if filtering { return UNNotificationContent() }
        let content = UNMutableNotificationContent()
        content.title = "Iris Market"; content.body = "New activity"
        content.userInfo = safeUserInfo(userInfo)
        return content
    }
    /// Call only with an authenticated, user-facing resolution and a fresh receipt.
    static func preview(title: String, body: String, thread: String, messageID: String?, userInfo: [AnyHashable: Any]) -> UNNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body; content.sound = .default
        content.threadIdentifier = thread
        content.userInfo = safeUserInfo(userInfo)
        content.userInfo["market_message_id"] = messageID
        return content
    }
}

/// Resolution and timeout can race; only the first completion reaches the system.
final class NativeNotificationCompletion<Content> {
    private let lock = NSLock()
    private var handler: ((Content) -> Void)?
    func prepare(_ handler: @escaping (Content) -> Void) {
        lock.lock(); self.handler = handler; lock.unlock()
    }
    func finish(_ content: Content) {
        lock.lock(); let handler = handler; self.handler = nil; lock.unlock()
        handler?(content)
    }
}
