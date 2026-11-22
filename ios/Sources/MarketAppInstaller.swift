#if os(macOS)
import Foundation
import Security

/// Replaces the running app with a downloaded release. The app is not
/// sandboxed, so it can rename its own bundle and start a helper shell.
struct MarketAppInstaller {
    let current: URL
    let identifier: String
    /// Team of the running app; development builds have none and never install.
    let team: String?
    var unpackLimit: TimeInterval = 120

    static func running() -> MarketAppInstaller {
        MarketAppInstaller(current: Bundle.main.bundleURL,
                           identifier: Bundle.main.bundleIdentifier ?? "to.iris.market",
                           team: runningTeam())
    }

    /// Unpacks next to the app (same volume, so the swap is a rename) and
    /// checks the new app before anything is replaced.
    func prepare(archive: URL, version: String) throws -> URL {
        if current.path.contains("/AppTranslocation/") {
            throw MarketUpdateProblem(message: "Move Iris Market to your Applications folder, then retry.", offerDownload: true)
        }
        guard FileManager.default.isWritableFile(atPath: current.deletingLastPathComponent().path) else {
            throw MarketUpdateProblem(message: "Iris Market can’t update itself in this folder. Move it to Applications, then retry.", offerDownload: true)
        }
        guard let team else {
            throw MarketUpdateProblem(message: "Development builds can’t install updates. Use the released app.", offerDownload: true)
        }
        let staging: URL
        do {
            staging = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                                  appropriateFor: current, create: true)
        } catch {
            throw MarketUpdateProblem(message: "Couldn’t prepare the update. Free up disk space, then retry.")
        }
        do {
            try unpack(archive, into: staging)
            let apps = try FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "app" }
            guard apps.count == 1, let app = apps.first,
                  let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
                  info["CFBundleIdentifier"] as? String == identifier,
                  info["MarketReleaseVersion"] as? String == version else {
                throw MarketUpdateProblem(message: "The downloaded file isn’t the expected update. Retry to download it again.", discardDownload: true)
            }
            try Self.verify(app: app, identifier: identifier, team: team)
            return app
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
        }
    }

    func replace(with prepared: URL) throws {
        do {
            _ = try FileManager.default.replaceItemAt(current, withItemAt: prepared, backupItemName: nil, options: [])
        } catch {
            throw MarketUpdateProblem(message: "Couldn’t replace Iris Market in its folder. Quit other copies of it, then retry.", offerDownload: true)
        }
        try? FileManager.default.removeItem(at: prepared.deletingLastPathComponent())
    }

    /// Waits for this process to exit before opening the new app with the
    /// same arguments, so the old instance is never reactivated instead.
    /// Gives up after two minutes.
    @discardableResult
    func relaunch(after pid: Int32 = ProcessInfo.processInfo.processIdentifier,
                  arguments: [String] = Array(CommandLine.arguments.dropFirst())) throws -> Process {
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/sh")
        let script = #"pid=$1; app=$2; shift 2; i=0; while /bin/kill -0 "$pid" 2>/dev/null; do [ $i -ge 600 ] && exit 0; i=$((i+1)); /bin/sleep 0.2; done; exec /usr/bin/open "$app" --args "$@""#
        helper.arguments = ["-c", script, "market-relaunch", String(pid), current.path] + arguments
        helper.standardInput = FileHandle.nullDevice
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        try helper.run()
        return helper
    }

    private func unpack(_ archive: URL, into directory: URL) throws {
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = ["-x", "-k", archive.path, directory.path]
        ditto.standardOutput = FileHandle.nullDevice
        ditto.standardError = FileHandle.nullDevice
        let finished = DispatchSemaphore(value: 0)
        ditto.terminationHandler = { _ in finished.signal() }
        do { try ditto.run() } catch {
            throw MarketUpdateProblem(message: "Couldn’t unpack the update. Please retry.")
        }
        if finished.wait(timeout: .now() + unpackLimit) == .timedOut {
            ditto.terminate()
            throw MarketUpdateProblem(message: "Unpacking the update took too long. Please retry.")
        }
        guard ditto.terminationStatus == 0 else {
            throw MarketUpdateProblem(message: "The downloaded file is damaged. Retry to download it again.", discardDownload: true)
        }
    }

    /// Apple-issued Developer ID signature from the same team, valid for
    /// every nested binary.
    static func verify(app: URL, identifier: String, team: String) throws {
        let refused = MarketUpdateProblem(message: "The update isn’t signed by Iris Market’s developer, so it was not installed. Retry to download it again.", discardDownload: true)
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { throw refused }
        guard let requirement = developerIDRequirement(identifier: identifier, team: team) else { throw refused }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        guard SecStaticCodeCheckValidityWithErrors(code, flags, requirement, nil) == errSecSuccess else { throw refused }
    }

    static func developerIDRequirement(identifier: String, team: String) -> SecRequirement? {
        // Apple TN3127 identifies the Developer ID issuer and Application leaf by these OIDs.
        let text = """
        anchor apple generic and identifier "\(identifier)"
        and certificate 1[field.1.2.840.113635.100.6.2.6] exists
        and certificate leaf[field.1.2.840.113635.100.6.1.13] exists
        and certificate leaf[subject.OU] = "\(team)"
        """
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else { return nil }
        return requirement
    }

    static func runningTeam() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess else { return nil }
        return (information as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
    }
}
#endif
