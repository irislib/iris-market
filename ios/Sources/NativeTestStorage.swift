import Foundation

/// An explicitly requested DEBUG harness; release builds never parse these switches.
/// Test profiles and wallet seeds cannot read or replace the real app's storage.
enum NativeTestStorage {
    #if DEBUG
    static let enabled = ProcessInfo.processInfo.arguments.contains("--ui-test-mode") || ProcessInfo.processInfo.arguments.contains("--test-storage")
    private static let lock = NSLock()
    private static let configuration: Result<URL?, Error> = Result {
        guard enabled else { return nil }
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--ui-test-mode"), let index = args.firstIndex(of: "--test-storage"), index + 1 < args.count else { throw Failure.invalidDirectory }
        let root = URL(fileURLWithPath: args[index + 1], isDirectory: true).standardizedFileURL
        let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL
        guard root.lastPathComponent.hasPrefix("iris-market-ui-"), root.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL == temporary,
              root.resolvingSymlinksInPath().standardizedFileURL == root.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(root.lastPathComponent, isDirectory: true).standardizedFileURL else { throw Failure.invalidDirectory }
        let fm = FileManager.default
        if !fm.fileExists(atPath: root.path) { try fm.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        let attributes = try fm.attributesOfItem(atPath: root.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory, let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0 else { throw Failure.invalidDirectory }
        let marker = root.appendingPathComponent("ui-test-storage-v1")
        if !fm.fileExists(atPath: marker.path) {
            guard try fm.contentsOfDirectory(atPath: root.path).isEmpty else { throw Failure.invalidDirectory }
            try Data("iris-market-isolated-test-v1".utf8).write(to: marker, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
        }
        guard try String(contentsOf: marker, encoding: .utf8) == "iris-market-isolated-test-v1" else { throw Failure.invalidDirectory }
        return root
    }
    #else
    static let enabled = false
    #endif
    enum Failure: LocalizedError {
        case invalidDirectory
        var errorDescription: String? { "UI testing requires a private, empty iris-market-ui- directory directly inside the system temporary directory." }
    }
    static func directory() throws -> URL? {
        #if DEBUG
        return try configuration.get()
        #else
        return nil
        #endif
    }
    static func applicationSupportDirectory() throws -> URL {
        if let root = try directory() { return root.appendingPathComponent("application-support", isDirectory: true) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }
    static func read(_ account: String) throws -> String? {
        #if DEBUG
        lock.lock(); defer { lock.unlock() }
        return try values()[account]
        #else
        throw Failure.invalidDirectory
        #endif
    }
    static func write(_ value: String?, account: String) throws {
        #if DEBUG
        lock.lock(); defer { lock.unlock() }
        guard let root = try directory() else { throw Failure.invalidDirectory }
        var values = try values(); values[account] = value
        let file = root.appendingPathComponent("credentials.json")
        try JSONEncoder().encode(values).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        #else
        throw Failure.invalidDirectory
        #endif
    }
    #if DEBUG
    private static func values() throws -> [String: String] {
        guard let root = try directory() else { throw Failure.invalidDirectory }
        let file = root.appendingPathComponent("credentials.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path), attributes[.type] as? FileAttributeType == .typeRegular,
              ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 1024 * 1024 else { throw Failure.invalidDirectory }
        return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))
    }
    #endif
}
