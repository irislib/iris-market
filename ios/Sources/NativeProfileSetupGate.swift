import Foundation

enum NativeProfileSetupGate {
    // update_profile is the explicit setup confirmation; local saves and
    // discovery remain available without creating a public profile.
    private static let writes: Set<String> = [
        "publish", "close", "contact", "create_invite", "accept_invite",
        "send_message", "request_order", "update_order"
    ]
    static func requiresSetup(command: String, nameRequired: Bool, demo: Bool) -> Bool {
        nameRequired && !demo && writes.contains(command)
    }
}

struct NativeProfileSheetStack {
    private(set) var ids: [UUID] = []
    var top: UUID? { ids.last }
    mutating func register(_ id: UUID) { if !ids.contains(id) { ids.append(id) } }
    mutating func unregister(_ id: UUID) { ids.removeAll { $0 == id } }
}
