import Foundation

/// A visible On state requires both explicit opt-in and a usable selected provider.
enum NativeAISearchAction { case wait, ai, text, settings }
enum NativeAITapAction { case off, on, local, settings }
enum NativeAIReadiness {
    static func tapAction(enabled: Bool, ready: Bool, localFallback: Bool) -> NativeAITapAction {
        if enabled { return .off }
        if ready { return .on }
        return localFallback ? .local : .settings
    }
    static func searchAction(intentOn: Bool, ready: Bool, busy: Bool, inference: Bool, query: String) -> NativeAISearchAction {
        if busy || inference { return .wait }
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !intentOn { return .text }
        return ready ? .ai : .settings
    }
    static func canSelectLocalOnTap(provider: String, model: String, endpoint: String) -> Bool {
        if provider.isEmpty || provider == "none" { return true }
        return provider == "compatible" && model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && ["", "https://api.openai.com/v1"].contains(endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }
    static func canEnable(provider: String, model: String, endpoint: String, localAvailable: Bool, preview: Bool = false) -> Bool {
        if provider == "apple" { return localAvailable }
        if preview { return false }
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let url = URL(string: endpoint), let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
        guard ["compatible", "ollama", "anthropic", "systemone"].contains(provider) else { return false }
        let address = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { Int($0) }
        let privateIPv4 = parts.count == 4 && octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } && (octets[0] == 127 || octets[0] == 10 || octets[0] == 192 && octets[1] == 168 || octets[0] == 172 && (16...31).contains(octets[1]))
        let privateIPv6 = address == "::1" || address.contains(":") && (address.hasPrefix("fc") || address.hasPrefix("fd"))
        return url.scheme?.lowercased() == "https" || url.scheme?.lowercased() == "http" && (address == "localhost" || privateIPv4 || privateIPv6)
    }
    static func isOn(enabled: Bool, provider: String, model: String, endpoint: String, localAvailable: Bool, preview: Bool = false) -> Bool {
        enabled && canEnable(provider: provider, model: model, endpoint: endpoint, localAvailable: localAvailable, preview: preview)
    }
}

/// Rechecks delayed OS readiness without replacing an existing choice or retrying every poll.
struct NativeLocalAIDefault {
    private var owner = ""
    private var attempted = false
    mutating func shouldOffer(owner: String, configured: Bool, available: Bool, editing: Bool, preview: Bool) -> Bool {
        if self.owner != owner { self.owner = owner; attempted = false }
        if !available { attempted = false }
        guard !owner.isEmpty, !configured, available, !editing, !preview, !attempted else { return false }
        attempted = true
        return true
    }
}
