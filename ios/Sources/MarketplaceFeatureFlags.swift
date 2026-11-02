import SwiftUI

struct MarketplaceFeatureFlags: View {
    @EnvironmentObject private var store: MarketStore
    private func toggle(_ key: WritableKeyPath<MarketSettings, Bool>) -> Binding<Bool> {
        Binding(get: { store.snapshot.settings[keyPath: key] }, set: { enabled in
            var settings = store.snapshot.settings
            settings[keyPath: key] = enabled
            store.saveSettings(settings, key: "", replaceKey: false)
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Optional marketplace tools", systemImage: "slider.horizontal.3").font(.headline)
            PrivateMatchingSettings()
            Toggle("Escrow", isOn: toggle(\.escrowUi))
            Text("Agree on a third person to help settle a payment.").font(.caption).foregroundStyle(.secondary)
        }.padding(20).background(MarketTheme.surface, in: RoundedRectangle(cornerRadius: 23))
    }
}
