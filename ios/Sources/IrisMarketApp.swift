import SwiftUI

@main
struct IrisMarketApp: App {
    @AppStorage("market.appearance") private var appearance = "system"
    @StateObject private var store = MarketStore(demo: ProcessInfo.processInfo.arguments.contains("--demo"))
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            MarketRootView().environmentObject(store).preferredColorScheme(MarketAppearance(rawValue: appearance)?.colorScheme).tint(MarketTheme.green)
                .onChange(of: phase) { value in if value == .active { store.startPolling() } else { store.stopPolling() } }
        }
    }
}
