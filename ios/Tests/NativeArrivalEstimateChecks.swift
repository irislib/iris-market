@main struct NativeArrivalEstimateChecks {
    static func main() {
        let now: Int64 = 1_800_000_000
        let cases: [(Int64, String)] = [(-1,"Taking longer than expected"),(0,"Taking longer than expected"),(1,"Less than a minute"),(59,"Less than a minute"),(60,"About 1 min"),(61,"About 2 min"),(120,"About 2 min"),(3599,"About 1 hr"),(3600,"About 1 hr"),(3601,"About 1 hr 1 min"),(86400,"About 1 day"),(90000,"About 2 days"),(172800,"About 2 days")]
        for (seconds, expected) in cases {
            precondition(marketArrivalEstimate(eta: now + seconds, status: "accepted", now: now) == expected)
            precondition(marketArrivalEstimate(eta: now + seconds, status: "in-transit", now: now) == expected)
        }
        for status in ["requested", "delivered", "cancelled", "unknown"] { precondition(marketArrivalEstimate(eta: now + 120, status: status, now: now) == nil) }
        for eta: Int64? in [nil, 0, -1, Int64.max] { precondition(marketArrivalEstimate(eta: eta, status: "accepted", now: now) == nil) }
        precondition(marketArrivalEstimate(eta: now, status: "accepted", now: Int64.min) == nil)
        print("Native arrival estimate: 35 status/expiry/rounding/long-duration checks passed")
    }
}
