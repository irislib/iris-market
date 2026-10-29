import Foundation
import SwiftUI

@MainActor
final class MarketStore: ObservableObject {
    @Published private(set) var snapshot: MarketSnapshot = .empty
    @Published private(set) var ready = false
    @Published private(set) var busy = false
    @Published var alert: String?
    @Published var activeSheetCount = 0
    @Published var activeOrderID: String?
    @Published private(set) var deviceLinkURL: String?
    private var deviceLink: MarketDeviceLink?
    private var linkingSecret: String?
    private var linkPolling = false
    private var accountGeneration = 0
    private let aiIntentGate = NativeAIIntentGate()
    private let aiPreferenceQueue = DispatchQueue(label: "to.iris.market.ai-preference", qos: .userInitiated)
    private var operationCount = 0
    var aiIntentEpoch: Int { aiIntentGate.current }
    private let queue = DispatchQueue(label: "to.iris.market.core", qos: .userInitiated)
    private let enrollmentQueue = DispatchQueue(label: "to.iris.market.enrollment", qos: .utility)
    private var app: MarketApp?
    private var timer: Timer?
    private var localAITask: Task<Void, Never>?
    private var localAIRequest = UUID()
    @Published private(set) var localAIProgress: String?
    @Published private(set) var localAIStatus: String?
    var aiPreferencesEditing = false
    private var initializingLocalAI = false
    private var localAIDefault = NativeLocalAIDefault()
    private let appleAvailability: () -> String?
    @Published private(set) var appleAIUnavailableReason: String?
    let demo: Bool

    init(demo: Bool, appleAvailability: @escaping () -> String? = { OnDeviceAI.unavailableReason }) {
        self.demo = demo; self.appleAvailability = appleAvailability
        self.appleAIUnavailableReason = appleAvailability(); open()
    }
    var aiSearchEnabled: Bool {
        let ai = snapshot.settings.ai
        return NativeAIReadiness.isOn(enabled: ai.enabled, provider: ai.provider, model: ai.model, endpoint: ai.baseUrl, localAvailable: appleAIUnavailableReason == nil, preview: demo)
    }
    var aiSearchStateLabel: String {
        snapshot.settings.ai.enabled ? (aiSearchEnabled ? "On" : "On, unavailable") : "Off"
    }
    private func acceptSnapshot(_ next: MarketSnapshot) {
        if next.revision >= snapshot.revision { snapshot = next }
    }
    func refreshAIAvailability() {
        appleAIUnavailableReason = appleAvailability()
        offerLocalAIDefault()
    }
    func toggleAI(openSettings: @escaping () -> Void) {
        guard ready else { return }
        let ai = snapshot.settings.ai
        let action = NativeAIReadiness.tapAction(enabled: ai.enabled,
            ready: NativeAIReadiness.canEnable(provider: ai.provider, model: ai.model, endpoint: ai.baseUrl, localAvailable: appleAIUnavailableReason == nil, preview: demo),
            localFallback: appleAIUnavailableReason == nil && NativeAIReadiness.canSelectLocalOnTap(provider: ai.provider, model: ai.model, endpoint: ai.baseUrl))
        if action == .settings { openSettings(); return }
        if busy && action != .off { return }
        let enabling = action != .off
        let epoch = aiIntentGate.advance()
        if !enabling { cancelLocalAI(); disableAI(epoch: epoch); return }
        var settings = snapshot.settings
        if action == .local { settings.ai.provider = "apple"; settings.ai.model = "apple-system"; settings.ai.baseUrl = "" }
        settings.ai.enabled = enabling
        saveSettings(settings, key: "", replaceKey: false, expectedAIIntent: epoch) { success in
            if success { self.filter(query: self.snapshot.query, side: self.snapshot.side, aiSearch: enabling) }
        }
    }
    private func disableAI(epoch: Int) {
        guard let app else { return }
        let generation = accountGeneration, gate = aiIntentGate
        operationCount += 1; busy = true
        aiPreferenceQueue.async { [weak self] in
            do {
                let next = try gate.perform(at: epoch) { () throws -> MarketSnapshot in
                    let fresh = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(try app.snapshot().utf8))
                    var settings = fresh.settings; settings.ai.enabled = false
                    let request = String(decoding: try JSONSerialization.data(withJSONObject: ["type": "set_settings", "settings": try MarketJSON.object(settings)]), as: UTF8.self)
                    return try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(try app.command(request: request).utf8))
                }
                Task { @MainActor in
                    guard let self, self.accountGeneration == generation else { return }
                    self.operationCount -= 1; self.busy = self.operationCount > 0
                    if let next { self.acceptSnapshot(next); if let error = next.error { self.alert = error } }
                }
            } catch { Task { @MainActor in
                guard let self, self.accountGeneration == generation else { return }
                self.operationCount -= 1; self.busy = self.operationCount > 0; self.alert = marketErrorMessage(error)
            } }
        }
    }
    private func open() {
        let demo = self.demo
        localAIRequest = UUID(); localAITask?.cancel(); localAITask = nil; localAIProgress = nil; localAIStatus = nil
        let previous = app
        app = nil; ready = false; activeOrderID = nil; stopPolling(); accountGeneration += 1; operationCount = 0; busy = false
        _ = aiIntentGate.advance()
        let generation = accountGeneration
        queue.async { [weak self] in
            do {
                previous?.shutdown()
                let credential = "identity"
                let secret: String
                if demo { secret = generateSecretKey() }
                else if let existing = try SecureStore.read(credential) { secret = existing }
                else {
                    secret = generateSecretKey()
                    if !demo { try SecureStore.write(try publicKeyForSecret(secret: secret), account: "identity.bootstrap") }
                    try SecureStore.write(secret, account: credential)
                }
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
                    if !demo, try SecureStore.read("identity.bootstrap") == publicKeyForSecret(secret: secret) {
                        app = try MarketApp.freshProfile(dataDir: baseFolder.path, secretKey: secret)
                        try SecureStore.remove("identity.bootstrap")
                    } else { app = try MarketApp(dataDir: baseFolder.path, secretKey: secret, demo: demo) }
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
        guard ready else { return }
        refreshAIAvailability()
        guard timer == nil else { return }
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
                Task { @MainActor in if self?.accountGeneration == generation { self?.acceptSnapshot(next); self?.refreshAIAvailability() } }
            } catch { Task { @MainActor in self?.alert = marketErrorMessage(error) } }
        }
    }
    func command(_ value: [String: Any], expectedAIIntent: Int? = nil, urgentPreference: Bool = false, publishExpiry: NativeListingExpiry? = nil, completion: ((Bool) -> Void)? = nil) {
        guard let app else { return }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
            alert = nil
            operationCount += 1; busy = true
            let generation = accountGeneration
            let gate = aiIntentGate
            let epoch = value["type"] as? String == "set_settings" ? (expectedAIIntent ?? gate.current) : nil
            let inferenceEpoch = ["curate", "check_ai"].contains(value["type"] as? String ?? "") ? gate.current : nil
            let commandQueue = urgentPreference ? aiPreferenceQueue : queue
            commandQueue.async { [weak self] in
                do {
                    let request: String = try {
                        guard let publishExpiry, var publish = try JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any], publish["type"] as? String == "publish", var draft = publish["draft"] as? [String: Any] else { return request }
                        draft["expires_at"] = publishExpiry.deadline(publishedAt: Int64(Date().timeIntervalSince1970)).map { $0 as Any } ?? NSNull()
                        publish["draft"] = draft
                        return String(decoding: try JSONSerialization.data(withJSONObject: publish), as: UTF8.self)
                    }()
                    let response: String
                    if let epoch {
                        guard let result = try gate.perform(at: epoch, { () throws -> String in
                            if var merged = try JSONSerialization.jsonObject(with: Data(request.utf8)) as? [String: Any], var preferences = merged["settings"] as? [String: Any] {
                                let fresh = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(try app.snapshot().utf8))
                                if expectedAIIntent == nil {
                                    preferences["ai"] = try MarketJSON.object(fresh.settings.ai)
                                } else {
                                    var latest = try MarketJSON.object(fresh.settings) as! [String: Any]
                                    latest["ai"] = preferences["ai"]; preferences = latest
                                }
                                merged["settings"] = preferences
                                return try app.command(request: String(decoding: try JSONSerialization.data(withJSONObject: merged), as: UTF8.self))
                            }
                            return try app.command(request: request)
                        }) else {
                            Task { @MainActor in
                                guard let self, self.accountGeneration == generation else { completion?(false); return }
                                self.operationCount -= 1; self.busy = self.operationCount > 0; completion?(false)
                            }; return
                        }
                        response = result
                    } else { response = try app.command(request: request) }
                    let next = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(response.utf8))
                    Task { @MainActor in
                        guard self?.accountGeneration == generation else { completion?(false); return }
                        self?.acceptSnapshot(next); self?.operationCount -= 1; self?.busy = (self?.operationCount ?? 0) > 0
                        if let error = next.error, !error.isEmpty { self?.alert = error; completion?(false) }
                        else { completion?(true) }
                    }
                } catch { Task { @MainActor in
                    guard let self, self.accountGeneration == generation else { completion?(false); return }
                    self.operationCount -= 1; self.busy = self.operationCount > 0
                    if inferenceEpoch == nil || inferenceEpoch == self.aiIntentEpoch { self.alert = marketErrorMessage(error); self.refreshSnapshot() }
                    completion?(false)
                } }
            }
        } catch { alert = marketErrorMessage(error); completion?(false) }
    }
    func filter(query: String, side: String, aiSearch: Bool = false, completion: ((Bool) -> Void)? = nil) {
        if localAIProgress != nil && (query != snapshot.query || side != snapshot.side || aiSearch != snapshot.aiSearch) { cancelLocalAI() }
        command(["type": "set_filter", "query": query, "side": side, "ai_search": aiSearch], completion: completion)
    }
    func searchAI(query: String, side: String) {
        filter(query: query, side: side, aiSearch: true) { success in if success { self.runAI(type: "curate") } }
    }
    func save(_ listing: MarketListing) { command(["type": "save", "id": listing.id]) }
    func requestOrder(_ listing: MarketListing, quantity: Int, note: String, completion: @escaping (Bool) -> Void) {
        let existing = Set(snapshot.orders.map(\.id))
        command(["type": "request_order", "listing_id": listing.id, "quantity": quantity, "note": note]) { success in
            if success {
                self.activeOrderID = self.snapshot.orders.first { !existing.contains($0.id) && $0.buyer == self.snapshot.publicKey && $0.items.contains { $0.id == listing.id } }?.id
            }
            completion(success)
        }
    }
    func updateOrder(_ id: String, patch: [String: Any], completion: ((Bool) -> Void)? = nil) {
        command(["type": "update_order", "order_id": id, "patch": patch], completion: completion)
    }
    func archiveOrder(_ order: MarketOrder, completion: ((Bool) -> Void)? = nil) {
        command(["type": "archive_order", "order_id": order.id, "archived": !order.archived], completion: completion)
    }
    @discardableResult
    func saveSettings(_ settings: MarketSettings, key: String, replaceKey: Bool = true, expectedAIIntent: Int? = nil, completion: ((Bool) -> Void)? = nil) -> Int? {
        if localAIProgress != nil { cancelLocalAI() }
        do {
            if let expectedAIIntent, expectedAIIntent != aiIntentEpoch { completion?(false); return nil }
            if !demo && replaceKey {
                guard try aiIntentGate.perform(at: expectedAIIntent ?? aiIntentEpoch, { () throws -> Bool in
                    if key.isEmpty { try SecureStore.remove(SecureStore.aiAccount(settings.ai)) }
                    else { try SecureStore.write(key, account: SecureStore.aiAccount(settings.ai)) }
                    return true
                }) != nil else { completion?(false); return nil }
            }
            if let expectedAIIntent, expectedAIIntent != aiIntentEpoch { completion?(false); return nil }
            let turningOff = snapshot.settings.ai.enabled && !settings.ai.enabled
            let epoch = turningOff ? aiIntentGate.advance() : expectedAIIntent
            command(["type": "set_settings", "settings": try MarketJSON.object(settings)], expectedAIIntent: epoch, urgentPreference: turningOff, completion: completion)
            return epoch
        } catch { alert = marketErrorMessage(error); completion?(false); return nil }
    }
    private func offerLocalAIDefault() {
        guard !busy, !initializingLocalAI,
              localAIDefault.shouldOffer(owner: snapshot.publicKey, configured: snapshot.aiConfigured != false, available: appleAIUnavailableReason == nil, editing: aiPreferencesEditing, preview: demo) else { return }
        initializingLocalAI = true
        var settings = snapshot.settings
        settings.ai.enabled = true; settings.ai.provider = "apple"; settings.ai.baseUrl = ""; settings.ai.model = "apple-system"
        settings.ai.curateFeed = false; settings.ai.interests = ""
        saveSettings(settings, key: "", replaceKey: false, expectedAIIntent: aiIntentEpoch) { [weak self] _ in self?.initializingLocalAI = false }
    }
    func runAI(type: String) {
        guard !busy else { return }
        if snapshot.settings.ai.provider == "apple" { runOnDeviceAI(check: type == "check_ai"); return }
        do { command(["type": type, "api_key": demo ? "" : try SecureStore.read(SecureStore.aiAccount(snapshot.settings.ai)) ?? ""]) }
        catch { alert = marketErrorMessage(error) }
    }
    func cancelLocalAI() {
        localAIRequest = UUID(); localAITask?.cancel(); localAITask = nil; localAIProgress = nil; localAIStatus = nil
        if let batch = snapshot.localCuration { command(["type": "cancel_local_curation", "id": batch.id]) }
    }
    private func runOnDeviceAI(check: Bool) {
        guard snapshot.settings.ai.enabled else { alert = "Enable AI in settings first."; return }
        guard localAITask == nil, localAIProgress == nil else { return }
        if let reason = OnDeviceAI.unavailableReason { alert = reason; return }
        localAIStatus = nil
        let request = UUID(); localAIRequest = request
        if check {
            let started = Date()
            localAIProgress = "Testing on-device model…"
            localAITask = Task { [weak self] in
                defer { if self?.localAIRequest == request { self?.localAIProgress = nil; self?.localAITask = nil } }
                do {
                    let matched = try await OnDeviceAI.matches(interests: "A bicycle", listing: ["title": "City bicycle", "description": "A working bicycle for sale"])
                    let mismatched = try await OnDeviceAI.matches(interests: "A bicycle", listing: ["title": "Office desk", "description": "Wooden desk for a home office"])
                    guard let self, !Task.isCancelled, self.localAIRequest == request else { return }
                    if matched && !mismatched { self.localAIStatus = String(format: "On-device model ready · %.1f s", Date().timeIntervalSince(started)) }
                    else { self.alert = "The model ran, but did not pass the relevance check." }
                } catch { if !Task.isCancelled && self?.localAIRequest == request { self?.alert = "The on-device model could not finish. Listings remain visible." } }
            }
            return
        }
        let generation = accountGeneration
        localAIProgress = "Preparing listings…"
        command(["type": "begin_local_curation"]) { [weak self] success in
            guard let self, self.localAIRequest == request else { return }
            guard success, let batch = self.snapshot.localCuration else { self.localAIProgress = nil; return }
            let started = Date()
            self.localAITask = Task { [weak self] in
                defer { if self?.localAIRequest == request { self?.localAIProgress = nil; self?.localAITask = nil } }
                var decisions: [[String: Any]] = []
                do {
                    for (index, candidate) in batch.candidates.enumerated() {
                        try Task.checkCancellation()
                        guard Date().timeIntervalSince(started) < 240 else { throw OnDeviceAI.Unavailable(message: "This search took too long.") }
                        guard let self, self.accountGeneration == generation, self.snapshot.localCuration?.id == batch.id else { return }
                        self.localAIProgress = "Reviewing \(index + 1) of \(batch.candidates.count)…"
                        let l = candidate.listing
                        let show = try await OnDeviceAI.matches(interests: batch.interests, listing: ["title": l.title, "description": String(l.description.prefix(2000)), "side": l.side, "price": l.price, "currency": l.currency, "location": l.location, "category": l.category])
                        decisions.append(["event_id": candidate.eventId, "show": show, "reason": show ? "Matches your search" : "Does not match your search"])
                    }
                    guard let self, !Task.isCancelled, self.accountGeneration == generation, self.snapshot.localCuration?.id == batch.id else { return }
                    self.command(["type": "apply_local_curation", "id": batch.id, "decisions": decisions])
                } catch {
                    guard let self, self.accountGeneration == generation else { return }
                    let wasCancelled = Task.isCancelled
                    self.command(["type": "cancel_local_curation", "id": batch.id]) { _ in
                        if !wasCancelled && self.localAIRequest == request { self.alert = "The on-device model could not finish. Listings remain visible." }
                    }
                }
            }
        }
    }
    func signIn(secret: String, completion: @escaping (Bool) -> Void) {
        guard !demo, !busy else { return }
        busy = true; alert = nil
        let relays = snapshot.settings.relays
        let attempt = accountGeneration
        queue.async { [weak self] in
            do {
                let owner = try publicKeyForSecret(secret: secret)
                let legacy = try SecureStore.read("identity")
                let usesLegacy = try legacy.map { try publicKeyForSecret(secret: $0) == owner } ?? false
                var bundle = try NativeAccountBundle.load(owner) ?? NativeAccountBundle(ownerPublicKey: owner, ownerSecret: secret, deviceSecret: usesLegacy ? legacy! : generateSecretKey(), authorization: nil, legacy: usesLegacy)
                bundle.ownerSecret = secret
                let saved = bundle
                let servers = String(decoding: try JSONEncoder().encode(relays), as: UTF8.self)
                Task { @MainActor in
                    guard let self, self.accountGeneration == attempt else { completion(false); return }
                    do {
                        // A profile is usable locally before any server replies.
                        try saved.save(); try SecureStore.write(owner, account: "active.account")
                        self.busy = false; self.open()
                        let generation = self.accountGeneration
                        completion(true)
                        self.enrollmentQueue.async { [weak self] in
                            do {
                                let proof = try registerIdentityDevice(ownerSecret: secret, deviceSecret: saved.deviceSecret, relaysJson: servers)
                                Task { @MainActor in
                                    guard let self, self.accountGeneration == generation else { return }
                                    do {
                                        guard try SecureStore.read("active.account") == owner,
                                              var current = try NativeAccountBundle.load(owner),
                                              current.deviceSecret == saved.deviceSecret else { return }
                                        current.authorization = proof; try current.save()
                                        // The core's isolated owner-roster stream verifies the
                                        // published proof. Never force messagingReady in the UI.
                                        self.refreshSnapshot()
                                    } catch { self.alert = "Your profile is ready, but device approval could not be saved. Sign in again to retry." }
                                }
                            } catch {
                                Task { @MainActor in
                                    guard let self, self.accountGeneration == generation,
                                          (try? SecureStore.read("active.account")) == owner else { return }
                                    self.alert = "Your profile is ready. Private messaging is waiting for device approval; sign in again to retry."
                                }
                            }
                        }
                    } catch { self.busy = false; self.alert = marketErrorMessage(error); completion(false) }
                }
            } catch {
                Task { @MainActor in
                    guard let self, self.accountGeneration == attempt else { completion(false); return }
                    self.busy = false; self.alert = marketErrorMessage(error); completion(false)
                }
            }
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
