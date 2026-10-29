import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Small presentation adapters shared by the iOS and macOS targets.
enum MarketPlatform {
    static func copyToClipboard(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }

    static func copyPaymentToClipboard(_ token: String) {
        #if os(macOS)
        copyToClipboard(token)
        #else
        UIPasteboard.general.setItems([["public.utf8-plain-text": token]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
        #endif
    }

    static func openExternalURL(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
}

extension View {
    @ViewBuilder func marketInlineTitle() -> some View {
        #if os(macOS)
        self
        #else
        navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder func marketNoAutocapitalization() -> some View {
        #if os(macOS)
        self
        #else
        textInputAutocapitalization(.never)
        #endif
    }

    @ViewBuilder func marketDecimalKeyboard() -> some View {
        #if os(macOS)
        self
        #else
        keyboardType(.decimalPad)
        #endif
    }

    @ViewBuilder func marketURLKeyboard() -> some View {
        #if os(macOS)
        self
        #else
        keyboardType(.URL)
        #endif
    }

    @ViewBuilder func marketKeyboardDismissal() -> some View {
        #if os(macOS)
        self
        #else
        scrollDismissesKeyboard(.interactively)
        #endif
    }

    @ViewBuilder func marketWindowFrame() -> some View {
        #if os(macOS)
        frame(minWidth: 720, minHeight: 600).buttonStyle(.plain)
        #else
        self
        #endif
    }

    @ViewBuilder func marketSheetFrame() -> some View {
        #if os(macOS)
        frame(minWidth: 480, idealWidth: 580, minHeight: 540, idealHeight: 660)
        #else
        self
        #endif
    }
}
