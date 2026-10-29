import Foundation

/// Serializes short preference commits, while inference may wait on its own queue.
final class NativeAIIntentGate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var current: Int { lock.lock(); defer { lock.unlock() }; return value }
    func advance() -> Int { lock.lock(); defer { lock.unlock() }; value += 1; return value }
    func perform<T>(at epoch: Int, _ operation: () throws -> T) rethrows -> T? {
        lock.lock(); defer { lock.unlock() }
        guard epoch == value else { return nil }
        return try operation()
    }
}
