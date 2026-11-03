import Foundation

/// Offline replay for a locally prepared, verified public-listing fixture.
/// Compile with ios/Sources/OnDeviceAI.swift. Each JSONL input row contains
/// caseID, query and the same [String:String] listing projection used by
/// MarketStore. --compare runs both paths for each case, alternating order.
/// Output contains opaque case IDs, decisions and timings only.
@main struct PublicSearchReplay {
    struct Input: Decodable {
        let caseID: String
        let query: String
        let listing: [String: String]
    }
    struct Outcome: Encodable {
        let caseID: String
        let usesOfferCache: Bool
        let score: Double?
        let show: Bool?
        let milliseconds: Int
        let error: String?
    }

    static func main() async throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let path = arguments.first,
              arguments.count == 1 || arguments.count == 2 && ["--uncached", "--compare"].contains(arguments[1]) else {
            FileHandle.standardError.write(Data("Usage: PublicSearchReplay CASES.jsonl [--uncached | --compare]\n".utf8))
            exit(64)
        }
        if let reason = OnDeviceAI.unavailableReason {
            FileHandle.standardError.write(Data((reason + "\n").utf8))
            exit(77)
        }
        let offers = NativeListingOffers()
        let compare = arguments.last == "--compare"
        let rows = try String(contentsOfFile: path, encoding: .utf8)
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        for (index, line) in rows.split(separator: "\n").enumerated() {
            let row = try decoder.decode(Input.self, from: Data(line.utf8))
            let modes = compare ? (index.isMultiple(of: 2) ? [false, true] : [true, false]) : [arguments.last != "--uncached"]
            for useCache in modes {
                let outcome = await measure(row, cache: useCache ? offers : nil)
                FileHandle.standardOutput.write(try encoder.encode(outcome) + Data([10]))
            }
        }
    }

    private static func measure(_ row: Input, cache: NativeListingOffers?) async -> Outcome {
        let started = DispatchTime.now().uptimeNanoseconds
        func elapsed() -> Int { Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000) }
        do {
            let decision = try await OnDeviceAI.review(interests: row.query, listing: row.listing, offers: cache)
            return Outcome(caseID: row.caseID, usesOfferCache: cache != nil, score: decision.score,
                           show: decision.show, milliseconds: elapsed(), error: nil)
        } catch {
            return Outcome(caseID: row.caseID, usesOfferCache: cache != nil, score: nil, show: nil,
                           milliseconds: elapsed(), error: OnDeviceAI.failureMessage(error))
        }
    }
}
