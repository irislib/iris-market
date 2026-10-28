import Foundation
import SwiftUI

@MainActor
final class MarketStore: ObservableObject {
    @Published private(set) var snapshot: MarketSnapshot = .empty
    @Published private(set) var ready = false
    @Published private(set) var busy = false
    @Published var alert: String?
    @Published var activeSheetCount = 0
    private let queue = DispatchQueue(label: "to.iris.market.core", qos: .userInitiated)
    private var app: MarketApp?
    private var timer: Timer?
    let demo: Bool

    init(demo: Bool) { self.demo = demo; open() }
    private func open() {
        let demo = self.demo
        queue.async { [weak self] in
            do {
                let credential = demo ? "preview.identity" : "identity"
                let secret: String
                if let existing = try SecureStore.read(credential) { secret = existing }
                else { secret = generateSecretKey(); try SecureStore.write(secret, account: credential) }
                let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                let folder = base.appendingPathComponent(demo ? "IrisMarketPreview" : "IrisMarket", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let app = try MarketApp(dataDir: folder.path, secretKey: secret, demo: demo)
                let snapshot = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(try app.snapshot().utf8))
                Task { @MainActor in
                    guard let self else { return }
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
        queue.async { [weak self] in
            do {
                let next = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(try app.snapshot().utf8))
                Task { @MainActor in self?.snapshot = next }
            } catch { Task { @MainActor in self?.alert = marketErrorMessage(error) } }
        }
    }
    func command(_ value: [String: Any], completion: ((Bool) -> Void)? = nil) {
        guard let app else { return }
        do {
            let request = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
            alert = nil
            busy = true
            queue.async { [weak self] in
                do {
                    let response = try app.command(request: request)
                    let next = try MarketJSON.decoder().decode(MarketSnapshot.self, from: Data(response.utf8))
                    Task { @MainActor in
                        self?.snapshot = next; self?.busy = false
                        if let error = next.error, !error.isEmpty { self?.alert = error; completion?(false) }
                        else { completion?(true) }
                    }
                } catch { Task { @MainActor in self?.busy = false; self?.alert = marketErrorMessage(error); self?.refreshSnapshot(); completion?(false) } }
            }
        } catch { alert = marketErrorMessage(error); completion?(false) }
    }
    func filter(query: String, side: String) { command(["type": "set_filter", "query": query, "side": side]) }
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
}
