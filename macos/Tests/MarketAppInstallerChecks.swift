import Security
import XCTest

/// Exercises the real unpack, signature check and bundle swap in a private
/// folder. The release fixture takes an archive, version and independently
/// trusted team through the TEST_RUNNER_MARKET_UPDATE_* environment variables.
final class MarketAppInstallerChecks: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("market-installer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.appendingPathComponent("Locked").path)
        try? FileManager.default.removeItem(at: root)
    }

    private func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "\(tool) \(arguments)")
    }

    /// A tiny ad-hoc signed app, like a development build.
    private func app(in folder: URL, version: String) throws -> URL {
        let app = folder.appendingPathComponent("IrisMarket.app")
        let macOS = app.appendingPathComponent("Contents/MacOS")
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        try FileManager.default.copyItem(atPath: "/usr/bin/true", toPath: macOS.appendingPathComponent("IrisMarket").path)
        let plist: NSDictionary = ["CFBundleIdentifier": "to.iris.market", "CFBundleExecutable": "IrisMarket",
                                   "CFBundlePackageType": "APPL", "MarketReleaseVersion": version]
        plist.write(to: app.appendingPathComponent("Contents/Info.plist"), atomically: true)
        try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
        return app
    }

    private func zip(_ app: URL) throws -> URL {
        let archive = root.appendingPathComponent("update-\(UUID().uuidString).zip")
        try run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app.path, archive.path])
        return archive
    }

    private func version(of app: URL) -> String? {
        NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["MarketReleaseVersion"] as? String
    }

    private func problem(_ work: () throws -> Void) -> MarketUpdateProblem? {
        do { try work(); return nil } catch { return error as? MarketUpdateProblem }
    }

    func testRefusesWhereTheAppCannotReplaceItself() throws {
        let applications = root.appendingPathComponent("Applications")
        try FileManager.default.createDirectory(at: applications, withIntermediateDirectories: true)
        let current = try app(in: applications, version: "1.0")
        let archive = try zip(try app(in: root.appendingPathComponent("New"), version: "2.0"))

        let development = MarketAppInstaller(current: current, identifier: "to.iris.market", team: nil)
        XCTAssertEqual(problem { _ = try development.prepare(archive: archive, version: "2.0") }?.offerDownload, true)

        let translocated = MarketAppInstaller(current: URL(fileURLWithPath: "/private/var/folders/x/AppTranslocation/ABC/d/IrisMarket.app"),
                                              identifier: "to.iris.market", team: "TEAM")
        XCTAssertEqual(problem { _ = try translocated.prepare(archive: archive, version: "2.0") }?.message,
                       "Move Iris Market to your Applications folder, then retry.")

        let locked = root.appendingPathComponent("Locked")
        try FileManager.default.createDirectory(at: locked, withIntermediateDirectories: true)
        let lockedApp = try app(in: locked, version: "1.0")
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: locked.path)
        let readOnly = MarketAppInstaller(current: lockedApp, identifier: "to.iris.market", team: "TEAM")
        let refused = problem { _ = try readOnly.prepare(archive: archive, version: "2.0") }
        XCTAssertEqual(refused?.offerDownload, true)
        XCTAssertEqual(refused?.discardDownload, false)
        XCTAssertEqual(version(of: lockedApp), "1.0")
    }

    func testDamagedOrUnsignedUpdatesAreRefusedAndTheAppIsUntouched() throws {
        let current = try app(in: root.appendingPathComponent("Applications"), version: "1.0")
        let installer = MarketAppInstaller(current: current, identifier: "to.iris.market", team: "TEAM")

        let damaged = root.appendingPathComponent("damaged.zip")
        try Data("not a zip".utf8).write(to: damaged)
        XCTAssertEqual(problem { _ = try installer.prepare(archive: damaged, version: "2.0") }?.discardDownload, true)

        let adHoc = try zip(try app(in: root.appendingPathComponent("New"), version: "2.0"))
        let unsigned = problem { _ = try installer.prepare(archive: adHoc, version: "2.0") }
        XCTAssertEqual(unsigned?.discardDownload, true)
        XCTAssertTrue(unsigned?.message.contains("isn’t signed") == true)

        let wrongVersion = problem { _ = try installer.prepare(archive: adHoc, version: "3.0") }
        XCTAssertTrue(wrongVersion?.message.contains("isn’t the expected update") == true)
        XCTAssertEqual(version(of: current), "1.0")
    }

    func testReleaseArchiveReplacesTheAppInPlace() throws {
        let environment = ProcessInfo.processInfo.environment
        let keys = ["MARKET_UPDATE_ARCHIVE", "MARKET_UPDATE_VERSION", "MARKET_UPDATE_TEAM"]
        guard keys.contains(where: { environment[$0] != nil }) else {
            throw XCTSkip("No signed release fixture was configured")
        }
        func required(_ key: String) throws -> String {
            try XCTUnwrap(environment[key].flatMap { $0.isEmpty ? nil : $0 }, "Missing \(key) for the signed release fixture")
        }
        let path = try required("MARKET_UPDATE_ARCHIVE")
        let expected = try required("MARKET_UPDATE_VERSION")
        let expectedTeam = try required("MARKET_UPDATE_TEAM")
        let current = try app(in: root.appendingPathComponent("Applications"), version: "0.0.1")
        let installer = MarketAppInstaller(current: current, identifier: "to.iris.market", team: expectedTeam)
        XCTAssertNotNil(problem { _ = try installer.prepare(archive: URL(fileURLWithPath: path), version: "0.0.2") })
        let prepared = try installer.prepare(archive: URL(fileURLWithPath: path), version: expected)
        try installer.replace(with: prepared)
        XCTAssertEqual(version(of: current), expected)
        try MarketAppInstaller.verify(app: current, identifier: "to.iris.market", team: expectedTeam)
        XCTAssertFalse(FileManager.default.fileExists(atPath: prepared.deletingLastPathComponent().path))
    }

    func testDeveloperIDRequirementRequiresBothCertificateMarkers() throws {
        let requirement = try XCTUnwrap(MarketAppInstaller.developerIDRequirement(identifier: "to.iris.market", team: "TEAM"))
        var string: CFString?
        XCTAssertEqual(SecRequirementCopyString(requirement, [], &string), errSecSuccess)
        let clauses = try XCTUnwrap(string as String?).components(separatedBy: " and ")
        XCTAssertEqual(clauses.count, 5)
        XCTAssertTrue(clauses.contains { $0.hasPrefix("certificate 1[field.1.2.840.113635.100.6.2.6]") })
        XCTAssertTrue(clauses.contains { $0.hasPrefix("certificate leaf[field.1.2.840.113635.100.6.1.13]") })
    }

    func testRelaunchWaitsForTheOldProcessToExit() throws {
        let waiting = Process()
        waiting.executableURL = URL(fileURLWithPath: "/bin/sleep")
        waiting.arguments = ["1"]
        try waiting.run()
        // `open` on a missing bundle fails harmlessly; only the waiting matters.
        let installer = MarketAppInstaller(current: root.appendingPathComponent("Missing.app"), identifier: "to.iris.market", team: nil)
        let helper = try installer.relaunch(after: waiting.processIdentifier)
        Thread.sleep(forTimeInterval: 0.5)
        XCTAssertTrue(helper.isRunning, "opened before the old app quit")
        waiting.waitUntilExit()
        let deadline = Date().addingTimeInterval(5)
        while helper.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        XCTAssertFalse(helper.isRunning)
    }
}
