import Foundation

/// Explicit public service topics, shared with the browser transport workspace.
enum NativeTransportType: String, CaseIterable, Identifiable {
    case parcel, passenger, both
    var id: String { rawValue }
    var label: String { switch self { case .parcel: return "Deliveries"; case .passenger: return "Rides"; case .both: return "Both" } }
    var requestLabel: String { self == .parcel ? "Request delivery" : self == .passenger ? "Request ride" : "Request transport" }
    var serviceTitle: String { self == .both ? "Deliveries and rides" : label }
    var tags: [String] { ["courier"] + (self == .passenger ? [] : ["parcel"]) + (self == .parcel ? [] : ["passenger"]) }
    static func classify(_ values: [String]) -> Self? {
        let tags = Set(values.prefix(64).map { $0.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
        let passenger = !tags.isDisjoint(with: ["passenger", "passengers", "ride", "rides"])
        let parcel = !tags.isDisjoint(with: ["parcel", "parcels", "delivery", "deliveries"]) || (!passenger && tags.contains("courier"))
        return passenger && parcel ? .both : passenger ? .passenger : parcel ? .parcel : nil
    }
    func includes(_ tags: [String]) -> Bool {
        guard let type = Self.classify(tags) else { return false }
        return self == .both || type == .both || type == self
    }
}
