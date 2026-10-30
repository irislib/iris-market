#if os(iOS)
import Foundation
import UIKit
import UserNotifications

@MainActor
final class MarketPushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static weak var store: MarketStore?
    static var token: String?
    static var pendingTap: String?
    func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]? = nil) -> Bool { UNUserNotificationCenter.current().delegate = self; return true }
    func application(_ application:UIApplication,didRegisterForRemoteNotificationsWithDeviceToken token:Data) {
        Self.token = token.map { String(format:"%02x",$0) }.joined(); Self.store?.syncPush()
    }
    func application(_ application:UIApplication,didFailToRegisterForRemoteNotificationsWithError error:Error) { Self.token = nil }
    func application(_ application:UIApplication,didReceiveRemoteNotification userInfo:[AnyHashable:Any]) async -> UIBackgroundFetchResult {
        guard let payload = Self.payload(userInfo), let store = Self.store else { return .noData }
        await store.receivePush(payload); return .newData
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification) async -> UNNotificationPresentationOptions {
        guard let payload = Self.payload(notification.request.content.userInfo), let store = Self.store else { return [] }
        return await store.receivePush(payload,presenting:true) ? [.banner,.sound,.badge] : []
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse) async {
        if let payload = Self.payload(response.notification.request.content.userInfo) {
            guard let store = Self.store, store.ready else { Self.pendingTap = payload; return }
            await store.receivePush(payload,tapped:true)
        }
    }
    static func payload(_ info:[AnyHashable:Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(info), let data = try? JSONSerialization.data(withJSONObject:info), data.count <= 65536 else { return nil }
        return String(data:data,encoding:.utf8)
    }
}
private final class NativePushSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) { completionHandler(nil) }
}
actor NativePushRuntime {
    private let session = URLSession(configuration:.ephemeral,delegate:NativePushSessionDelegate(),delegateQueue:nil)
    private var signature: String?
    private var lastHTTPStatus: Int?
    private var syncing = false
    private var lastAttempt = Date.distantPast
    func sync(owner:String,filtersJSON:String,enabled:Bool,token:String?) async {
        if !enabled { while syncing { try? await Task.sleep(nanoseconds:100_000_000) } }
        guard !syncing else { return }
        let key = "notifications.subscription.\(owner)", secretKey = "notifications.registration.\(owner)"
        let endpoint = "https://notifications.iris.to"
        let next = "\(owner)|\(enabled)|\(token ?? "")|\(filtersJSON)"
        guard next != signature, !enabled || Date().timeIntervalSince(lastAttempt) >= 10 else { return }
        syncing = true; lastAttempt = Date(); defer { syncing = false }
        do {
            let secret = try SecureStore.read(secretKey) ?? generateSecretKey()
            if try SecureStore.read(secretKey) == nil { try SecureStore.write(secret,account:secretKey) }
            let id = try SecureStore.read(key)
            if !enabled {
                guard let id else { signature = next; return }
                let request = try buildPushRequest(registrationSecret:secret,method:"DELETE",endpoint:endpoint,subscriptionId:id,deliveryJson:nil)
                if await perform(request) != nil || lastHTTPStatus == 404 { try SecureStore.remove(key); signature = next }
                return
            }
            guard let token, let object = try JSONSerialization.jsonObject(with:Data(filtersJSON.utf8)) as? [String:Any], let filters = object["filters"] as? [[String:Any]], !filters.isEmpty else { return }
            let production: Bool
            #if DEBUG
            production = false
            #else
            production = true
            #endif
            let delivery: [String:Any] = ["platform":"ios","token":token,"apns_topic":Bundle.main.bundleIdentifier ?? "to.iris.market","production":production,"filters":filters]
            let deliveryJSON = String(decoding:try JSONSerialization.data(withJSONObject:delivery),as:UTF8.self)
            let request = try buildPushRequest(registrationSecret:secret,method:"POST",endpoint:endpoint,subscriptionId:id,deliveryJson:deliveryJSON)
            var result = await perform(request)
            var created = id == nil
            if result == nil, id != nil, lastHTTPStatus == 404 {
                result = await perform(try buildPushRequest(registrationSecret:secret,method:"POST",endpoint:endpoint,subscriptionId:nil,deliveryJson:deliveryJSON)); created = true
            }
            guard let result else { return }
            if created {
                guard let object = try? JSONSerialization.jsonObject(with:result) as? [String:Any], let created = object["id"] as? String else { return }
                try SecureStore.write(created,account:key)
            }
            signature = next
        } catch { /* Registration is optional; foreground refresh retries without blocking UI. */ }
    }
    private func perform(_ json:String) async -> Data? {
        lastHTTPStatus = nil
        guard let object = try? JSONSerialization.jsonObject(with:Data(json.utf8)) as? [String:Any],let rawURL = object["url"] as? String,let url = URL(string:rawURL),let method = object["method"] as? String,let auth = object["authorization"] as? String else { return nil }
        var request = URLRequest(url:url); request.httpMethod = method; request.timeoutInterval = 10
        request.setValue(auth,forHTTPHeaderField:"Authorization"); request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        request.httpBody = (object["body"] as? String)?.data(using:.utf8)
        guard let (data,response) = try? await session.data(for:request), let response = response as? HTTPURLResponse else { return nil }
        lastHTTPStatus = response.statusCode
        return (200..<300).contains(response.statusCode) && data.count <= 65536 ? data : nil
    }
}
#endif
