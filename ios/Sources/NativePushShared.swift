import Foundation
import Security
import Darwin

struct NativePushRoute: Codable, Equatable {
    let peerID: String
    let threadID: String?
    let orderID: String?
}
struct NativePushResolution: Codable {
    let show: Bool
    let notificationID: String
    let messageID: String?
    let peerID: String?
    let threadID: String?
    let orderID: String?
    let title: String
    let body: String
    enum CodingKeys: String, CodingKey {
        case show, title, body
        case notificationID = "notification_id", messageID = "message_id", peerID = "peer_id", threadID = "thread_id", orderID = "order_id"
    }
    var route: NativePushRoute? { peerID.map { NativePushRoute(peerID: $0, threadID: threadID, orderID: orderID) } }
}
struct NativePushCredentials: Codable {
    let owner: String
    let deviceSecret: String
    let directory: String
    static let service = "to.iris.market.notification-preview"
    private static var accessGroup: String? { NativePushStorage.configured ? Bundle.main.object(forInfoDictionaryKey: "MarketNotificationKeychainGroup") as? String : nil }
    private static var query: [String: Any]? {
        guard let accessGroup, !accessGroup.isEmpty, !accessGroup.contains("$(") else { return nil }
        return [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:service, kSecAttrAccount as String:"active-preview",kSecAttrAccessGroup as String:accessGroup]
    }
    static func read() -> Self? {
        guard var query = query else { return nil }; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }
        return try? JSONDecoder().decode(Self.self, from:data)
    }
    func save() throws {
        guard let query = Self.query else { throw CocoaError(.fileWriteNoPermission) }
        let data = try JSONEncoder().encode(self)
        let changes: [String: Any] = [kSecValueData as String:data, kSecAttrAccessible as String:kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if result == errSecItemNotFound {
            var item = query; changes.forEach { item[$0.key] = $0.value }
            guard SecItemAdd(item as CFDictionary,nil) == errSecSuccess else { throw CocoaError(.fileWriteNoPermission) }
        } else if result != errSecSuccess { throw CocoaError(.fileWriteNoPermission) }
    }
    static func remove() { if let query { SecItemDelete(query as CFDictionary) } }
}
enum NativePushStorage {
    static var configured: Bool { (Bundle.main.object(forInfoDictionaryKey:"MarketPushConfigured") as? String)?.lowercased() == "yes" }
    static let group = "group.to.iris.market"
    static func directory(owner: String) -> URL? {
        guard configured, owner.count == 64, owner.allSatisfy({ $0.isHexDigit }) else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:group)?.appendingPathComponent("accounts/\(owner)", isDirectory:true)
    }
    /// Call only after shutdown released the private writer. Never merge or replace stores.
    static func migrate(from source: URL, owner: String) throws -> URL {
        guard let target = directory(owner:owner) else { throw CocoaError(.fileWriteNoPermission) }
        let source = source.appendingPathComponent("private-messages",isDirectory:true)
        let destination = target.appendingPathComponent("private-messages",isDirectory:true)
        let fm = FileManager.default
        let hasSource = fm.fileExists(atPath:source.path), hasTarget = fm.fileExists(atPath:destination.path)
        guard !(hasSource && hasTarget) else { throw CocoaError(.fileWriteFileExists) }
        try fm.createDirectory(at:target,withIntermediateDirectories:true)
        if hasSource { try fm.moveItem(at:source,to:destination) }
        guard fm.fileExists(atPath:destination.appendingPathComponent("messages.sqlite3").path) else { throw CocoaError(.fileNoSuchFile) }
        try fm.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:destination.path)
        try fm.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:destination.appendingPathComponent("messages.sqlite3").path)
        return target
    }
}

/// Cross-process duplicate receipts contain event IDs only; ratchet storage stays read-only.
enum NativePushReceipts {
    static func claim(_ id:String) -> Bool {
        guard id.count == 64,id.allSatisfy({$0.isHexDigit}),let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:NativePushStorage.group) else { return false }
        let file = root.appendingPathComponent("notification-receipts.json")
        let lock = root.appendingPathComponent("notification-receipts.lock")
        let descriptor = Darwin.open(lock.path,O_CREAT|O_RDWR,S_IRUSR|S_IWUSR)
        guard descriptor >= 0 else { return false }
        defer { flock(descriptor,LOCK_UN); Darwin.close(descriptor) }
        guard flock(descriptor,LOCK_EX|LOCK_NB) == 0 else { return false }
        let data = try? Data(contentsOf:file)
        var ids = data.flatMap { try? JSONDecoder().decode([String].self,from:$0) } ?? []
        guard !ids.contains(id) else { return false }
        ids.append(id)
        guard let data = try? JSONEncoder().encode(Array(ids.suffix(2048))) else { return false }
        do {
            try data.write(to:file,options:.atomic)
            try FileManager.default.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:file.path)
            return true
        } catch { return false }
    }
}

/// A bounded signed-ciphertext journal for cold push delivery. It is independent
/// of the live ratchet writer and contains at most sixteen events / 64 KiB.
enum NativePushPendingFile {
    private static func withQueue<T>(owner:String,_ body:(inout [[String:Any]]) throws -> T) -> T? {
        guard let directory = NativePushStorage.directory(owner:owner), FileManager.default.fileExists(atPath:directory.path) else { return nil }
        let path = directory.appendingPathComponent("push-pending.json")
        let lock = directory.appendingPathComponent("push-pending.lock")
        let descriptor = Darwin.open(lock.path,O_CREAT|O_RDWR,S_IRUSR|S_IWUSR)
        guard descriptor >= 0 else { return nil }; defer { flock(descriptor,LOCK_UN);Darwin.close(descriptor) }
        let deadline = DispatchTime.now().uptimeNanoseconds + 50_000_000
        while flock(descriptor,LOCK_EX|LOCK_NB) != 0 {
            guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }; usleep(1000)
        }
        let data = try? Data(contentsOf:path)
        var events: [[String:Any]] = data.flatMap {try? JSONSerialization.jsonObject(with:$0) as? [[String:Any]]} ?? []
        guard (data?.count ?? 0) <= 65536,events.count <= 16 else { return nil }
        do {
            let result = try body(&events)
            while events.count > 16 { events.removeFirst() }
            var encoded = try JSONSerialization.data(withJSONObject:events)
            while encoded.count > 65536 && !events.isEmpty { events.removeFirst();encoded = try JSONSerialization.data(withJSONObject:events) }
            try encoded.write(to:path,options:.atomic)
            try FileManager.default.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:path.path)
            return result
        } catch { return nil }
    }
    static func appendAndContext(owner:String,payload:String) -> String? {
        guard pushEventId(payload:payload) != nil,let object = try? JSONSerialization.jsonObject(with:Data(payload.utf8)) as? [String:Any],let value = object["event"] ?? object["outer_event"] ?? object["outer_event_json"] ?? object["nostr_event"] ?? object["nostr_event_json"],
              let event: [String:Any] = (value as? [String:Any]) ?? (value as? String).flatMap({try? JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:Any]}) else { return nil }
        return withQueue(owner:owner) { events -> String in
            let id = event["id"] as? String
            if !events.contains(where:{$0["id"] as? String == id}) { events.append(event) }
            while events.count > 16 { events.removeFirst() }
            var replay = events.filter { $0["id"] as? String != id }
            var combined = object; combined.removeValue(forKey:"pending_events");combined["pending_events"] = replay
            var data = try JSONSerialization.data(withJSONObject:combined)
            while data.count > 65536 && !replay.isEmpty { replay.removeFirst();combined["pending_events"] = replay;data = try JSONSerialization.data(withJSONObject:combined) }
            guard data.count <= 65536 else { throw CocoaError(.fileReadTooLarge) }
            return String(decoding:data,as:UTF8.self)
        }
    }
    static func drain(owner:String) -> [String] {
        withQueue(owner:owner) { events in
            let payloads = events.compactMap {try? JSONSerialization.data(withJSONObject:["event":$0])}.map {String(decoding:$0,as:UTF8.self)}
            events.removeAll();return payloads
        } ?? []
    }
}
