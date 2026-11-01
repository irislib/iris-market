import SwiftUI

/// Pages share the desktop's navigation stack. On phones they retain their own sheet navigation.
struct MarketNavigationContainer<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        #if os(macOS)
        content().formStyle(.grouped)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(MarketTheme.paper)
        #else
        NavigationStack { content() }
        #endif
    }
}

extension View {
    @ViewBuilder func marketPage<Destination: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Destination) -> some View {
        #if os(macOS)
        modifier(MarketPagePresentation(isPresented: isPresented, onDismiss: onDismiss, destination: content))
        #else
        sheet(isPresented: isPresented, onDismiss: onDismiss, content: content)
        #endif
    }

    @ViewBuilder func marketPage<Item: Identifiable, Destination: View>(item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Destination) -> some View {
        #if os(macOS)
        marketPage(isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } })) {
            if let value = item.wrappedValue { content(value).id(value.id) }
        }
        #else
        sheet(item: item, content: content)
        #endif
    }
}

/// Desktop pages already have a Back button. Keep close controls for modal phone navigation.
struct MarketDoneButton: View {
    var label = "Done"
    var action: () -> Void
    var body: some View {
        #if !os(macOS)
        Button(label, action: action)
        #endif
    }
}

/// Keep every listing collection at a comfortable reading width on desktop.
var marketListingColumns: [GridItem] {
    #if os(macOS)
    [GridItem(.adaptive(minimum: 220, maximum: 320), spacing: 20)]
    #else
    [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]
    #endif
}

#if os(macOS)
/// Boolean destinations live outside NavigationPath. Explicitly dismiss them when
/// switching workspace sections so SwiftUI cannot retain an orphaned destination.
@MainActor final class MarketDesktopNavigation: ObservableObject {
    @Published private(set) var generation = UUID()
    private var destinations: [UUID: () -> Void] = [:]
    func track(_ id: UUID, dismiss: @escaping () -> Void) { destinations[id] = dismiss }
    func forget(_ id: UUID) { destinations.removeValue(forKey: id) }
    func reset() {
        let actions = Array(destinations.values)
        destinations.removeAll()
        for action in actions { action() }
        // macOS can retain a deeper destination in the split-view controller
        // when several Boolean destinations close in the same transaction.
        generation = UUID()
    }
}
private struct MarketPagePresentation<Destination: View>: ViewModifier {
    @EnvironmentObject private var navigation: MarketDesktopNavigation
    @Binding var isPresented: Bool
    var onDismiss: (() -> Void)?
    @ViewBuilder var destination: () -> Destination
    @State private var id = UUID()
    func body(content: Content) -> some View {
        content.navigationDestination(isPresented: $isPresented, destination: destination)
            .onAppear { if isPresented { navigation.track(id) { isPresented = false } } }
            .onChange(of: isPresented) { value in
                if value { navigation.track(id) { isPresented = false } }
                else { navigation.forget(id); onDismiss?() }
            }
    }
}
#endif
