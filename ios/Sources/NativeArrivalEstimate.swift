import Foundation

/// Shipment ETA estimates destination arrival, never pickup or completion status.
func marketArrivalEstimate(eta: Int64?, status: String, now: Int64) -> String? {
    guard now >= 0, now <= 8_640_000_000_000, ["accepted", "in-transit"].contains(status), let eta, eta > 0, eta <= 8_640_000_000_000 else { return nil }
    if eta <= now { return "Taking longer than expected" }
    let seconds = eta - now
    if seconds < 60 { return "Less than a minute" }
    let minutes = seconds / 60 + (seconds % 60 == 0 ? 0 : 1)
    if minutes < 60 { return "About \(minutes) min" }
    if minutes < 1440 {
        let remainder = minutes % 60
        return "About \(minutes / 60) hr" + (remainder == 0 ? "" : " \(remainder) min")
    }
    let days = minutes / 1440 + (minutes % 1440 == 0 ? 0 : 1)
    return "About \(days) \(days == 1 ? "day" : "days")"
}
