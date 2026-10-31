import Foundation
import UserNotifications

@main struct NativeNotificationDeliveryChecks {
    static func main() {
        var checks = 0
        func check(_ name: String, _ body: () -> Void) { body(); checks += 1; print("PASS \(name)") }
        let untrusted: [AnyHashable: Any] = ["aps": ["alert": ["title": "Unverified sender", "body": "Unverified plaintext"], "sound": "default", "badge": 99], "event": "signed-ciphertext", "market_message_id": "unverified"]
        check("standard fallback is visible, generic and quiet") {
            let content = NativeNotificationDelivery.fallback(filtering: false, userInfo: untrusted)
            precondition(content.title == "Iris Market" && content.body == "New activity")
            precondition(content.subtitle.isEmpty && content.sound == nil && content.badge == nil && content.attachments.isEmpty)
            precondition(content.threadIdentifier.isEmpty && content.categoryIdentifier.isEmpty)
            precondition(content.userInfo["event"] as? String == "signed-ciphertext")
            precondition(content.userInfo["aps"] == nil && content.userInfo["market_message_id"] == nil)
        }
        check("timeout fallback is generic without trusting server fields") {
            let content = NativeNotificationDelivery.fallback(filtering: false)
            precondition(!content.title.isEmpty && !content.body.isEmpty && content.sound == nil && content.userInfo.isEmpty)
        }
        check("empty content requires explicit filtering mode") {
            let content = NativeNotificationDelivery.fallback(filtering: true, userInfo: untrusted)
            precondition(content.title.isEmpty && content.body.isEmpty && content.sound == nil && content.badge == nil && content.userInfo.isEmpty)
        }
        check("local authenticated preview replaces all server visible fields") {
            let content = NativeNotificationDelivery.preview(title: "Local sender", body: "Decrypted locally", thread: "private-thread", messageID: "verified-id", userInfo: untrusted)
            precondition(content.title == "Local sender" && content.body == "Decrypted locally" && content.sound != nil)
            precondition(content.subtitle.isEmpty && content.badge == nil && content.attachments.isEmpty)
            precondition(content.threadIdentifier == "private-thread" && content.userInfo["market_message_id"] as? String == "verified-id")
        }
        check("absent verified message ID removes the server's ID") {
            let content = NativeNotificationDelivery.preview(title: "Local", body: "Local", thread: "private", messageID: nil, userInfo: untrusted)
            precondition(content.userInfo["market_message_id"] == nil)
        }
        check("malformed and oversized metadata never reaches the callback payload") {
            precondition(NativeNotificationDelivery.safeUserInfo(["invalid": Date()]).isEmpty)
            precondition(NativeNotificationDelivery.safeUserInfo(["oversized": String(repeating: "x", count: 65537)]).isEmpty)
        }
        check("resolution and timeout complete exactly once") {
            let completion = NativeNotificationCompletion<Int>()
            let lock = NSLock(); var received: [Int] = []
            completion.prepare { value in lock.lock(); received.append(value); lock.unlock() }
            DispatchQueue.concurrentPerform(iterations: 128) { completion.finish($0) }
            precondition(received.count == 1)
            completion.finish(999)
            precondition(received.count == 1)
        }
        print("Native notification delivery: \(checks) focused checks passed")
    }
}
