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
    private var maximumWidth: CGFloat {
        #if os(macOS)
        320
        #else
        .infinity
        #endif
    }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 16, weight: .semibold)).frame(maxWidth: maximumWidth).padding(.vertical, 17)
            .foregroundStyle(dark ? MarketTheme.onAction : MarketTheme.ink)
            .background(dark ? MarketTheme.action : MarketTheme.mint, in: RoundedRectangle(cornerRadius: 18))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}
struct MarketEmptyState: View {
    let symbol: String
    let title: String
    let description: String
    var action: String? = nil
    var onAction: () -> Void = {}
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 32, weight: .light)).foregroundStyle(MarketTheme.green)
                .frame(width: 82, height: 82).background(MarketTheme.mint.opacity(0.5), in: RoundedRectangle(cornerRadius: 27))
            Text(title).font(.system(size: 24, weight: .semibold)).foregroundStyle(MarketTheme.ink)
            Text(description).font(.system(size: 15)).foregroundStyle(MarketTheme.muted).multilineTextAlignment(.center).lineSpacing(4).frame(maxWidth: 280)
            if let action { Button(action, action: onAction).font(.system(size: 15, weight: .semibold)).foregroundStyle(MarketTheme.action).padding(.top, 4) }
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
    @ViewBuilder func marketSheetScope() -> some View {
        #if os(macOS)
        self
        #else
        marketSheetFrame().modifier(MarketSheetScope())
        #endif
    }
}
struct MarketInlineError: View {
    @EnvironmentObject private var store: MarketStore
    var body: some View {
        MarketSignerApprovalLink()
        if let issue = store.alert {
            Text(issue).font(.system(size: 13)).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The same opposing exchange arrows as the web brand (web/icon.svg), drawn natively without a tile.
struct IrisMark: View {
    private static let center = CGPoint(x: 32, y: 32)
    private static func angle(_ point: CGPoint) -> Angle { .radians(atan2(point.y - center.y, point.x - center.x)) }
    /// One arrow; the other is the same shape turned half a circle about the centre.
    private var arrow: Path {
        Path { p in
            let outerStart = CGPoint(x: 10.14, y: 45.13), outerEnd = CGPoint(x: 39.88, y: 7.75)
            let innerStart = CGPoint(x: 36.33, y: 18.69), innerEnd = CGPoint(x: 20, y: 39.21)
            p.move(to: outerStart)
            // SwiftUI's y-down space flips arc direction: `clockwise: false` sweeps clockwise on screen, as the SVG does.
            p.addArc(center: Self.center, radius: 25.5, startAngle: Self.angle(outerStart), endAngle: Self.angle(outerEnd), clockwise: false)
            p.addLine(to: CGPoint(x: 41.49, y: 2.8))
            p.addLine(to: CGPoint(x: 47.13, y: 19.3))
            p.addLine(to: CGPoint(x: 34.72, y: 23.63))
            p.addLine(to: innerStart)
            p.addArc(center: Self.center, radius: 14, startAngle: Self.angle(innerStart), endAngle: Self.angle(innerEnd), clockwise: true)
            p.closeSubpath()
        }
    }
    private static let colors: [Color] = [0xF43F5E, 0xF75E34, 0xF98216, 0xFAB615, 0xB1CA2E, 0x33C658, 0x14BD9A, 0x0BB1D7, 0x2A93EB, 0x4F78F6, 0x7E62F6, 0xB750B6, 0xF43F5E].map { value in
        Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width, geometry.size.height) / 64
            let one = arrow, both = Path { p in p.addPath(one); p.addPath(one.applying(CGAffineTransform(translationX: 64, y: 64).rotated(by: .pi))) }
            AngularGradient(colors: Self.colors, center: .center)
                .frame(width: 64 * scale, height: 64 * scale)
                .mask(both.applying(CGAffineTransform(scaleX: scale, y: scale)).fill())
        }.accessibilityHidden(true)
    }
}

struct MarketSignerApprovalLink: View {
    @EnvironmentObject private var store: MarketStore
    @Environment(\.openURL) private var openURL
    var body: some View {
        if let url = store.signerApprovalURL {
            Button("Open signer to approve") { store.signerApprovalURL = nil; openURL(url) }
        }
    }
}
