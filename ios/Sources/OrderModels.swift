import Foundation

/// Authenticated, account-scoped projections from Rust. Presentation never authorizes a wire update.
struct MarketOrder: Decodable, Hashable, Identifiable {
    let id: String
    let buyer: String
    let seller: String
    let items: [MarketOrderItem]
    let note: String
    let status: String
    let createdAt: Int64
    let updatedAt: Int64
    let shipment: MarketShipment
    let archived: Bool
    let role: String?
    let sync: String
    let locationFresh: Bool
    let displayPrice: MarketOrderDisplayPrice?
    let escrowTradeId: String?
    let escrowProvider: String?
    let payment: MarketOrderPayment?
    let deliveryRequest: MarketDeliveryRequest?
    let pickupAuthorization: MarketPickupAuthorization?
    let sourceOrderId: String?
    let deliveryOrderId: String?
    /// A proxied thumbnail of the ordered item from the core.
    let displayImage: String?
    var formattedPrice: String {
        guard let displayPrice, displayPrice.amount.isFinite else { return items.first?.formattedPrice ?? "Negotiable" }
        let format = NumberFormatter(); format.numberStyle = .currency; format.currencyCode = displayPrice.currency
        if ["TESTSAT", "TESTSATS"].contains(displayPrice.currency.uppercased()) { format.numberStyle = .decimal; format.maximumFractionDigits = 0; return (format.string(from: NSNumber(value: displayPrice.amount)) ?? String(displayPrice.amount)) + " test sats" }
        if ["SAT", "SATS", "BTC"].contains(displayPrice.currency.uppercased()) { format.numberStyle = .decimal; format.maximumFractionDigits = displayPrice.currency.uppercased() == "BTC" ? 8 : 0; return (format.string(from: NSNumber(value: displayPrice.amount)) ?? String(displayPrice.amount)) + " " + (displayPrice.currency.uppercased() == "BTC" ? "BTC" : "sats") }
        return (format.string(from: NSNumber(value: displayPrice.amount)) ?? items.first?.formattedPrice ?? "Negotiable") + (displayPrice.stale ? " · older rate" : "")
    }
    /// A basket's sum in its items' own currency, when they share one and have numeric prices.
    var itemsTotal: String? {
        guard items.count > 1, let first = items.first, items.allSatisfy({ $0.currency == first.currency }) else { return nil }
        var sum = Decimal(0)
        for item in items { guard let unit = Decimal(string: item.price) else { return nil }; sum += unit * Decimal(item.quantity) }
        return MarketOrderItem(id: first.id, title: "", price: NSDecimalNumber(decimal: sum).stringValue, currency: first.currency, quantity: 1).formattedPrice
    }
    var terminal: Bool { status == "delivered" || status == "cancelled" }
    var title: String { items.map(\.title).filter { !$0.isEmpty }.joined(separator: ", ") }
    var statusLabel: String {
        switch status {
        case "requested": return "Requested"
        case "accepted": return "Accepted"
        case "in-transit": return "On the way"
        case "delivered": return "Delivered"
        case "cancelled": return "Cancelled"
        default: return "Updating"
        }
    }
    func handlesDelivery(_ owner: String) -> Bool { (seller == owner && deliveryRequest != nil) || shipment.stops.contains { seller == owner || $0.courierPubkey == owner } }
}

struct MarketOrderDisplayPrice: Decodable, Hashable { let amount: Double; let currency: String; let stale: Bool }

struct MarketDeliveryPlace: Codable, Hashable {
    var label: String
    var address: String
    var coordinates: [Double]?
    init(label: String, address: String = "", coordinates: [Double]? = nil) { self.label = label; self.address = address; self.coordinates = coordinates }
    func projection() throws -> [String: Any] {
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty, address.count <= 500, label.count <= 120 else { throw MarketRouteError.message("Enter an address or meeting point.") }
        var result: [String: Any] = ["label": label, "address": address]
        if let coordinates { guard MarketShipment.validCoordinates(coordinates) else { throw MarketRouteError.message("Choose a valid map point.") }; result["coordinates"] = coordinates }
        return result
    }
}
struct MarketDeliveryCollection: Codable, Hashable { let merchant: String; let reference: String }
struct MarketDeliveryRequest: Codable, Hashable {
    let pickup: MarketDeliveryPlace
    let destination: MarketDeliveryPlace
    let collection: MarketDeliveryCollection?
    init(pickup: MarketDeliveryPlace, destination: MarketDeliveryPlace, collection: MarketDeliveryCollection? = nil) { self.pickup = pickup; self.destination = destination; self.collection = collection }
    func projection() throws -> [String: Any] { var value: [String: Any] = ["pickup": try pickup.projection(), "destination": try destination.projection()]; if let collection { value["collection"] = ["merchant": collection.merchant, "reference": collection.reference] }; return value }
}
struct MarketOrderPayment: Codable, Hashable { let mint: String; let amount: String; let unit: String; let status: String }
struct MarketPickupAuthorization: Codable, Hashable { let courierPubkey: String; let reference: String }

struct MarketOrderItem: Decodable, Hashable, Identifiable {
    let id: String
    let title: String
    let price: String
    let currency: String
    let quantity: Int
    /// The exact signed listing revision, when the order recorded one.
    var eventId: String? = nil
    var formattedPrice: String {
        guard !price.isEmpty else { return "Negotiable" }
        if ["TESTSAT", "TESTSATS"].contains(currency.uppercased()) { return price + " test sats" }
        if Decimal(string: price) == 0 { return "Free" }
        let symbols = ["EUR": "€", "USD": "$", "GBP": "£"]
        if let symbol = symbols[currency] { return symbol + price }
        return price + " " + (currency.lowercased() == "sats" ? "sats" : currency)
    }
    /// The price of this line: unit price times count.
    var lineFormattedPrice: String {
        guard quantity > 1, let unit = Decimal(string: price) else { return formattedPrice }
        return MarketOrderItem(id: id, title: title, price: NSDecimalNumber(decimal: unit * Decimal(quantity)).stringValue, currency: currency, quantity: 1).formattedPrice
    }
}

struct MarketShipment: Codable, Hashable {
    var stops: [MarketShipmentStop]
    var trackingUrl: String?
    var eta: Int64?
    var location: MarketShipmentLocation?
    var trackingLink: URL? {
        guard let trackingUrl, let url = URL(string: trackingUrl), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    var hasMap: Bool { stops.contains { Self.validCoordinates($0.coordinates) } }
    static func validCoordinates(_ value: [Double]?) -> Bool {
        guard let value, value.count == 2 else { return false }
        return value.allSatisfy(\.isFinite) && abs(value[0]) <= 180 && abs(value[1]) <= 90
    }
    /// The separate map bridge receives route display data only: no keys, order IDs, tokens, or tracking URLs.
    func mapProjection(now: Int64 = Int64(Date().timeIntervalSince1970)) -> [String: Any] {
        let points: [[String: Any]] = stops.prefix(12).map { stop in
            var value: [String: Any] = ["id": stop.id, "label": stop.label, "address": stop.address, "status": stop.status]
            if Self.validCoordinates(stop.coordinates) { value["coordinates"] = stop.coordinates }
            return value
        }
        var value: [String: Any] = ["stops": points]
        if let location, Self.validCoordinates(location.coordinates), location.at <= now, location.at > now - 120 {
            value["location"] = ["coordinates": location.coordinates, "at": location.at]
        }
        return value
    }
}

struct MarketShipmentStop: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var address: String
    var coordinates: [Double]?
    var courierPubkey: String?
    var status: String
    var statusLabel: String { status == "completed" ? "Completed" : status == "arrived" ? "Arrived" : "Upcoming" }
}
struct MarketShipmentLocation: Codable, Hashable {
    let coordinates: [Double]
    let at: Int64
    let courierPubkey: String?
    let stopId: String?
}

struct CashuPayment: Decodable, Hashable {
    let testOnly: Bool?
    let token: String
    let amount: String
    let mint: String
    let unit: String
    let status: String
    var isTestMoney: Bool { testOnly == true || ["testnut.cashu.space", "nofees.testnut.cashu.space"].contains(URL(string: mint)?.host ?? "") }
    var formattedAmount: String { amount + " " + (["sat", "sats"].contains(unit.lowercased()) ? (isTestMoney ? "test sats" : "sats") : unit.uppercased()) }
    var mintLabel: String { URL(string: mint)?.host ?? "Mint" }
}

enum MarketOrderList: String, CaseIterable {
    case purchases = "Purchases", sales = "Sales", deliveries = "Deliveries", escrow = "Escrow jobs", archived = "Archived"
    func contains(_ order: MarketOrder, owner: String) -> Bool {
        if self == .archived { return order.archived }
        guard !order.archived else { return false }
        switch self {
        case .purchases: return order.buyer == owner
        case .sales: return order.seller == owner
        case .deliveries: return order.shipment.stops.contains { $0.courierPubkey == owner }
        case .escrow, .archived: return false
        }
    }
}

struct MarketStopDraft: Identifiable {
    var id: String
    var label: String
    var address: String
    var latitude: String
    var longitude: String
    var courier: String
    var status: String
    init(stop: MarketShipmentStop? = nil) {
        id = stop?.id ?? UUID().uuidString.lowercased()
        label = stop?.label ?? ""; address = stop?.address ?? ""
        latitude = stop?.coordinates.flatMap { $0.count == 2 ? String($0[1]) : nil } ?? ""
        longitude = stop?.coordinates.flatMap { $0.count == 2 ? String($0[0]) : nil } ?? ""
        courier = stop?.courierPubkey ?? ""; status = stop?.status ?? "pending"
    }
    func projection() throws -> [String: Any] {
        let lat = latitude.trimmingCharacters(in: .whitespacesAndNewlines), lon = longitude.trimmingCharacters(in: .whitespacesAndNewlines)
        guard label.count <= 120, address.count <= 500 else { throw MarketRouteError.message("Use a shorter stop name or address.") }
        var result: [String: Any] = ["id": id, "label": label.trimmingCharacters(in: .whitespacesAndNewlines), "address": address.trimmingCharacters(in: .whitespacesAndNewlines), "status": status]
        if !lat.isEmpty || !lon.isEmpty {
            guard let y = Double(lat), let x = Double(lon), MarketShipment.validCoordinates([x, y]) else { throw MarketRouteError.message("Enter a valid latitude and longitude for each mapped stop.") }
            result["coordinates"] = [x, y]
        }
        if !courier.isEmpty { result["courierPubkey"] = courier }
        return result
    }
}

enum MarketRouteError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

func marketRoutePatch(stops: [MarketStopDraft], tracking: String, eta: Date?) throws -> [String: Any] {
    guard stops.count <= 12 else { throw MarketRouteError.message("Use up to 12 delivery stops.") }
    var shipment: [String: Any] = ["stops": try stops.map { try $0.projection() }]
    let tracking = tracking.trimmingCharacters(in: .whitespacesAndNewlines)
    if !tracking.isEmpty {
        guard tracking.count <= 2048, let url = URL(string: tracking), url.scheme == "https", let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { throw MarketRouteError.message("Use a secure tracking link.") }
        shipment["trackingUrl"] = url.absoluteString
    }
    if let eta {
        let seconds = eta.timeIntervalSince1970
        guard seconds.isFinite, seconds >= 0, seconds <= 9_007_199_254_740_991 else { throw MarketRouteError.message("Choose a valid arrival time.") }
        shipment["eta"] = Int64(seconds)
    }
    return ["shipment": shipment]
}

/// History filters, totals and CSV export for the order lists.
enum MarketOrderPeriod: String, CaseIterable, Identifiable {
    case all = "All time", days30 = "Last 30 days", year = "This year", lastYear = "Last year"
    var id: String { rawValue }
    func includes(_ createdAt: Int64, now: Date = Date()) -> Bool {
        let date = Date(timeIntervalSince1970: TimeInterval(createdAt)), calendar = Calendar.current
        switch self {
        case .all: return true
        case .days30: return date >= now.addingTimeInterval(-30 * 86400)
        case .year: return calendar.component(.year, from: date) == calendar.component(.year, from: now)
        case .lastYear: return calendar.component(.year, from: date) == calendar.component(.year, from: now) - 1
        }
    }
}
enum MarketOrderHistory {
    /// Totals in each listing's own currency; cancelled orders and negotiable prices are left out.
    static func summary(_ orders: [MarketOrder]) -> String {
        var totals: [String: Double] = [:]
        for order in orders where order.status != "cancelled" {
            for item in order.items { if let price = Double(item.price), price.isFinite { totals[item.currency, default: 0] += price * Double(item.quantity) } }
        }
        let format = NumberFormatter(); format.numberStyle = .decimal; format.maximumFractionDigits = 2
        let amounts = totals.keys.sorted().map { (format.string(from: NSNumber(value: totals[$0]!)) ?? "") + " " + $0 }
        return (["\(orders.count) \(orders.count == 1 ? "order" : "orders")"] + amounts).joined(separator: " · ")
    }
    /// A spreadsheet-safe CSV, one row per item; formula-like text stays text.
    static func csv(_ orders: [MarketOrder], owner: String, name: (String) -> String) -> String {
        func cell(_ value: String) -> String {
            let formula = value.first.map { "=+-@\t".contains($0) } ?? false
            guard formula || value.contains(where: { ",\"\n\r".contains($0) }) else { return value }
            return "\"" + (formula ? "'" : "") + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        let day = DateFormatter(); day.dateFormat = "yyyy-MM-dd"; day.timeZone = TimeZone(identifier: "UTC")
        var rows = [["Date", "Order", "Type", "Item", "Quantity", "Unit price", "Currency", "Total", "Status", "Other person", "Other person ID", "Listing", "Listing revision"]]
        for order in orders {
            let sale = order.seller == owner, other = sale ? order.buyer : order.seller
            for item in order.items {
                let total = Double(item.price).map { String(format: "%g", $0 * Double(item.quantity)) } ?? ""
                rows.append([day.string(from: Date(timeIntervalSince1970: TimeInterval(order.createdAt))), order.id, sale ? "Sale" : "Purchase", item.title, String(item.quantity), item.price, item.currency, total, order.status, name(other), other, item.id, item.eventId ?? ""])
            }
        }
        return rows.map { $0.map(cell).joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
    }
}
