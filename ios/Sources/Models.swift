import Foundation

struct MarketSnapshot: Decodable {
    var publicKey: String = ""
    var canSign = false
    var messagingReady = false
    var liveLocationSupported = false
    var demo: Bool = false
    var status: String = "Opening your market…"
    var error: String?
    var query: String = ""
    var side: String = "offer"
    var aiSearch = false
    var sort = "suggested"
    var people: [String: MarketPerson] = [:]
    var profile: PublicMarketProfile?
    var profileListings: ProfileListingPage?
    var localCuration: LocalCurationBatch?
    var graphContextLoaded = false
    var revision: UInt64 = 0
    var listings: [MarketListing] = []
    var savedCount: Int = 0
    var savedListings: [MarketListing]?
    var aiTestResult: NativeAITestResult?
    var aiMessage: String?
    var aiConfigured: Bool?
    var profileNameRequired: Bool?
    var settings: MarketSettings = .init()
    var conversations: [MarketConversation] = []
    var orders: [MarketOrder] = []
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
    let coordinates: [Double]?
    let serviceAreas: MarketServiceAreas?
    let displayPrice: MarketDisplayPrice?
    let relevance: Relevance?
    struct Relevance: Decodable, Hashable { let show: Bool; let reason: String }
    var formattedPrice: String {
        guard !price.isEmpty else { return side == "request" ? "Make an offer" : "Ask for price" }
        guard let amount = displayPrice?.amount ?? Double(price), amount.isFinite else { return "\(price) \(currency)" }
        if amount == 0 { return "Free" }
        let code = (displayPrice?.currency ?? currency).uppercased()
        let formatter = NumberFormatter()
        if ["SAT", "SATS", "BTC"].contains(code) {
            formatter.numberStyle = .decimal; formatter.maximumFractionDigits = code == "BTC" ? 8 : 0
            return "\(formatter.string(from: NSNumber(value: amount)) ?? String(amount)) \(code == "BTC" ? "BTC" : "sats")\(displayPrice?.stale == true ? " · older rate" : "")"
        }
        formatter.numberStyle = .currency; formatter.currencyCode = code
        return "\(formatter.string(from: NSNumber(value: amount)) ?? "\(amount) \(code)")\(displayPrice?.stale == true ? " · older rate" : "")"
    }
}

struct MarketDisplayPrice: Decodable, Hashable {
    let amount: Double
    let currency: String
    let approximate: Bool
    let source: String?
    let updatedAt: Int64?
    let stale: Bool
}

/// Public, signed coverage geometry. This projection has no identity or private shipment fields.
struct MarketServiceAreas: Codable, Hashable {
    let pickup: MarketAreaGeometry
    let destination: MarketAreaGeometry
}
enum MarketAreaGeometry: Codable, Hashable {
    case polygon([[[Double]]])
    case multiPolygon([[[[Double]]]])
    private enum CodingKeys: String, CodingKey { case type, coordinates }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "Polygon": self = .polygon(try values.decode([[[Double]]].self, forKey: .coordinates))
        case "MultiPolygon": self = .multiPolygon(try values.decode([[[[Double]]]].self, forKey: .coordinates))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: values, debugDescription: "Invalid service area")
        }
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .polygon(let rings): try values.encode("Polygon", forKey: .type); try values.encode(rings, forKey: .coordinates)
        case .multiPolygon(let polygons): try values.encode("MultiPolygon", forKey: .type); try values.encode(polygons, forKey: .coordinates)
        }
    }
}

struct MarketSettings: Codable, Equatable {
    var relays: [String] = ["wss://temp.iris.to", "wss://vault.iris.to", "wss://relay.damus.io", "wss://relay.snort.social", "wss://relay.primal.net", "wss://nos.lol"]
    var ai: AISettings = .init()
    var imageProxy: ImageProxySettings = .init()
    var currency = "EUR"
    init() {}
    private enum CodingKeys: String, CodingKey { case relays, ai, imageProxy, currency }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        relays = try values.decodeIfPresent([String].self, forKey: .relays) ?? relays
        ai = try values.decodeIfPresent(AISettings.self, forKey: .ai) ?? ai
        imageProxy = try values.decodeIfPresent(ImageProxySettings.self, forKey: .imageProxy) ?? imageProxy
        currency = try values.decodeIfPresent(String.self, forKey: .currency) ?? currency
    }
}
struct ImageProxySettings: Codable, Equatable {
    var enabled = true
    var url = "https://imgproxy.iris.to"
    init() {}
    private enum CodingKeys: String, CodingKey { case enabled, url }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        url = try values.decodeIfPresent(String.self, forKey: .url) ?? url
    }
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
    let delivery: String?
    let orderId: String?
    let cashu: CashuPayment?
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

struct MarketConnection: Decodable, Hashable {
    let badge: String?
    let followDistance: Int?
    let followedByFriends: Int
    let description: String
}
struct MarketPerson: Decodable, Hashable, Identifiable {
    let author: String
    let name: String
    let pictureUrl: String?
    let connection: MarketConnection
    var id: String { author }
}
struct PublicMarketProfile: Decodable {
    let person: MarketPerson
    let about: String
    let website: String?
    let following: [MarketPerson]
    let followingCount: Int
    let followingLoaded: Bool
    let followers: [MarketPerson]
    let followersLoaded: Bool?
    let followersLoading: Bool?
    let followersError: String?
    let followedByKnown: [MarketPerson]
    let graphRoot: String
    let graphLabel: String
    let graphContextLoaded: Bool
    let coverage: String
    let loading: Bool
    let error: String?
}

struct ProfileListingPage: Decodable {
    let author: String
    let listings: [MarketListing]
    let loading: Bool
    let canLoadMore: Bool
    let error: String?
}

struct LocalCurationBatch: Decodable {
    let id: String
    let interests: String
    let candidates: [Candidate]
    struct Candidate: Decodable { let listing: MarketListing; let eventId: String }
}
