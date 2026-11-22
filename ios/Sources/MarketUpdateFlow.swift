#if os(macOS)
import Foundation

/// What Settings → App updates shows. Depends only on Foundation so the
/// flow can be tested without launching the app.
enum MarketUpdateStep: Equatable {
    case idle
    case checking
    case upToDate
    case available(String)
    case fetching
    case downloading(downloaded: UInt64, total: UInt64?)
    case verifying
    case installing
    case restarting
    case restartNeeded(String)
    case updated(String)
    case failed(MarketUpdateFailure)

    var busy: Bool {
        switch self {
        case .checking, .fetching, .downloading, .verifying, .installing, .restarting: true
        default: false
        }
    }

    var status: String? {
        switch self {
        case .idle, .failed: nil
        case .checking: "Checking for updates…"
        case .upToDate: "You’re up to date"
        case .available(let version): "Version \(version) is available"
        case .fetching: "Getting the update…"
        case .downloading(let downloaded, let total?):
            "Downloading… \(Self.megabytes(downloaded)) of \(Self.megabytes(total))"
        case .downloading: "Downloading…"
        case .verifying: "Verifying the update…"
        case .installing: "Installing…"
        case .restarting: "Restarting Iris Market…"
        case .restartNeeded(let version): "Version \(version) is installed. Restart Iris Market to finish."
        case .updated(let version): "Updated to version \(version)"
        }
    }

    /// nil hides the bar; .some(nil) shows a moving bar of unknown length.
    var progress: Double?? {
        switch self {
        case .downloading(let downloaded, let total?) where total > 0:
            .some(min(1, Double(downloaded) / Double(total)))
        case .fetching, .downloading, .verifying, .installing, .restarting: .some(nil)
        default: nil
        }
    }

    static func megabytes(_ bytes: UInt64) -> String {
        let value = Double(bytes) / 1_000_000
        return value < 10 ? String(format: "%.1f MB", value) : String(format: "%.0f MB", value)
    }
}

struct MarketUpdateFailure: Equatable {
    enum Retry: Equatable { case check, install, restart }
    let message: String
    let retry: Retry
    /// Offered when the app cannot replace itself but the download is fine.
    var download: URL?
}

/// Thrown by the installer with a sentence people can act on.
struct MarketUpdateProblem: Error, Equatable {
    let message: String
    /// The archive itself is bad; Retry downloads it again.
    var discardDownload = false
    /// The archive is fine; offer it for a manual install.
    var offerDownload = false
}

struct MarketUpdateInfo: Decodable {
    let latest_version: String
    let available: Bool
    let asset: String
    let verified: Bool
    let path: String?
}

struct MarketUpdateProgress: Decodable, Equatable {
    let stage: String
    let downloaded: UInt64
    let total: UInt64?

    var step: MarketUpdateStep? {
        switch stage {
        case "fetching": .fetching
        case "downloading": .downloading(downloaded: downloaded, total: total)
        case "verifying": .verifying
        default: nil
        }
    }
}

/// The Rust updater as the flow uses it; `progress` must never block.
protocol MarketUpdateService: AnyObject {
    func check() throws -> String
    func download(directory: String) throws -> String
    func progress() -> String
}

struct MarketUpdateEnvironment {
    var version: String
    var makeService: () throws -> MarketUpdateService
    var downloadDirectory: () throws -> URL
    /// Unpacks and checks the signature; returns the app ready to swap in.
    var prepare: (_ archive: URL, _ version: String) throws -> URL
    /// Puts the prepared app in place of the running one.
    var replace: (_ prepared: URL) throws -> Void
    /// Starts the new app once this one has quit, then quits.
    var restart: () throws -> Void
    var reveal: (URL) -> Void
    var defaults: UserDefaults?
    var describe: (Error) -> String
    var background: (@escaping @Sendable () -> Void) -> Void
    var main: (@escaping @MainActor () -> Void) -> Void
    var after: (TimeInterval, @escaping @MainActor () -> Void) -> Void
    var pollInterval: TimeInterval = 0.2
}

@MainActor final class MarketUpdateModel: ObservableObject {
    static let pendingKey = "market.update.pendingVersion"
    @Published private(set) var step: MarketUpdateStep = .idle
    @Published var automatic: Bool {
        didSet { environment.defaults?.set(automatic, forKey: "market.update.automatic") }
    }
    let environment: MarketUpdateEnvironment
    private var service: MarketUpdateService?
    private var latest: String?
    private var archive: URL?
    private var poll: Timer?
    private var attempt = 0

    var version: String { environment.version }
    var busy: Bool { step.busy }

    init(environment: MarketUpdateEnvironment) {
        self.environment = environment
        automatic = environment.defaults?.object(forKey: "market.update.automatic") as? Bool ?? (environment.defaults != nil)
        if let pending = environment.defaults?.string(forKey: Self.pendingKey) {
            environment.defaults?.removeObject(forKey: Self.pendingKey)
            latest = pending
            step = pending == environment.version
                ? .updated(pending)
                : .failed(MarketUpdateFailure(message: "The update to version \(pending) didn’t finish.", retry: .install))
        }
    }

    func checkIfDue(preview: Bool) {
        guard !preview, automatic, !busy, let defaults = environment.defaults else { return }
        if Date().timeIntervalSince1970 - defaults.double(forKey: "market.update.lastAttempt") >= 86_400 { check() }
    }

    func check() {
        guard !busy else { return }
        environment.defaults?.set(Date().timeIntervalSince1970, forKey: "market.update.lastAttempt")
        archive = nil
        step = .checking
        run({ try $0.check() }) { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .success(let info):
                self.latest = info.latest_version
                self.step = info.available ? .available(info.latest_version) : .upToDate
            case .failure(let error):
                self.step = .failed(MarketUpdateFailure(message: self.environment.describe(error), retry: .check))
            }
        }
    }

    /// One press: download with progress, verify, replace and restart.
    func install() {
        guard !busy else { return }
        if let archive, let latest, FileManager.default.fileExists(atPath: archive.path) {
            return installDownloaded(archive, version: latest)
        }
        let directory: URL
        do {
            directory = try environment.downloadDirectory().appendingPathComponent(UUID().uuidString)
        } catch {
            step = .failed(MarketUpdateFailure(message: environment.describe(error), retry: .install))
            return
        }
        step = .fetching
        startPolling()
        run({ try $0.download(directory: directory.path) }) { [weak self] outcome in
            guard let self else { return }
            self.stopPolling()
            switch outcome {
            case .success(let info):
                guard let path = info.path else {
                    self.step = info.available ? .failed(MarketUpdateFailure(message: "The update could not be downloaded.", retry: .install)) : .upToDate
                    return
                }
                self.latest = info.latest_version
                self.archive = URL(fileURLWithPath: path)
                self.installDownloaded(URL(fileURLWithPath: path), version: info.latest_version)
            case .failure(let error):
                self.step = .failed(MarketUpdateFailure(message: self.environment.describe(error), retry: .install))
            }
        }
    }

    func retry() {
        guard case .failed(let failure) = step else { return }
        switch failure.retry {
        case .check: check()
        case .install: install()
        case .restart: restart()
        }
    }

    func restart() {
        guard !busy else { return }
        relaunch()
    }

    private func relaunch() {
        guard let latest else { return }
        environment.defaults?.set(latest, forKey: Self.pendingKey)
        step = .restarting
        attempt += 1
        let current = attempt
        do {
            try environment.restart()
        } catch {
            environment.defaults?.removeObject(forKey: Self.pendingKey)
            step = .failed(MarketUpdateFailure(message: "Iris Market couldn’t restart. Quit and reopen it to finish.", retry: .restart))
            return
        }
        // Quitting can be cancelled; the new version is already in place.
        environment.after(10) { [weak self] in
            guard let self, self.attempt == current, self.step == .restarting else { return }
            self.step = .restartNeeded(latest)
        }
    }

    func showDownload() {
        guard case .failed(let failure) = step, let download = failure.download else { return }
        environment.reveal(download)
    }

    private func installDownloaded(_ archive: URL, version: String) {
        if step != .verifying { step = .verifying }
        let environment = environment
        environment.background {
            let outcome = Result { () throws -> URL in
                let prepared = try environment.prepare(archive, version)
                environment.main { self.step = .installing }
                try environment.replace(prepared)
                return prepared
            }
            environment.main {
                switch outcome {
                case .success:
                    try? FileManager.default.removeItem(at: archive.deletingLastPathComponent())
                    self.archive = nil
                    self.relaunch()
                case .failure(let error as MarketUpdateProblem):
                    if error.discardDownload {
                        try? FileManager.default.removeItem(at: archive.deletingLastPathComponent())
                        self.archive = nil
                    }
                    self.step = .failed(MarketUpdateFailure(message: error.message, retry: .install,
                                                            download: error.offerDownload ? archive : nil))
                case .failure(let error):
                    self.step = .failed(MarketUpdateFailure(message: self.environment.describe(error), retry: .install, download: archive))
                }
            }
        }
    }

    private func run(_ operation: @escaping (MarketUpdateService) throws -> String,
                     completion: @escaping @MainActor (Result<MarketUpdateInfo, Error>) -> Void) {
        let client: MarketUpdateService
        do {
            if service == nil { service = try environment.makeService() }
            client = service!
        } catch {
            completion(.failure(error))
            return
        }
        let environment = environment
        environment.background {
            let outcome = Result { () throws -> MarketUpdateInfo in
                let info = try JSONDecoder().decode(MarketUpdateInfo.self, from: Data(operation(client).utf8))
                guard info.verified else {
                    throw MarketUpdateProblem(message: "The update could not be verified. It was not installed.")
                }
                return info
            }
            environment.main { completion(outcome) }
        }
    }

    /// Reads progress while the download holds the updater on another thread.
    func pollProgress() {
        guard let service, step.busy, step != .verifying else { return }
        guard let progress = try? JSONDecoder().decode(MarketUpdateProgress.self, from: Data(service.progress().utf8)),
              let next = progress.step else { return }
        if next != step { step = next }
    }

    private func startPolling() {
        stopPolling()
        let timer = Timer(timeInterval: environment.pollInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pollProgress() }
        }
        RunLoop.main.add(timer, forMode: .common)
        poll = timer
    }

    private func stopPolling() {
        poll?.invalidate()
        poll = nil
    }
}
#endif
