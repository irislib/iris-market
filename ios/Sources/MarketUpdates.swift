import SwiftUI

#if os(macOS)
import AppKit

extension MarketUpdater: MarketUpdateService {}

extension MarketUpdateModel {
    static let shared = MarketUpdateModel(environment: .live)
}

extension MarketUpdateEnvironment {
    static var live: MarketUpdateEnvironment {
        let version = Bundle.main.object(forInfoDictionaryKey: "MarketReleaseVersion") as? String ?? "0.1.4-alpha.5"
        let installer = MarketAppInstaller.running()
        let updates = { try NativeTestStorage.applicationSupportDirectory().appendingPathComponent("IrisMarket/Updates") }
        return MarketUpdateEnvironment(
            version: version,
            makeService: { MarketUpdater(dataDir: try updates().path, currentVersion: version) },
            downloadDirectory: { try updates().appendingPathComponent("Downloads") },
            prepare: { archive, version in
                #if DEBUG
                Thread.sleep(forTimeInterval: MarketUpdateHarness.pause)
                #endif
                return try installer.prepare(archive: archive, version: version)
            },
            replace: { prepared in
                #if DEBUG
                Thread.sleep(forTimeInterval: MarketUpdateHarness.pause)
                #endif
                try installer.replace(with: prepared)
            },
            restart: {
                try installer.relaunch()
                NSApp.terminate(nil)
            },
            reveal: { NSWorkspace.shared.activateFileViewerSelecting([$0]) },
            defaults: NativeTestStorage.enabled ? nil : .standard,
            describe: { error in
                if case MarketError.Operation(let reason) = error { return reason }
                if let problem = error as? MarketUpdateProblem { return problem.message }
                return error.localizedDescription
            },
            background: { DispatchQueue.global(qos: .utility).async(execute: $0) },
            main: { work in DispatchQueue.main.async { MainActor.assumeIsolated { work() } } },
            after: { delay, work in DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } } })
    }
}

struct MarketUpdateSteps: View {
    @ObservedObject var updates: MarketUpdateModel
    let preview: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Version \(updates.version)").font(.caption).foregroundStyle(MarketTheme.muted)
            Toggle("Check automatically", isOn: $updates.automatic).disabled(preview)
                .accessibilityIdentifier("automaticUpdates")
            if let status = updates.step.status {
                Text(status).accessibilityIdentifier("updateStatus")
            }
            switch updates.step.progress {
            case .some(.some(let fraction)): ProgressView(value: fraction).frame(maxWidth: 320)
            case .some(.none): ProgressView().progressViewStyle(.linear).frame(maxWidth: 320)
            case .none: EmptyView()
            }
            if case .failed(let failure) = updates.step {
                Text(failure.message).font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("updateError")
            }
            HStack(spacing: 10) {
                switch updates.step {
                case .available:
                    Button("Install update", action: updates.install).buttonStyle(.borderedProminent)
                        .disabled(preview).accessibilityIdentifier("installUpdate")
                case .failed(let failure):
                    Button("Retry", action: updates.retry).buttonStyle(.borderedProminent)
                        .disabled(preview).accessibilityIdentifier("retryUpdate")
                    if failure.download != nil {
                        Button("Show download", action: updates.showDownload).accessibilityIdentifier("showUpdateDownload")
                    }
                case .restartNeeded:
                    Button("Restart", action: updates.restart).buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("restartForUpdate")
                default:
                    EmptyView()
                }
                Button("Check for updates", action: updates.check).disabled(preview || updates.busy)
                    .accessibilityIdentifier("checkForUpdates")
            }
        }
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
            MarketUpdateSteps(updates: updates, preview: preview)
            #else
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))").font(.caption).foregroundStyle(MarketTheme.muted)
            Text("Updates are managed by TestFlight.").font(.caption).foregroundStyle(MarketTheme.muted)
            Link("Open TestFlight", destination: URL(string: "itms-beta://")!).disabled(preview)
            #endif
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 23))
    }
}
