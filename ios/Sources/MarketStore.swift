import Foundation
import SwiftUI

@MainActor
final class MarketStore: ObservableObject {
    @Published private(set) var snapshot: MarketSnapshot = .empty
    @Published private(set) var ready = false
    @Published private(set) var busy = false
    @Published var alert: String?
    @Published var activeSheetCount = 0
    @Published private(set) var deviceLinkURL: String?
    private var deviceLink: MarketDeviceLink?
    private var linkingSecret: String?
    private var linkPolling = false
    private var accountGeneration = 0
    private let queue = DispatchQueue(label: "to.iris.market.core", qos: .userInitiated)
    private var app: MarketApp?
    private var timer: Timer?
    let demo: Bool

    init(demo: Bool) { self.demo = demo; open() }
    private func open() {
        let demo = self.demo
        let previous = app
        app = nil; ready = false; stopPolling(); accountGeneration += 1
        let generation = accountGeneration
        queue.async { [weak self] in
            do {
                previous?.shutdown()
                let credential = demo ? "preview.identity" : "identity"
                let secret: String
                if let existing = try SecureStore.read(credential) { secret = existing }
                else { secret = generateSecretKey(); try SecureStore.write(secret, account: credential) }
                let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                let baseFolder = base.appendingPathComponent(demo ? "IrisMarketPreview" : "IrisMarket", isDirectory: true)
                let app: MarketApp
                if !demo, let owner = try SecureStore.read("active.account") {
                    guard let bundle = try NativeAccountBundle.load(owner) else { throw SecureStore.StorageError.status(-25300) }
                    let folder = bundle.legacy ? baseFolder : baseFolder.appendingPathComponent("accounts/\(bundle.ownerPublicKey)", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    app = try MarketApp.withIdentity(dataDir: folder.path, ownerPublicKey: bundle.ownerPublicKey, ownerSecret: bundle.ownerSecret, deviceSecret: bundle.deviceSecret, authorization: bundle.authorization)
                } else {
                    try FileManager.default.createDirectory(at: baseFolder, withIntermediateDirectories: true)
                    app = try MarketApp(dataDir: baseFolder.path, secretKey: secret, demo: demo)
                }
                let initial = try app.command(request: #"{"type":"set_filter","query":"","side":"offer","ai_search":false}"#)
                let snapshot = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(initial.utf8))
                Task { @MainActor in
                    guard let self, self.accountGeneration == generation else { app.shutdown(); return }
                    self.app = app; self.snapshot = snapshot; self.ready = true; self.startPolling()
                }
            } catch { Task { @MainActor in self?.alert = marketErrorMessage(error) } }
        }
    }
    func startPolling() {
        guard ready, timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshSnapshot() }
        }
    }
    func stopPolling() { timer?.invalidate(); timer = nil }
    private func refreshSnapshot() {
        guard let app else { return }
        let generation = accountGeneration
        queue.async { [weak self] in
            do {
                let next = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(try app.snapshot().utf8))
                Task { @MainActor in if self?.accountGeneration == generation { self?.snapshot = next } }
            } catch { Task { @MainActor in self?.alert = marketErrorMessage(error) } }
        }
    }
    func command(_ value: [String: Any], completion: ((Bool) -> Void)? = nil) {
        guard let app else { return }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
            alert = nil
            busy = true
            let generation = accountGeneration
            queue.async { [weak self] in
                do {
                    let response = try app.command(request: request)
                    let next = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(response.utf8))
                    Task { @MainActor in
                        guard self?.accountGeneration == generation else { completion?(false); return }
                        self?.snapshot = next; self?.busy = false
                        if let error = next.error, !error.isEmpty { self?.alert = error; completion?(false) }
                        else { completion?(true) }
                    }
                } catch { Task { @MainActor in self?.busy = false; self?.alert = marketErrorMessage(error); self?.refreshSnapshot(); completion?(false) } }
            }
        } catch { alert = marketErrorMessage(error); completion?(false) }
    }
    func filter(query: String, side: String, aiSearch: Bool = false, completion: ((Bool) -> Void)? = nil) {
        command(["type": "set_filter", "query": query, "side": side, "ai_search": aiSearch], completion: completion)
    }
    func searchAI(query: String, side: String) {
        filter(query: query, side: side, aiSearch: true) { success in if success { self.runAI(type: "curate") } }
    }
    func save(_ listing: MarketListing) { command(["type": "save", "id": listing.id]) }
    func saveSettings(_ settings: MarketSettings, key: String, completion: ((Bool) -> Void)? = nil) {
        do {
            if key.isEmpty { try SecureStore.remove(SecureStore.aiAccount(settings.ai)) }
            else { try SecureStore.write(key, account: SecureStore.aiAccount(settings.ai)) }
            command(["type": "set_settings", "settings": try MarketJSON.object(settings)], completion: completion)
        } catch { alert = marketErrorMessage(error); completion?(false) }
    }
    func runAI(type: String) {
        do { command(["type": type, "api_key": try SecureStore.read(SecureStore.aiAccount(snapshot.settings.ai)) ?? ""]) }
        catch { alert = marketErrorMessage(error) }
    }
    func signIn(secret: String, completion: @escaping (Bool) -> Void) {
        guard !demo, !busy else { return }
        busy = true; alert = nil
        let relays = snapshot.settings.relays
        queue.async { [weak self] in
            do {
                let owner = try publicKeyForSecret(secret: secret)
                let legacy = try SecureStore.read("identity")
                let usesLegacy = try legacy.map { try publicKeyForSecret(secret: $0) == owner } ?? false
                var bundle = try NativeAccountBundle.load(owner) ?? NativeAccountBundle(ownerPublicKey: owner, ownerSecret: secret, deviceSecret: usesLegacy ? legacy! : generateSecretKey(), authorization: nil, legacy: usesLegacy)
                bundle.ownerSecret = secret
                let servers = String(decoding: try JSONEncoder().encode(relays), as: UTF8.self)
                bundle.authorization = try registerIdentityDevice(ownerSecret: secret, deviceSecret: bundle.deviceSecret, relaysJson: servers)
                try bundle.save(); try SecureStore.write(owner, account: "active.account")
                Task { @MainActor in guard let self else { return }; self.busy = false; self.open(); completion(true) }
            } catch { Task { @MainActor in self?.busy = false; self?.alert = marketErrorMessage(error); completion(false) } }
        }
    }
    func beginDeviceLink() {
        guard !demo, !busy else { return }
        busy = true; alert = nil
        queue.async { [weak self] in
            do {
                let secret = try SecureStore.read("device-link.secret") ?? generateSecretKey()
                let link = try MarketDeviceLink(deviceSecret: secret, restoredBootstrap: SecureStore.read("device-link.bootstrap"), approvalRelay: "wss://temp.iris.to")
                try SecureStore.write(secret, account: "device-link.secret")
                try SecureStore.write(link.bootstrap(), account: "device-link.bootstrap")
                let url = try link.invitation()
                Task { @MainActor in self?.deviceLink = link; self?.linkingSecret = secret; self?.deviceLinkURL = url; self?.busy = false }
            } catch { Task { @MainActor in self?.busy = false; self?.alert = marketErrorMessage(error) } }
        }
    }
    func pollDeviceLink() {
        guard !linkPolling, let link = deviceLink, let secret = linkingSecret, deviceLinkURL != nil else { return }
        linkPolling = true
        queue.async { [weak self] in
            do {
                let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("IrisMarket/accounts", isDirectory: true)
                let approval = try link.poll(accountRoot: base.path)
                try SecureStore.write(link.bootstrap(), account: "device-link.bootstrap")
                if let raw = approval, let result = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any], let owner = result["owner_public_key"] as? String, let proof = result["authorization"] {
                    let authorization = String(decoding: try JSONSerialization.data(withJSONObject: proof), as: UTF8.self)
                    let bundle = NativeAccountBundle(ownerPublicKey: owner, ownerSecret: nil, deviceSecret: secret, authorization: authorization, legacy: false)
                    Task { @MainActor in
                        guard let self else { return }; self.linkPolling = false
                        guard self.deviceLink === link, self.deviceLinkURL != nil else { return }
                        do {
                            try bundle.save(); try SecureStore.write(owner, account: "active.account")
                            try SecureStore.remove("device-link.secret"); try SecureStore.remove("device-link.bootstrap")
                            self.deviceLinkURL = nil; self.deviceLink = nil; self.linkingSecret = nil; self.open()
                        } catch { self.alert = marketErrorMessage(error) }
                    }
                } else { Task { @MainActor in self?.linkPolling = false } }
            } catch { Task { @MainActor in self?.linkPolling = false; self?.alert = marketErrorMessage(error) } }
        }
    }
    func closeDeviceLink() { deviceLinkURL = nil; deviceLink = nil; linkingSecret = nil }

}


private struct NativeAccountBundle: Codable {
    var ownerPublicKey: String
    var ownerSecret: String?
    var deviceSecret: String
    var authorization: String?
    var legacy: Bool
    static func load(_ owner: String) throws -> NativeAccountBundle? {
        guard let value = try SecureStore.read("account.\(owner)") else { return nil }
        return try JSONDecoder().decode(Self.self, from: Data(value.utf8))
    }
    func save() throws { try SecureStore.write(String(decoding: JSONEncoder().encode(self), as: UTF8.self), account: "account.\(ownerPublicKey)") }
}
