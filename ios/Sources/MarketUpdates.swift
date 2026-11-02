import SwiftUI

struct MarketUpdateInfo: Decodable {
    let latest_version: String
    let available: Bool
    let asset: String
    let verified: Bool
    let path: String?
}

#if os(macOS)
import AppKit

@MainActor final class MarketUpdateModel: ObservableObject {
    static let shared = MarketUpdateModel()
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "MarketReleaseVersion") as? String ?? "0.1.4-alpha.5" }
    @Published var busy = false
    @Published var downloading = false
    @Published var result: MarketUpdateInfo?
    @Published var message: String?
    @Published var automatic = NativeTestStorage.enabled ? false : (UserDefaults.standard.object(forKey: "market.update.automatic") as? Bool ?? true) {
        didSet { if !NativeTestStorage.enabled { UserDefaults.standard.set(automatic, forKey: "market.update.automatic") } }
    }
    private var updater: MarketUpdater?

    func checkIfDue(preview: Bool) {
        guard !preview, automatic, !busy else { return }
        let last = UserDefaults.standard.double(forKey: "market.update.lastAttempt")
        if Date().timeIntervalSince1970 - last >= 86_400 { check() }
    }

    func check() {
        guard !busy else { return }
        result = nil
        if !NativeTestStorage.enabled { UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "market.update.lastAttempt") }
        perform(download: false) { try $0.check() }
    }

    func download() {
        guard !busy, result?.available == true else { return }
        let directory = ((try? NativeTestStorage.directory()) ?? FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0])
            .appendingPathComponent("Iris Market Updates/\(UUID().uuidString)").path
        perform(download: true) { try $0.download(directory: directory) }
    }

    private func perform(download: Bool, operation: @escaping (MarketUpdater) throws -> String) {
        busy = true; downloading = download; message = nil
        let client: MarketUpdater
        do {
            if updater == nil { updater = MarketUpdater(dataDir: try NativeTestStorage.applicationSupportDirectory().appendingPathComponent("IrisMarket/Updates").path, currentVersion: Self.version) }
            client = updater!
        } catch { busy = false; downloading = false; message = error.localizedDescription; return }
        DispatchQueue.global(qos: .utility).async {
            let outcome = Result { try JSONDecoder().decode(MarketUpdateInfo.self, from: Data(operation(client).utf8)) }
            DispatchQueue.main.async {
                self.busy = false; self.downloading = false
                switch outcome {
                case .success(let info): self.result = info
                case .failure(let error):
                    if case MarketError.Operation(let reason) = error { self.message = reason }
                    else { self.message = error.localizedDescription }
                }
            }
        }
    }

    func showDownload() {
        guard let path = result?.path else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
#endif

struct MarketUpdatesView: View {
    let preview: Bool
    #if os(macOS)
    @StateObject private var updates = MarketUpdateModel.shared
    #endif
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("App updates", systemImage: "arrow.down.app.fill").font(.system(size: 14, weight: .semibold))
            #if os(macOS)
            Text("Version \(MarketUpdateModel.version)").font(.caption).foregroundStyle(MarketTheme.muted)
            Toggle("Check automatically", isOn: $updates.automatic).disabled(preview)
                .accessibilityIdentifier("automaticUpdates")
            if updates.busy {
                Text(updates.downloading ? "Downloading update…" : "Checking for updates…")
            } else if let result = updates.result {
                Text(result.path != nil ? "Update ready to install" : result.available ? "Version \(result.latest_version) is available" : "You’re up to date")
                if result.path != nil {
                    Text("Open the downloaded archive, then move Iris Market to Applications to replace this version.").font(.caption).foregroundStyle(MarketTheme.muted)
                    Button("Show download", action: updates.showDownload).accessibilityIdentifier("showUpdateDownload")
                } else if result.available {
                    Button("Download update", action: updates.download).accessibilityIdentifier("downloadUpdate")
                }
            }
            if let message = updates.message { Text(message).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
            Button("Check for updates", action: updates.check).disabled(preview || updates.busy).accessibilityIdentifier("checkForUpdates")
            #else
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))").font(.caption).foregroundStyle(MarketTheme.muted)
            Text("Updates are managed by TestFlight.").font(.caption).foregroundStyle(MarketTheme.muted)
            Link("Open TestFlight", destination: URL(string: "itms-beta://")!).disabled(preview)
            #endif
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 23))
    }
}
