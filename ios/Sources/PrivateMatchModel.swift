import Foundation

struct PrivateMatchInbox: Decodable {
    struct Entry: Decodable, Identifiable {
        let id, side, summary, peer: String
        let expiresAt: Int64
    }
    struct Pair: Decodable { let entries: [String]; let votes: [Bool?]; let introduced: Bool }
    struct Interest: Decodable {
        let summary: String; let vote: Bool?; let contact: String?; let chat: String?
        let connected: Bool?; let sharedProfile: Bool?; let revealed: String?
    }
    struct Lead: Decodable { let title, listing: String }
    let sent, received: [String: Entry]
    let pairs: [String: Pair]
    let interests: [String: Interest]
    let publicLeads: [String: Lead]
}
struct PrivateMatchCandidate: Decodable, Identifiable {
    let id, kind, summary: String
}

/// Private-match alias chats are keyed by match, never by a person.
func isPrivateMatch(_ id: String) -> Bool { id.hasPrefix("match:") }
