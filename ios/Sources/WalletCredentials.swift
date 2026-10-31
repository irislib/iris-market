import Foundation
import Security

/// Local wallet recovery material stays separate from Nostr account credentials.
/// Called only by the optional wallet's explicit open flow, never on app startup.
enum WalletCredentials {
    private static let lock = NSLock()
    struct Material: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
        var description: String { "Wallet credentials" }
        var debugDescription: String { description }
        let baseDirectory: URL
        let owner: String
        let device: String
        let seed: String
    }
    enum Failure: LocalizedError {
        case invalidIdentity, missingRecoveryKey, invalidRecoveryKey, secureWrite
        var errorDescription: String? {
            switch self {
            case .invalidIdentity: return "This profile could not open its wallet."
            case .missingRecoveryKey: return "This wallet needs its recovery key. Its existing funds were preserved."
            case .invalidRecoveryKey: return "The saved wallet recovery key is not valid."
            case .secureWrite: return "The wallet recovery key could not be saved securely."
            }
        }
    }
    static func loadOrCreate(owner: String, device: String, importedSeed: String? = nil) throws -> Material {
        lock.lock(); defer { lock.unlock() }
        guard validHex(owner, count: 64), validHex(device, count: 64) else { throw Failure.invalidIdentity }
        let base = try NativeTestStorage.applicationSupportDirectory()
            .appendingPathComponent("IrisMarket/wallets", isDirectory: true)
        let directory = base.appendingPathComponent(owner, isDirectory: true).appendingPathComponent(device, isDirectory: true)
        let account = "cashu.seed.\(owner).\(device)"
        if let importedSeed, !validHex(importedSeed, count: 128) { throw Failure.invalidRecoveryKey }
        if let seed = try SecureStore.read(account) {
            if let importedSeed, importedSeed != seed { throw Failure.missingRecoveryKey }
            guard validHex(seed, count: 128) else { throw Failure.invalidRecoveryKey }
            try protect(directory)
            return Material(baseDirectory: base, owner: owner, device: device, seed: seed)
        }
        let walletFolder = directory.appendingPathComponent("cashu", isDirectory: true)
        let existing = ["seed-binding", "wallet.sqlite", "wallet.sqlite-wal", "wallet.sqlite-shm", "seed.json"]
            .contains { FileManager.default.fileExists(atPath: walletFolder.appendingPathComponent($0).path) }
        guard !existing else { throw Failure.missingRecoveryKey }
        if let importedSeed {
            try SecureStore.write(importedSeed, account: account)
            guard try SecureStore.read(account) == importedSeed else { throw Failure.secureWrite }
            try protect(directory)
            return Material(baseDirectory: base, owner: owner, device: device, seed: importedSeed)
        }
        var bytes = [UInt8](repeating: 0, count: 64)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw Failure.secureWrite }
        let seed = bytes.map { String(format: "%02x", $0) }.joined()
        _ = bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
        try SecureStore.write(seed, account: account)
        guard try SecureStore.read(account) == seed else { throw Failure.secureWrite }
        try protect(directory)
        return Material(baseDirectory: base, owner: owner, device: device, seed: seed)
    }
    private static func validHex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func protect(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        #endif
    }
}
