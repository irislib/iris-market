import Foundation

@main struct NativeTransportChecks {
    static func main() {
        precondition(NativeTransportType.classify(["car", "transport"]) == nil)
        precondition(NativeTransportType.classify(["courier"]) == .parcel)
        precondition(NativeTransportType.classify(["courier", "passenger"]) == .passenger)
        precondition(NativeTransportType.classify(["parcel", "passenger"]) == .both)
        precondition(NativeTransportType.classify([" ＲＩＤＥＳ "]) == .passenger)
        precondition(NativeTransportType.parcel.includes(["parcel", "passenger"]))
        precondition(!NativeTransportType.passenger.includes(["parcel"]))
        precondition(NativeTransportType.both.includes(["delivery"]))
        precondition(!NativeTransportType.both.includes(["cars"]))
        for type in NativeTransportType.allCases { precondition(NativeTransportType.classify(type.tags) == type) }
        var visibility = NativeBrowseVisibility()
        let firstHome = UUID(), replacementHome = UUID()
        precondition(!visibility.isVisible)
        precondition(visibility.update(true, owner: firstHome))
        precondition(visibility.update(true, owner: replacementHome))
        precondition(!visibility.update(false, owner: firstHome))
        precondition(visibility.isVisible, "An old view must not cancel the replacement Home")
        precondition(visibility.update(false, owner: replacementHome))
        precondition(!visibility.isVisible)
        var search = NativeSearchContinuation()
        precondition(!search.claim("a", candidates: ["first"]))
        search.start("a")
        precondition(!search.claim("b", candidates: ["first"]))
        precondition(!search.claim("a", candidates: []))
        precondition(search.claim("a", candidates: ["first|1"]))
        precondition(!search.claim("a", candidates: ["first|1"]))
        precondition(search.claim("a", candidates: ["first|2"]))
        search.stop()
        precondition(!search.claim("a", candidates: ["late"]))
        search.start("new")
        for page in 0..<10 { precondition(search.claim("new", candidates: (0..<24).map { "\(page)-\($0)" })) }
        precondition(!search.claim("new", candidates: ["over-budget"]))
        search.start("a")
        search.record(["already-reviewed"])
        precondition(!search.claim("a", candidates: ["already-reviewed"]))
        precondition(search.claim("a", candidates: ["late-arrival"]))
        search.start("history")
        precondition(search.claimHistory("history"))
        precondition(search.claimHistory("history"))
        precondition(!search.claimHistory("history"))
        search.stop()
        precondition(!search.claimHistory("history"))
        search.start("history")
        precondition(search.claimHistory("history"))
        search.start("remote")
        let firstBatch = (0..<12).map { "negative-\($0)" }
        precondition(search.canReview("remote", candidates: firstBatch, batchSize: 12))
        // Eligibility does not spend the budget before a provider has answered.
        precondition(search.canReview("remote", candidates: firstBatch, batchSize: 12))
        search.record(firstBatch)
        var reads = 0
        let many = (0..<10_000).lazy.map { index in
            reads += 1
            return index < firstBatch.count ? firstBatch[index] : "late"
        }
        precondition(!search.canReview("stale", candidates: many, batchSize: 12))
        precondition(reads == 0)
        precondition(!search.canReview("remote", candidates: many, batchSize: 12))
        precondition(reads == 12)
        precondition(!search.canReview("remote", candidates: firstBatch, batchSize: 12))
        precondition(search.canReview("remote", candidates: ["matching-thirteenth"], batchSize: 12))
        search.record(["matching-thirteenth"])
        precondition(search.canReview("remote", candidates: ["late-arrival"], batchSize: 12))
        search.stop()
        precondition(!search.canReview("remote", candidates: ["after-error"], batchSize: 12))
        search.start("remote-limit")
        for page in 0..<20 {
            let batch = (0..<12).map { "\(page)-\($0)" }
            precondition(search.canReview("remote-limit", candidates: batch, batchSize: 12))
            search.record(batch)
        }
        precondition(!search.canReview("remote-limit", candidates: ["beyond-limit"], batchSize: 12))
        search.start("partial-budget")
        search.record((0..<237).map { "reviewed-\($0)" })
        precondition(!search.canReview("partial-budget", candidates: firstBatch, batchSize: 12))
        precondition(!search.canReview("partial-budget", candidates: ["last"], batchSize: 12), "Late arrivals can enlarge the core batch")
        print("Native transport and search continuation checks passed")
    }
}
