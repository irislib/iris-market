import Foundation

/// Matches the web entry-feed preference; this never filters stored listings.
enum NativePhotoFilter {
    static func wantsPhotos(choice: Bool?, query: String, side: String, map: Bool) -> Bool {
        choice ?? (!map && query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && side == "offer")
    }
    static func includes(imageURL: String?, choice: Bool?, query: String, side: String, map: Bool) -> Bool {
        !wantsPhotos(choice: choice, query: query, side: side, map: map) || !(imageURL ?? "").isEmpty
    }
}
