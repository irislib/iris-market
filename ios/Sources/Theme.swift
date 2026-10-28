import SwiftUI
import UIKit

enum MarketAppearance: String, CaseIterable {
    case system, light, dark
    var colorScheme: ColorScheme? { switch self { case .system: return nil; case .light: return .light; case .dark: return .dark } }
    var label: String { rawValue.capitalized }
}

enum MarketTheme {
    private static func adaptive(_ light: (Double, Double, Double), _ dark: (Double, Double, Double)) -> Color {
        Color(UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: value.0, green: value.1, blue: value.2, alpha: 1)
        })
    }
    static let paper = adaptive((0.97, 0.96, 0.93), (0.10, 0.12, 0.11))
    static let surface = adaptive((1, 1, 1), (0.16, 0.18, 0.16))
    static let ink = adaptive((0.12, 0.20, 0.19), (0.94, 0.94, 0.88))
    static let muted = adaptive((0.43, 0.48, 0.44), (0.66, 0.72, 0.66))
    static let mint = adaptive((0.79, 0.91, 0.80), (0.22, 0.34, 0.27))
    static let green = adaptive((0.22, 0.40, 0.31), (0.66, 0.85, 0.69))
    static let line = adaptive((0.88, 0.89, 0.85), (0.29, 0.33, 0.29))
    static let peach = adaptive((0.96, 0.85, 0.73), (0.42, 0.32, 0.23))
    static let action = adaptive((0.12, 0.20, 0.19), (0.75, 0.89, 0.75))
    static let onAction = adaptive((1, 1, 1), (0.10, 0.17, 0.12))
    // Illustration colors remain constant, including labels over the artwork.
    static let artworkInk = Color(red: 0.12, green: 0.20, blue: 0.19)
    static let artworkGreen = Color(red: 0.22, green: 0.40, blue: 0.31)
    static let artworkMint = Color(red: 0.79, green: 0.91, blue: 0.80)
    static let artworkPeach = Color(red: 0.96, green: 0.85, blue: 0.73)
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
            Text(title).font(.system(size: 24, weight: .semibold, design: .serif)).foregroundStyle(MarketTheme.ink)
            Text(description).font(.system(size: 15)).foregroundStyle(MarketTheme.muted).multilineTextAlignment(.center).lineSpacing(4).frame(maxWidth: 280)
        }.frame(maxWidth: .infinity).padding(.vertical, 48).padding(.horizontal, 24)
    }
}
struct CategoryArt: View {
    let category: String
    let title: String
    var detail: String = ""
    var large = false
    private var style: (String, Color, Color) {
        let text = (category + " " + title + " " + detail).lowercased()
        let group = category.lowercased()
        if group.contains("transport") { return ("shippingbox.fill", Color(red: 0.95, green: 0.87, blue: 0.70), Color(red: 0.62, green: 0.45, blue: 0.24)) }
        if group.contains("service") || group.contains("help") { return ("hands.sparkles.fill", Color(red: 0.82, green: 0.89, blue: 0.91), Color(red: 0.28, green: 0.45, blue: 0.51)) }
        if text.contains("headphone") { return ("headphones", Color(red: 0.93, green: 0.83, blue: 0.75), Color(red: 0.62, green: 0.35, blue: 0.23)) }
        if text.contains("coffee") || text.contains("grinder") { return ("cup.and.saucer.fill", Color(red: 0.92, green: 0.85, blue: 0.75), Color(red: 0.48, green: 0.35, blue: 0.25)) }
        if text.contains("bike") || text.contains("bicycle") || text.contains("cycling") { return ("bicycle", Color(red: 0.86, green: 0.92, blue: 0.80), MarketTheme.artworkGreen) }
        if text.contains("camera") { return ("camera.fill", Color(red: 0.90, green: 0.85, blue: 0.76), Color(red: 0.35, green: 0.31, blue: 0.24)) }
        if text.contains("plant") || text.contains("garden") || text.contains("monstera") { return ("leaf.fill", Color(red: 0.83, green: 0.89, blue: 0.75), Color(red: 0.30, green: 0.46, blue: 0.27)) }
        if text.contains("chair") || text.contains("furniture") { return ("chair.lounge.fill", Color(red: 0.94, green: 0.84, blue: 0.70), Color(red: 0.60, green: 0.38, blue: 0.23)) }
        if text.contains("guitar") || text.contains("music") { return ("guitars.fill", Color(red: 0.93, green: 0.83, blue: 0.75), Color(red: 0.62, green: 0.35, blue: 0.23)) }
        if text.contains("book") { return ("books.vertical.fill", Color(red: 0.87, green: 0.86, blue: 0.94), Color(red: 0.43, green: 0.37, blue: 0.58)) }
        if text.contains("transport") || text.contains("delivery") || text.contains("pickup") { return ("shippingbox.fill", Color(red: 0.95, green: 0.87, blue: 0.70), Color(red: 0.62, green: 0.45, blue: 0.24)) }
        if text.contains("service") || text.contains("skill") || text.contains("help") { return ("hands.sparkles.fill", Color(red: 0.82, green: 0.89, blue: 0.91), Color(red: 0.28, green: 0.45, blue: 0.51)) }
        if text.contains("electronic") || text.contains("monitor") { return ("desktopcomputer", Color(red: 0.82, green: 0.87, blue: 0.88), Color(red: 0.28, green: 0.39, blue: 0.40)) }
        if text.contains("clothing") || text.contains("fashion") { return ("tshirt.fill", Color(red: 0.93, green: 0.84, blue: 0.85), Color(red: 0.59, green: 0.36, blue: 0.41)) }
        if group.contains("home") { return ("house.fill", MarketTheme.artworkPeach, MarketTheme.artworkGreen) }
        return ("sparkles", MarketTheme.artworkMint, MarketTheme.artworkGreen)
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                style.1
                Circle().fill(.white.opacity(0.22)).frame(width: geometry.size.width * 0.82).offset(x: geometry.size.width * 0.28, y: -geometry.size.height * 0.22)
                Ellipse().fill(style.2.opacity(0.10)).frame(width: geometry.size.width * 0.58, height: large ? 26 : 15).offset(y: geometry.size.height * 0.30)
                Image(systemName: style.0).font(.system(size: large ? 105 : 62, weight: .light)).foregroundStyle(style.2)
                    .rotationEffect(.degrees(-7)).offset(y: -3).shadow(color: style.2.opacity(0.10), radius: 7, y: 6)
            }
        }.clipped().accessibilityHidden(true)
    }
}

struct MarketSheetScope: ViewModifier {
    @EnvironmentObject private var store: MarketStore
    @State private var registered = false
    func body(content: Content) -> some View {
        content.onAppear {
            if !registered { registered = true; store.activeSheetCount += 1 }
        }.onDisappear {
            if registered { registered = false; store.activeSheetCount = max(0, store.activeSheetCount - 1) }
        }
    }
}
extension View {
    func marketSheetScope() -> some View { modifier(MarketSheetScope()) }
}
struct MarketInlineError: View {
    @EnvironmentObject private var store: MarketStore
    var body: some View {
        if let issue = store.alert {
            Text(issue).font(.system(size: 13)).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
