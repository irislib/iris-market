import Foundation

struct MarketSnapshot: Decodable {
    var publicKey: String = ""
    var demo: Bool = false
    var status: String = "Opening your market…"
    var error: String?
    var query: String = ""
    var side: String = "all"
    var revision: UInt64 = 0
    var listings: [MarketListing] = []
    var savedCount: Int = 0
    var settings: MarketSettings = .init()
    var conversations: [MarketConversation] = []
    var invite: String?
    static let empty = MarketSnapshot()
}

struct MarketListing: Decodable, Identifiable, Hashable {
    let id: String
    let author: String
    let title: String
    let description: String
    let side: String
    let price: String
    let currency: String
    let location: String
    let category: String
    let imageUrl: String?
    let createdAt: Int64
    let expiresAt: Int64?
    let status: String
    let saved: Bool
    let mine: Bool
    let delivery: String
    let relevance: Relevance?
    struct Relevance: Decodable, Hashable { let show: Bool; let reason: String }
    var formattedPrice: String {
        guard !price.isEmpty else { return side == "request" ? "Make an offer" : "Ask for price" }
        if price == "0" { return "Free" }
        return currency == "EUR" ? "€\(price)" : "\(price) \(currency)"
    }
}

struct MarketSettings: Codable, Equatable {
    var relays: [String] = ["wss://relay.damus.io", "wss://nos.lol"]
    var ai: AISettings = .init()
}
struct AISettings: Codable, Equatable {
    var enabled = false
    var provider = "compatible"
    var baseUrl = "https://api.openai.com/v1"
    var model = ""
    var interests = ""
    var curateFeed = false
}
struct MarketConversation: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let messages: [MarketMessage]
}
struct MarketMessage: Decodable, Identifiable, Hashable {
    let id: String
    let text: String
    let mine: Bool
    let createdAt: Int64
}

enum MarketJSON {
    static func decoder() -> JSONDecoder { let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase; return d }
    static func encoder() -> JSONEncoder { let e = JSONEncoder(); e.keyEncodingStrategy = .convertToSnakeCase; return e }
    static func object<T: Encodable>(_ value: T) throws -> Any { try JSONSerialization.jsonObject(with: encoder().encode(value)) }
}

// Extract actionable core copy without changing generated UniFFI error conformance.
func marketErrorMessage(_ error: Error) -> String {
    if let coreError = error as? MarketError {
        switch coreError { case .Operation(let reason): return reason }
    }
    return error.localizedDescription
}
