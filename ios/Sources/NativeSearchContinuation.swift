import Foundation

/// A submitted search may review late arrivals once, up to ten 24-item batches.
/// Stopping clears authority; snapshot changes alone cannot restart a search.
struct NativeSearchContinuation {
    private var context: String?
    private var attempted = Set<String>()
    private var historyWindows = 0
    mutating func start(_ value: String) { context = value; attempted.removeAll(); historyWindows = 0 }
    mutating func stop() { context = nil; attempted.removeAll(); historyWindows = 0 }
    mutating func record(_ values: [String]) { attempted.formUnion(values.prefix(max(0, 240 - attempted.count))) }
    mutating func claimHistory(_ value: String) -> Bool {
        guard context == value, attempted.count < 240, historyWindows < 2 else { return false }
        historyWindows += 1
        return true
    }
    mutating func claim(_ value: String, candidates: [String]) -> Bool {
        guard context == value, attempted.count < 240 else { return false }
        let batch = Array(candidates.prefix(24))
        guard batch.contains(where: { !attempted.contains($0) }) else { return false }
        record(batch)
        return true
    }
}
