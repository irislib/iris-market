#if DEBUG && os(macOS)
import AppKit
import Combine
import SwiftUI

/// DEBUG-only: shows App updates in its own window and presses its buttons,
/// so the real flow can be captured without driving the screen.
/// `--ui-test-mode --test-storage … --ui-test-update check|install`
enum MarketUpdateHarness {
    static let action: String? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard NativeTestStorage.enabled, let index = arguments.firstIndex(of: "--ui-test-update"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }()
    /// Holds quick steps on screen long enough to be captured.
    static var pause: TimeInterval { action == nil ? 0 : 1.5 }
    @MainActor private static var window: NSWindow?
    @MainActor private static var follow: AnyCancellable?

    static func startWhenLaunched() {
        guard action != nil else { return }
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(forName: NSApplication.didFinishLaunchingNotification, object: nil, queue: .main) { _ in
            if let token { NotificationCenter.default.removeObserver(token) }
            MainActor.assumeIsolated { start() }
        }
    }

    @MainActor private static func start() {
        guard let action, window == nil else { return }
        let model = MarketUpdateModel.shared
        let panel = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 560, height: 330), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "App updates"
        panel.isReleasedWhenClosed = false
        panel.contentView = NSHostingView(rootView: MarketUpdatesView(preview: false).padding(20)
            .frame(width: 560, height: 330, alignment: .top).background(Color(nsColor: .windowBackgroundColor)))
        panel.orderFront(nil)
        window = panel
        follow = model.$step.sink { step in
            if case .available = step, action == "install" {
                DispatchQueue.main.asyncAfter(deadline: .now() + pause) { model.install() }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + pause) { model.check() }
    }
}
#endif
