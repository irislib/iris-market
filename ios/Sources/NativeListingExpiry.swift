import Foundation

/// Presentation durations resolve at the publish boundary; signed events retain absolute timestamps.
enum NativeListingExpiry: Hashable, Sendable {
    case unchanged(Int64?), never, day, week, month, quarter, year
    static let presets: [Self] = [.never, .day, .week, .month, .quarter, .year]
    var label: String {
        switch self {
        case .unchanged: return "Keep existing expiry"
        case .never: return "Never"
        case .day: return "1 day"
        case .week: return "1 week"
        case .month: return "30 days"
        case .quarter: return "90 days"
        case .year: return "1 year"
        }
    }
    func deadline(publishedAt: Int64) -> Int64? {
        let days: Int64
        switch self {
        case .unchanged(let deadline): return deadline
        case .never: return nil
        case .day: days = 1
        case .week: days = 7
        case .month: days = 30
        case .quarter: days = 90
        case .year: days = 365
        }
        let result = publishedAt.addingReportingOverflow(days * 86_400)
        return result.overflow ? Int64.max : result.partialValue
    }
    static func detail(deadline: Int64?, now: Int64) -> String {
        guard let deadline else { return "No expiry" }
        guard deadline > now else { return "Expired" }
        let seconds = Double(deadline) - Double(now)
        for (size, name) in [(31_536_000.0, "year"), (2_592_000.0, "month"), (604_800.0, "week"), (86_400.0, "day"), (3_600.0, "hour"), (60.0, "minute")] where seconds >= size {
            let count = Int(ceil(seconds / size))
            return "Expires in \(count) \(name)\(count == 1 ? "" : "s")"
        }
        return "Expires in less than a minute"
    }
}
