import SwiftUI

@main
struct IrisMarketApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(MarketPushDelegate.self) private var pushDelegate
    #endif
    @State private var preferredLanguages = Locale.preferredLanguages
    @AppStorage("market.appearance") private var appearance = "system"
    @StateObject private var store = MarketStore(demo: ProcessInfo.processInfo.arguments.contains("--demo"))
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup("Iris Market") {
            MarketRootView().environmentObject(store).preferredColorScheme(MarketAppearance(rawValue: appearance)?.colorScheme).tint(MarketTheme.green).marketWindowFrame()
                .environment(\.marketPreferredLanguages, preferredLanguages)
                .onReceive(NotificationCenter.default.publisher(for: NSLocale.currentLocaleDidChangeNotification)) { _ in
                    preferredLanguages = Locale.preferredLanguages
                }
                .onChange(of: phase) { value in
                    if value == .active {
                        preferredLanguages = Locale.preferredLanguages
                        store.startPolling()
                        #if os(macOS)
                        MarketUpdateModel.shared.checkIfDue(preview: store.demo)
                        #endif
                    } else { store.stopPolling() }
                }
                #if os(macOS)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in store.startPolling() }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in store.stopPolling() }
                .task { MarketUpdateModel.shared.checkIfDue(preview: store.demo) }
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1000, height: 760)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                DisplayCurrencyPicker(store: store).pickerStyle(.menu)
            }
        }
        #endif
    }
}
