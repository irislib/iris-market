import Combine
import XCTest

private struct Failure: Error { let message: String }

private final class FakeService: MarketUpdateService {
    var checks: [Result<String, Error>] = []
    var downloads: [Result<String, Error>] = []
    var progressValues: [String] = []
    var downloadCount = 0
    /// Called mid-download, standing in for the UI's progress timer.
    var duringDownload: () -> Void = {}
    private var progressValue = #"{"stage":"idle","downloaded":0,"total":null}"#

    func check() throws -> String { try checks.removeFirst().get() }
    func download(directory: String) throws -> String {
        downloadCount += 1
        for value in progressValues {
            progressValue = value
            duringDownload()
        }
        return try downloads.removeFirst().get()
    }
    func progress() -> String { progressValue }
}

private func info(_ version: String, available: Bool = true, path: String? = nil) -> String {
    let path = path.map { "\"\($0)\"" } ?? "null"
    return #"{"latest_version":"\#(version)","available":\#(available),"asset":"a.zip","verified":true,"path":\#(path)}"#
}

@MainActor final class MarketUpdateFlowChecks: XCTestCase {
    private var service = FakeService()
    private var steps: [MarketUpdateStep] = []
    private var subscription: AnyCancellable?
    private var restarts = 0
    private var pendingAfter: (@MainActor () -> Void)?
    private var revealed: URL?
    private var prepare: (URL, String) throws -> URL = { archive, _ in archive }
    private var directory: URL!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defaults = UserDefaults(suiteName: "market-update-checks-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func archive() throws -> String {
        let folder = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("iris-market.zip")
        try Data("zip".utf8).write(to: file)
        return file.path
    }

    private func model(version: String = "1.0") -> MarketUpdateModel {
        let environment = MarketUpdateEnvironment(
            version: version,
            makeService: { [unowned self] in service },
            downloadDirectory: { [unowned self] in directory },
            prepare: { [unowned self] in try prepare($0, $1) },
            replace: { _ in },
            restart: { [unowned self] in restarts += 1 },
            reveal: { [unowned self] in revealed = $0 },
            defaults: defaults,
            describe: { ($0 as? Failure)?.message ?? ($0 as? MarketUpdateProblem)?.message ?? "\($0)" },
            background: { $0() },
            main: { work in MainActor.assumeIsolated { work() } },
            after: { [unowned self] _, work in pendingAfter = work })
        let model = MarketUpdateModel(environment: environment)
        subscription = model.$step.dropFirst().sink { [unowned self] in steps.append($0) }
        service.duringDownload = { MainActor.assumeIsolated { model.pollProgress() } }
        return model
    }

    func testInstallShowsEachStepThenRestarts() throws {
        service.checks = [.success(info("2.0"))]
        service.progressValues = [#"{"stage":"fetching","downloaded":0,"total":null}"#,
                                  #"{"stage":"downloading","downloaded":4200000,"total":19400000}"#,
                                  #"{"stage":"verifying","downloaded":19400000,"total":19400000}"#]
        service.downloads = [.success(info("2.0", path: try archive()))]
        let updates = model()
        updates.check()
        XCTAssertEqual(updates.step, .available("2.0"))
        updates.install()
        XCTAssertEqual(steps, [.checking, .available("2.0"), .fetching,
                               .downloading(downloaded: 4_200_000, total: 19_400_000), .verifying,
                               .installing, .restarting])
        XCTAssertEqual(restarts, 1)
        XCTAssertEqual(defaults.string(forKey: MarketUpdateModel.pendingKey), "2.0")
        XCTAssertEqual(MarketUpdateStep.downloading(downloaded: 4_200_000, total: 19_400_000).status,
                       "Downloading… 4.2 MB of 19 MB")
        XCTAssertEqual(steps[3].progress, .some(4_200_000.0 / 19_400_000.0))
        // Quitting was cancelled: say so and offer Restart instead of spinning.
        pendingAfter?()
        XCTAssertEqual(updates.step, .restartNeeded("2.0"))
        updates.restart()
        XCTAssertEqual(restarts, 2)
    }

    func testFailuresSayWhatHappenedAndRetryTheSameStep() throws {
        service.checks = [.failure(Failure(message: "Couldn't check for updates. Check your connection, then retry.")),
                          .success(info("2.0"))]
        service.downloads = [.failure(Failure(message: "The download stopped. Check your connection, then retry.")),
                             .success(info("2.0", path: try archive()))]
        let updates = model()
        updates.check()
        guard case .failed(let checkFailure) = updates.step else { return XCTFail("\(updates.step)") }
        XCTAssertEqual(checkFailure.retry, .check)
        XCTAssertFalse(updates.busy)
        updates.retry()
        XCTAssertEqual(updates.step, .available("2.0"))
        updates.install()
        XCTAssertEqual(updates.step, .failed(MarketUpdateFailure(message: "The download stopped. Check your connection, then retry.", retry: .install)))
        updates.retry()
        XCTAssertEqual(updates.step, .restarting)
        XCTAssertEqual(service.downloadCount, 2)
    }

    func testDamagedDownloadsAreDiscardedAndFetchedAgain() throws {
        service.checks = [.success(info("2.0"))]
        let first = try archive()
        service.downloads = [.success(info("2.0", path: first)), .success(info("2.0", path: try archive()))]
        var attempts = 0
        prepare = { archive, _ in
            attempts += 1
            if attempts == 1 { throw MarketUpdateProblem(message: "The downloaded file is damaged. Retry to download it again.", discardDownload: true) }
            return archive
        }
        let updates = model()
        updates.check()
        updates.install()
        XCTAssertEqual(updates.step, .failed(MarketUpdateFailure(message: "The downloaded file is damaged. Retry to download it again.", retry: .install)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first))
        updates.retry()
        XCTAssertEqual(updates.step, .restarting)
        XCTAssertEqual(service.downloadCount, 2)
    }

    func testAppsThatCannotReplaceThemselvesOfferTheDownload() throws {
        service.checks = [.success(info("2.0"))]
        let file = try archive()
        service.downloads = [.success(info("2.0", path: file))]
        var attempts = 0
        prepare = { archive, _ in
            attempts += 1
            if attempts == 1 { throw MarketUpdateProblem(message: "Move Iris Market to your Applications folder, then retry.", offerDownload: true) }
            return archive
        }
        let updates = model()
        updates.check()
        updates.install()
        guard case .failed(let failure) = updates.step else { return XCTFail("\(updates.step)") }
        XCTAssertEqual(failure.download?.path, file)
        updates.showDownload()
        XCTAssertEqual(revealed?.path, file)
        // Retry reuses the verified download.
        updates.retry()
        XCTAssertEqual(updates.step, .restarting)
        XCTAssertEqual(service.downloadCount, 1)
    }

    func testPressesWhileBusyAreIgnored() throws {
        service.checks = [.success(info("2.0"))]
        let updates = model()
        updates.check()
        service.progressValues = [#"{"stage":"downloading","downloaded":1,"total":8}"#]
        service.duringDownload = {
            MainActor.assumeIsolated {
                updates.pollProgress()
                updates.check()
                updates.install()
                updates.retry()
            }
        }
        service.downloads = [.failure(Failure(message: "stopped"))]
        updates.install()
        XCTAssertEqual(service.downloadCount, 1)
        XCTAssertEqual(steps.filter { $0 == .checking }.count, 1)
    }

    func testTheNextLaunchSaysWhetherTheUpdateFinished() {
        defaults.set("2.0", forKey: MarketUpdateModel.pendingKey)
        XCTAssertEqual(model(version: "2.0").step, .updated("2.0"))
        XCTAssertNil(defaults.string(forKey: MarketUpdateModel.pendingKey))
        defaults.set("2.0", forKey: MarketUpdateModel.pendingKey)
        let unfinished = model(version: "1.0")
        guard case .failed(let failure) = unfinished.step else { return XCTFail("\(unfinished.step)") }
        XCTAssertEqual(failure.retry, .install)
        XCTAssertEqual(MarketUpdateStep.updated("2.0").status, "Updated to version 2.0")
    }
}
