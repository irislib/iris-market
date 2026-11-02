import SwiftUI

@main
struct IrisMarketApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(MarketPushDelegate.self) private var pushDelegate
    #endif
    @AppStorage("market.appearance") private var appearance = "system"
    @StateObject private var store = MarketStore(demo: ProcessInfo.processInfo.arguments.contains("--demo"))
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup("Iris Market") {
            MarketRootView().environmentObject(store).preferredColorScheme(MarketAppearance(rawValue: appearance)?.colorScheme).tint(MarketTheme.green).marketWindowFrame()
                .onChange(of: phase) { value in
                    if value == .active {
                        store.startPolling()
                        #if os(macOS)
                        MarketUpdateModel.shared.checkIfDue(preview: store.demo)
                        #endif
                    } else { store.stopPolling() }
                }
                #if os(macOS)
                .task { MarketUpdateModel.shared.checkIfDue(preview: store.demo) }
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 760)
        .windowResizability(.contentMinSize)
        .commands { CommandGroup(replacing: .newItem) {} }
        #endif
    }
}
