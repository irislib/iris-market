import Foundation
import FoundationModels
import Darwin

/// Optional live checks use synthetic text or an explicitly supplied public listing.
/// No account, relay or provider key is opened by this check.
@main struct OnDeviceRelevanceChecks {
    struct Example: Decodable { let query: String; let listing: [String:String]; var expected: Bool? = nil; var homeFeed: Bool? = nil; var allowsListingFailure: Bool? = nil }
    static func checkOfferReuse() async throws {
        let cache = NativeListingOffers(capacity: 2)
        let first = Data("first revision".utf8), edited = Data("edited revision".utf8)
        let other = Data("another listing".utf8), unknown = Data("unknown".utf8)
        let initial = try await cache.offer(for: first) { "shelf" }
        let reused = try await cache.offer(for: first) { fatalError("Repeated extraction") }
        precondition(initial == "shelf" && reused == initial)
        let revised = try await cache.offer(for: edited) { "stool" }
        precondition(revised == "stool")
        _ = try await cache.offer(for: other) { "desk" }
        let evicted = try await cache.offer(for: first) { "new extraction" }
        precondition(evicted == "new extraction")
        do {
            _ = try await cache.offer(for: unknown) { throw CancellationError() }
            preconditionFailure("Failed extraction became a result")
        } catch is CancellationError {}
        let empty = try await cache.offer(for: unknown) { "" }
        let retry = try await cache.offer(for: unknown) { "identified on retry" }
        precondition(empty.isEmpty && retry == "identified on retry")
        let cancelledKey = Data("cancelled revision".utf8)
        let cancelled = Task {
            try await cache.offer(for: cancelledKey) {
                withUnsafeCurrentTask { $0?.cancel() }
                return "late result"
            }
        }
        do {
            _ = try await cancelled.value
            preconditionFailure("Cancellation became a cached success")
        } catch is CancellationError {}
        let recovered = try await cache.offer(for: cancelledKey) { "fresh result" }
        precondition(recovered == "fresh result")
        let newAccount = NativeListingOffers()
        let fresh = try await newAccount.offer(for: first) { "fresh account" }
        precondition(fresh == "fresh account")
    }

    static func main() async {
        do { try await checkOfferReuse() } catch { fatalError("Offer reuse check failed") }
        if CommandLine.arguments.contains("--cache-only") { return }
        let timeout = OnDeviceAI.Unavailable(message: "The on-device model took too long.")
        precondition(OnDeviceAI.failureMessage(timeout) == timeout.message)
        precondition(!OnDeviceAI.isListingFailure(timeout))
        if #available(macOS 27.0, iOS 27.0, *) {
            let error = GeneratedContent.ParsingError(rawContent: "Untrusted model output must remain private", debugDescription: "Incomplete")
            precondition(OnDeviceAI.isListingFailure(error))
            precondition(OnDeviceAI.failureMessage(error) == "Apple’s model returned an incomplete result.")
        }
        if #available(macOS 26.0, iOS 26.0, *) {
            let privateContext = LanguageModelSession.GenerationError.Context(debugDescription: "untrusted prompt must not appear")
            let error = LanguageModelSession.GenerationError.decodingFailure(privateContext)
            precondition(OnDeviceAI.failureMessage(error) == "Apple’s model returned an incomplete result.")
            precondition(OnDeviceAI.isListingFailure(error))
            precondition(OnDeviceAI.isListingFailure(LanguageModelSession.GenerationError.guardrailViolation(privateContext)))
            precondition(!OnDeviceAI.isListingFailure(LanguageModelSession.GenerationError.rateLimited(privateContext)))
        }
        guard ProcessInfo.processInfo.arguments.contains("--live") else {
            print("Native AI error handling checks passed")
            return
        }
        if let unavailable = OnDeviceAI.unavailableReason { print(unavailable); exit(1) }
        var examples = [
            Example(query:"meat", listing:["title":"Grass-fed beef", "description":"Fresh beef steaks sold by the kilogram."], expected:true),
            Example(query:"meat", listing:["title":"Office desk", "description":"Wooden desk for a home office."], expected:false),
            Example(query:"meat", listing:["title":"U", "description":"U"], expected:false),
            Example(query:"meat", listing:["title":"Coffee mug", "description":"Ceramic mug. Keywords: meat, beef, steak, bicycle, phone, laptop.", "tags":"meat, beef, food"], expected:false),
            Example(query:"meat", listing:["title":"Restaurant website template", "description":"A digital website with a sample steak and burger menu."], expected:false),
            Example(query:"meat", listing:["title":"Restaurant Website Template — One-File Site (Menu, Story, Reviews, Hours)", "description":"Restaurant Website Template — a demo site sold as a file you rebrand. ONE HTML file: no framework, no build step, no hosting lock-in. Open it, swap the name, menu items, prices, hours and phone number, and your restaurant has a website the same day. WHAT YOU GET: the complete template, mobile-friendly; sticky navigation, a hero section, a full menu in four categories (starters, mains, desserts, drinks), prices, highlight tags, customer reviews, hours and location. Scroll animations and a working mobile menu in vanilla JavaScript. Placeholder business details are clearly marked for replacement. WHAT IT IS FOR: restaurants, cafes, food trucks and bakeries that need a menu-first website. A starting point for any small local business site. Delivery is one downloadable file. Pay once; no subscription.", "side":"sell", "category":"other", "tags":"restaurant, food, website, template", "price":"12500", "currency":"sat", "location":"Online"], expected:false),
            Example(query:"meat", listing:["title":"Pumpkin pickle", "description":"A jar of pickled vegetables to serve alongside roast beef."], expected:false),
            Example(query:"a bicycle", listing:["title":"Various things", "description":"Great bargain."], expected:false),
            Example(query:"musical instruments", listing:["title":"Acoustic guitar", "description":"Working six-string guitar with a case."], expected:true),
            Example(query:"Inspiring, positive and useful offers that enrich creativity, learning or community. Avoid spam, scams and dubious claims.", listing:["title":"Community drawing workshop", "description":"A friendly beginners' art class with materials included. Learn sketching together."], expected:true, homeFeed:true),
            Example(query:"Inspiring, positive and useful offers that enrich everyday life. Avoid spam, scams and dubious claims.", listing:["title":"Double your money overnight", "description":"Send money now for guaranteed huge returns. No explanation, proof or refunds."], expected:false, homeFeed:true, allowsListingFailure:true),
            Example(query:"Vintage cameras and photography equipment", listing:["title":"Wooden office desk", "description":"A solid desk for a home office."], expected:false, homeFeed:true)
        ]
        let arguments = ProcessInfo.processInfo.arguments
        let fileIndex = arguments.firstIndex(of: "--public-listing-file")
        if let fileIndex, fileIndex + 1 < arguments.count {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath:arguments[fileIndex+1]))
                guard data.count <= 20_000 else { exit(1) }
                examples = try JSONDecoder().decode([Example].self, from:data)
                guard examples.count == 1 else { exit(1) }
            } catch { print("Invalid public diagnostic input"); exit(1) }
        }
        for example in examples {
            let query = example.query, listing = example.listing
            let started = Date()
            do {
                let decision = try await OnDeviceAI.review(interests:query,listing:listing,homeFeed:example.homeFeed == true)
                print("\(listing["title"]!): show=\(decision.show), relevance=\(decision.score), elapsed=\(Date().timeIntervalSince(started))s")
                guard (0...1).contains(decision.score), example.expected.map({ decision.show == $0 }) ?? true else {
                    print("Unexpected relevance for the synthetic example")
                    exit(1)
                }
            } catch {
                if example.allowsListingFailure == true && OnDeviceAI.isListingFailure(error) {
                    print("\(listing["title"]!): listing-specific refusal; remains unreviewed and does not abort the feed")
                    continue
                }
                print("Local inference failed (\(String(reflecting: type(of: error)))): \(OnDeviceAI.failureMessage(error)); \(String(reflecting: error))")
                exit(1)
            }
        }
    }
}
