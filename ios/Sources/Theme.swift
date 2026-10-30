import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

enum MarketAppearance: String, CaseIterable {
    case system, light, dark
    var colorScheme: ColorScheme? { switch self { case .system: return nil; case .light: return .light; case .dark: return .dark } }
    var label: String { rawValue.capitalized }
}

enum MarketTheme {
    private static func adaptive(_ light: (Double, Double, Double), _ dark: (Double, Double, Double)) -> Color {
#if canImport(UIKit)
        return Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: value.0, green: value.1, blue: value.2, alpha: 1)
        })
#else
        return Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(red: value.0, green: value.1, blue: value.2, alpha: 1)
        })
#endif
    }
    private static func rgb(_ hex: UInt) -> (Double, Double, Double) {
        (Double((hex >> 16) & 255) / 255, Double((hex >> 8) & 255) / 255, Double(hex & 255) / 255)
    }
    static let paper = adaptive(rgb(0xffffff), rgb(0x14161b))
    static let surface = adaptive(rgb(0xf7f7f8), rgb(0x1d2027))
    static let ink = adaptive(rgb(0x222222), rgb(0xeeeef2))
    static let muted = adaptive(rgb(0x686868), rgb(0xa5a8b3))
    static let mint = adaptive(rgb(0xf0eff4), rgb(0x2d293c))
    static let green = adaptive(rgb(0x252525), rgb(0xc2b5f5))
    static let line = adaptive(rgb(0xe5e5e7), rgb(0x343842))
    static let peach = adaptive(rgb(0xf3f3f5), rgb(0x292d36))
    static let action = adaptive(rgb(0x252525), rgb(0xc2b5f5))
    static let onAction = adaptive(rgb(0xffffff), rgb(0x252036))
    // Controls over listing photos retain a neutral, readable foreground.
    static let artworkInk = Color(white: 34.0 / 255)
}

struct PrimaryButton: ButtonStyle {
    var dark = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 16, weight: .semibold)).frame(maxWidth: .infinity).padding(.vertical, 17)
            .foregroundStyle(dark ? MarketTheme.onAction : MarketTheme.ink)
            .background(dark ? MarketTheme.action : MarketTheme.mint, in: RoundedRectangle(cornerRadius: 18))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
struct MarketEmptyState: View {
    let symbol: String
    let title: String
    let description: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 32, weight: .light)).foregroundStyle(MarketTheme.green)
                .frame(width: 82, height: 82).background(MarketTheme.mint.opacity(0.5), in: RoundedRectangle(cornerRadius: 27))
            Text(title).font(.system(size: 24, weight: .semibold)).foregroundStyle(MarketTheme.ink)
            Text(description).font(.system(size: 15)).foregroundStyle(MarketTheme.muted).multilineTextAlignment(.center).lineSpacing(4).frame(maxWidth: 280)
        }.frame(maxWidth: .infinity).padding(.vertical, 48).padding(.horizontal, 24)
    }
}
struct ListingPlaceholder: View {
    var category = ""
    private var symbol: String {
        ["service", "services", "help", "skills", "jobs", "delivery", "errands"].contains(category.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ? "briefcase.fill" : "tag.fill"
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Rectangle().fill(MarketTheme.surface)
                Image(systemName: symbol)
                    .font(.system(size: min(geometry.size.width, geometry.size.height) * 0.24))
                    .foregroundStyle(Color(white: 0.5).opacity(0.20))
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.accessibilityHidden(true)
    }
}

private struct MarketSheetIDKey: EnvironmentKey { static let defaultValue: UUID? = nil }
extension EnvironmentValues {
    var marketSheetID: UUID? { get { self[MarketSheetIDKey.self] } set { self[MarketSheetIDKey.self] = newValue } }
}
struct MarketSheetScope: ViewModifier {
    @EnvironmentObject private var store: MarketStore
    @State private var registered = false
    @State private var id = UUID()
    func body(content: Content) -> some View {
        content.environment(\.marketSheetID, id).onAppear {
            if !registered { registered = true; store.registerSheet(id) }
        }.onDisappear {
            if registered { registered = false; store.unregisterSheet(id) }
        }.sheet(isPresented: Binding(get: {
            store.profileSetupRequested && store.activeSheetID == id
        }, set: { if !$0 { store.dismissProfileSetup() } })) {
            ProfileNameEntryView().environmentObject(store).marketSheetFrame()
        }
    }
}
extension View {
    func marketSheetScope() -> some View { marketSheetFrame().modifier(MarketSheetScope()) }
}
struct MarketInlineError: View {
    @EnvironmentObject private var store: MarketStore
    var body: some View {
        if let issue = store.alert {
            Text(issue).font(.system(size: 13)).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The same opposing exchange arrows as the web brand, drawn natively.
struct IrisMark: View {
    private var arrow: Path {
        Path { p in
            p.move(to: CGPoint(x: 7, y: 32))
            p.addCurve(to: CGPoint(x: 47, y: 12), control1: CGPoint(x: 7, y: 11), control2: CGPoint(x: 30, y: 0))
            p.addLine(to: CGPoint(x: 47, y: 6))
            p.addLine(to: CGPoint(x: 59, y: 18))
            p.addLine(to: CGPoint(x: 47, y: 30))
            p.addLine(to: CGPoint(x: 47, y: 23))
            p.addCurve(to: CGPoint(x: 17, y: 32), control1: CGPoint(x: 37, y: 8), control2: CGPoint(x: 17, y: 15))
            p.closeSubpath()
        }
    }
    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width, geometry.size.height) / 64
            let path = arrow.applying(CGAffineTransform(scaleX: scale, y: scale))
            let gradient = LinearGradient(colors: [Color(red: 0.52, green: 0.35, blue: 0.86), Color(red: 0.78, green: 0.35, blue: 0.65), Color(red: 0.95, green: 0.54, blue: 0.35)], startPoint: .bottomLeading, endPoint: .topTrailing)
            ZStack { path.fill(gradient); path.rotation(.degrees(180), anchor: .center).fill(gradient) }
        }.accessibilityHidden(true)
    }
}
