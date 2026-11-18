import Foundation

/// Where a profile keeps its data on this device.
enum NativeAccountFolder {
    static func url(base: URL, owner: String, legacy: Bool) -> URL {
        legacy ? base : base.appendingPathComponent("accounts/\(owner)", isDirectory: true)
    }
    /// A profile new to this device starts on the servers chosen here. The legacy profile shares
    /// the base folder and keeps its own; the core leaves any already opened folder unchanged.
    static func seedTarget(base: URL, owner: String, legacy: Bool) -> URL? {
        legacy ? nil : url(base: base, owner: owner, legacy: legacy)
    }
}
