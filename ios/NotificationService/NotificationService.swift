import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let completion = NativeNotificationCompletion<UNNotificationContent>()
    private var filtering: Bool { (Bundle.main.object(forInfoDictionaryKey: "MarketNotificationFilteringConfigured") as? String)?.lowercased() == "yes" }
    override func didReceive(_ request:UNNotificationRequest,withContentHandler handler:@escaping(UNNotificationContent)->Void) {
        completion.prepare(handler)
        guard let credentials = NativePushCredentials.read(),
              JSONSerialization.isValidJSONObject(request.content.userInfo),
              let data = try? JSONSerialization.data(withJSONObject:request.content.userInfo),data.count <= 65536,
              let payload = String(data:data,encoding:.utf8),
              let replay = NativePushPendingFile.appendAndContext(owner:credentials.owner,payload:payload),
              let raw = resolvePushPreview(dataDir:credentials.directory,ownerPublicKey:credentials.owner,deviceSecret:credentials.deviceSecret,payload:replay).data(using:.utf8),
              let resolution = try? JSONDecoder().decode(NativePushResolution.self,from:raw),resolution.show,
              NativePushCredentials.read()?.owner == credentials.owner,
              NativePushReceipts.claim(resolution.notificationID) else {
            completion.finish(NativeNotificationDelivery.fallback(filtering: filtering, userInfo: request.content.userInfo)); return
        }
        completion.finish(NativeNotificationDelivery.preview(title: resolution.title, body: resolution.body,
            thread: resolution.threadID ?? resolution.peerID ?? "private", messageID: resolution.messageID, userInfo: request.content.userInfo))
    }
    override func serviceExtensionTimeWillExpire() { completion.finish(NativeNotificationDelivery.fallback(filtering: filtering)) }
}
