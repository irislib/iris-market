import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    override func didReceive(_ request:UNNotificationRequest,withContentHandler handler:@escaping(UNNotificationContent)->Void) {
        lock.lock(); self.handler = handler; lock.unlock()
        guard let credentials = NativePushCredentials.read(),
              JSONSerialization.isValidJSONObject(request.content.userInfo),
              let data = try? JSONSerialization.data(withJSONObject:request.content.userInfo),data.count <= 65536,
              let payload = String(data:data,encoding:.utf8),
              let replay = NativePushPendingFile.appendAndContext(owner:credentials.owner,payload:payload),
              let raw = resolvePushPreview(dataDir:credentials.directory,ownerPublicKey:credentials.owner,deviceSecret:credentials.deviceSecret,payload:replay).data(using:.utf8),
              let resolution = try? JSONDecoder().decode(NativePushResolution.self,from:raw),resolution.show,
              NativePushCredentials.read()?.owner == credentials.owner,
              NativePushReceipts.claim(resolution.notificationID) else { finish(UNNotificationContent()); return }
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        content.title = resolution.title; content.body = resolution.body; content.sound = .default
        content.threadIdentifier = resolution.threadID ?? resolution.peerID ?? "private"
        content.userInfo["market_message_id"] = resolution.messageID
        finish(content)
    }
    override func serviceExtensionTimeWillExpire() { finish(UNNotificationContent()) }
    private func finish(_ content:UNNotificationContent) {
        lock.lock(); let handler = handler; self.handler = nil; lock.unlock(); handler?(content)
    }
}
