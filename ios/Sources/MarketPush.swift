/// Latest valid work per account; no clock is consumed while token/scopes are missing.
struct NativePushCoalescer {
    struct Snapshot: Equatable {
        let owner: String
        let enabled: Bool
        let delivery: String?
        var ready: Bool { !enabled || delivery != nil }
    }
    struct Work { let snapshot: Snapshot; let revision: UInt64; let readyAt: Double }
    private struct Entry {
        var snapshot: Snapshot
        var sequence: UInt64
        var revision: UInt64 = 0
        var completed = false
        var lastAttempt: Double?
        var lastEnabledAttempt: Double?
        var failures = 0
        var retryAt: Double = 0
    }
    private var entries: [String: Entry] = [:]
    mutating func enqueue(_ snapshot: Snapshot, sequence: UInt64, now: Double) {
        if var entry = entries[snapshot.owner] {
            guard sequence > entry.sequence else { return }
            entry.sequence = sequence
            if entry.snapshot != snapshot {
                entry.snapshot = snapshot; entry.revision += 1; entry.completed = false; entry.failures = 0; entry.retryAt = 0
            } else if entry.failures >= 3, now - (entry.lastAttempt ?? now) >= 60 {
                entry.failures = 0; entry.retryAt = 0
            }
            entries[snapshot.owner] = entry
        } else {
            if entries.count >= 64, let idle = entries.first(where: { $0.value.completed && !$0.value.snapshot.enabled })?.key { entries.removeValue(forKey: idle) }
            guard entries.count < 64 else { return }
            entries[snapshot.owner] = Entry(snapshot: snapshot, sequence: sequence)
        }
    }
    func next() -> Work? {
        entries.values.compactMap { entry -> Work? in
            guard !entry.completed, entry.failures < 3, entry.snapshot.ready else { return nil }
            let throttle = entry.snapshot.enabled ? (entry.lastEnabledAttempt.map { $0 + 10 } ?? 0) : 0
            return Work(snapshot: entry.snapshot, revision: entry.revision, readyAt: max(entry.retryAt, throttle))
        }.min { $0.readyAt == $1.readyAt ? $0.snapshot.owner < $1.snapshot.owner : $0.readyAt < $1.readyAt }
    }
    func isCurrent(_ work: Work) -> Bool {
        guard let entry = entries[work.snapshot.owner] else { return false }
        return entry.revision == work.revision && entry.snapshot == work.snapshot
    }
    mutating func begin(_ work: Work, now: Double) -> Bool {
        guard isCurrent(work), work.readyAt <= now, var entry = entries[work.snapshot.owner] else { return false }
        entry.lastAttempt = now
        if work.snapshot.enabled { entry.lastEnabledAttempt = now }
        entries[work.snapshot.owner] = entry; return true
    }
    mutating func finish(_ work: Work, success: Bool, now: Double) {
        guard isCurrent(work), var entry = entries[work.snapshot.owner] else { return }
        if success { entry.completed = true; entry.failures = 0; entry.retryAt = 0 }
        else { entry.failures += 1; entry.retryAt = now + (entry.failures == 1 ? 10 : 30) }
        entries[work.snapshot.owner] = entry
    }
}

#if os(iOS)
import Foundation
import UIKit
import UserNotifications

@MainActor
final class MarketPushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static weak var store: MarketStore?
    static var token: String?
    static var pendingTap: String?
    func application(_ application:UIApplication,didFinishLaunchingWithOptions options:[UIApplication.LaunchOptionsKey:Any]? = nil) -> Bool {
        if NativePushStorage.configured { UNUserNotificationCenter.current().delegate = self }
        return true
    }
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
    private var state = NativePushCoalescer()
    private var lastHTTPStatus: Int?
    private var running = false
    private var worker: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    func sync(owner:String,filtersJSON:String,enabled:Bool,token:String?,sequence:UInt64) {
        guard NativePushStorage.configured, !owner.isEmpty else { return }
        let delivery = enabled ? Self.delivery(filtersJSON:filtersJSON,token:token) : nil
        state.enqueue(.init(owner:owner,enabled:enabled,delivery:delivery),sequence:sequence,now:ProcessInfo.processInfo.systemUptime)
        schedule()
    }
    private static func delivery(filtersJSON:String,token:String?) -> String? {
        guard let token, !token.isEmpty,token.utf8.count <= 4096,!token.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}),
              let data = filtersJSON.data(using:.utf8),data.count <= 4*1024*1024,
              let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              let filters = object["filters"] as? [[String:Any]],!filters.isEmpty,filters.count <= 64 else { return nil }
        let production: Bool
        #if DEBUG
        production = false
        #else
        production = true
        #endif
        let value: [String:Any] = ["platform":"ios","token":token,"apns_topic":Bundle.main.bundleIdentifier ?? "to.iris.market","production":production,"filters":filters]
        return (try? JSONSerialization.data(withJSONObject:value,options:.sortedKeys)).map {String(decoding:$0,as:UTF8.self)}
    }
    private func schedule() {
        guard !running else { return } // The latest snapshot stays queued during HTTP.
        timer?.cancel(); timer = nil
        guard let work = state.next() else { return }
        let delay = max(0,work.readyAt-ProcessInfo.processInfo.systemUptime)
        if delay > 0 {
            timer = Task {
                do { try await Task.sleep(nanoseconds:UInt64(min(delay,60)*1_000_000_000)) } catch { return }
                guard !Task.isCancelled else { return }
                self.timer = nil; self.schedule()
            }
        } else {
            running = true
            worker = Task { await self.run(work) }
        }
    }
    private func run(_ work:NativePushCoalescer.Work) async {
        guard state.begin(work,now:ProcessInfo.processInfo.systemUptime) else { running = false;worker = nil;schedule();return }
        let success = await performWork(work)
        state.finish(work,success:success,now:ProcessInfo.processInfo.systemUptime)
        running = false; worker = nil; schedule()
    }
    private func performWork(_ work:NativePushCoalescer.Work) async -> Bool {
        guard state.isCurrent(work) else { return false }
        let owner = work.snapshot.owner
        let key = "notifications.subscription.\(owner)", secretKey = "notifications.registration.\(owner)"
        let endpoint = "https://notifications.iris.to"
        do {
            let id = try SecureStore.read(key)
            if !work.snapshot.enabled && id == nil { return true }
            let secret = try SecureStore.read(secretKey) ?? generateSecretKey()
            if try SecureStore.read(secretKey) == nil { try SecureStore.write(secret,account:secretKey) }
            if !work.snapshot.enabled {
                let request = try buildPushRequest(registrationSecret:secret,method:"DELETE",endpoint:endpoint,subscriptionId:id,deliveryJson:nil)
                guard await perform(request) != nil || lastHTTPStatus == 404 else { return false }
                try SecureStore.remove(key);return true
            }
            guard let delivery = work.snapshot.delivery else { return false }
            let request = try buildPushRequest(registrationSecret:secret,method:"POST",endpoint:endpoint,subscriptionId:id,deliveryJson:delivery)
            var result = await perform(request)
            var created = id == nil
            if result == nil,id != nil,lastHTTPStatus == 404 {
                result = await perform(try buildPushRequest(registrationSecret:secret,method:"POST",endpoint:endpoint,subscriptionId:nil,deliveryJson:delivery)); created = true
            }
            guard let result else { return false }
            if created {
                guard let object = try? JSONSerialization.jsonObject(with:result) as? [String:Any],let created = object["id"] as? String else { return false }
                // Save obsolete creates too: queued disable must be able to delete them.
                try SecureStore.write(created,account:key)
            }
            return true
        } catch { return false }
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
