import Foundation

@main struct NativeTestStorageChecks {
    static func main() throws {
        #if DEBUG
        precondition(NativeTestStorage.enabled)
        if ProcessInfo.processInfo.arguments.contains("--expect-invalid") {
            do { _ = try NativeTestStorage.directory(); preconditionFailure("Unsafe test storage was accepted") }
            catch { print("Invalid test storage rejected without Keychain fallback."); return }
        }
        let root = try NativeTestStorage.directory()!
        let previous = try NativeTestStorage.read("test-only-check")
        try NativeTestStorage.write("synthetic-test-value", account: "test-only-check")
        let stored = try NativeTestStorage.read("test-only-check"); precondition(stored == "synthetic-test-value")
        let support = try NativeTestStorage.applicationSupportDirectory(); precondition(support.path.hasPrefix(root.path + "/"))
        let mode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("credentials.json").path)[.posixPermissions] as! NSNumber
        precondition(mode.intValue == 0o600)
        try NativeTestStorage.write(previous, account: "test-only-check")
        print("4 isolated DEBUG storage checks passed.")
        #else
        precondition(!NativeTestStorage.enabled)
        let root = try NativeTestStorage.directory(); precondition(root == nil)
        print("2 release bypass rejection checks passed.")
        #endif
    }
}
