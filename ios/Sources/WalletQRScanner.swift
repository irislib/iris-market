import SwiftUI
import AVFoundation

/// QR content is input to review, never an instruction to send or redeem funds.
enum WalletQRInput {
    static func token(_ value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = value.lowercased().hasPrefix("cashu:") ? String(value.dropFirst(6)) : value
        guard token.utf8.count <= 2 * 1024 * 1024, token.hasPrefix("cashuA") || token.hasPrefix("cashuB"), !token.contains(where: \.isWhitespace) else { return nil }
        return token
    }
    static func invoice(_ value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let invoice = value.hasPrefix("lightning:") ? String(value.dropFirst(10)) : value
        guard invoice.utf8.count <= 16_384, invoice.hasPrefix("lnbc"), invoice.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        return invoice
    }
}

private final class WalletCamera: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "to.iris.market.wallet-camera")
    @Published var error: String?
    var onValue: ((String) -> Void)?
    private var configured = false
    private var active = false
    func start() {
        active = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configure()
        case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in DispatchQueue.main.async { guard let self, self.active else { return }; if allowed { self.configure() } else { self.error = "Camera access is off. You can paste the token or invoice instead." } } }
        default: error = "Camera access is off. You can paste the token or invoice instead."
        }
    }
    func stop() { active = false; queue.async { [weak self] in self?.session.stopRunning() } }
    private func configure() {
        queue.async { [weak self] in
            guard let self else { return }
            if !self.configured {
                do {
                    guard let device = AVCaptureDevice.default(for: .video) else { throw CameraFailure.unavailable }
                    let input = try AVCaptureDeviceInput(device: device)
                    let output = AVCaptureMetadataOutput()
                    self.session.beginConfiguration()
                    guard self.session.canAddInput(input), self.session.canAddOutput(output) else { self.session.commitConfiguration(); throw CameraFailure.unavailable }
                    self.session.addInput(input); self.session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main)
                    guard output.availableMetadataObjectTypes.contains(.qr) else { self.session.commitConfiguration(); throw CameraFailure.unavailable }
                    output.metadataObjectTypes = [.qr]
                    self.session.commitConfiguration(); self.configured = true
                } catch { DispatchQueue.main.async { self.error = "This camera cannot scan QR codes. Paste the token or invoice instead." }; return }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.active else { return }
                self.queue.async { self.session.startRunning() }
            }
        }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard active, let value = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        onValue?(value)
    }
    private enum CameraFailure: Error { case unavailable }
}

struct WalletQRScanner: View {
    enum Kind { case token, invoice }
    let kind: Kind
    let onValue: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var camera = WalletCamera()
    @State private var invalid = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                WalletCameraPreview(session: camera.session).frame(minHeight: 260, idealHeight: 360).clipShape(RoundedRectangle(cornerRadius: 20))
                if let error = camera.error { Text(error).foregroundStyle(MarketTheme.muted) }
                else { Text(invalid ? "That QR is not a supported \(kind == .token ? "Cashu token" : "Lightning invoice")." : "Place the QR code inside the camera view.").foregroundStyle(MarketTheme.muted) }
            }.padding(24).navigationTitle(kind == .token ? "Scan token" : "Scan invoice").marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear {
            camera.onValue = { value in
                let result = kind == .token ? WalletQRInput.token(value) : WalletQRInput.invoice(value)
                guard let result else { invalid = true; return }
                camera.stop(); onValue(result); dismiss()
            }
            camera.start()
        }
        .onDisappear { camera.stop(); camera.onValue = nil }
        .onChange(of: scenePhase) { phase in if phase == .active { camera.start() } else { camera.stop() } }
        .marketSheetFrame()
    }
}
#if os(macOS)
private struct WalletCameraPreview: NSViewRepresentable {
    let session: AVCaptureSession
    func makeNSView(context: Context) -> NSView { let view = CameraView(); view.wantsLayer = true; view.layer = AVCaptureVideoPreviewLayer(session: session); return view }
    func updateNSView(_ view: NSView, context: Context) { (view.layer as? AVCaptureVideoPreviewLayer)?.videoGravity = .resizeAspectFill }
    private final class CameraView: NSView { override func layout() { super.layout(); layer?.frame = bounds } }
}
#else
private struct WalletCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> CameraView { let view = CameraView(); (view.layer as? AVCaptureVideoPreviewLayer)?.session = session; return view }
    func updateUIView(_ view: CameraView, context: Context) { (view.layer as? AVCaptureVideoPreviewLayer)?.videoGravity = .resizeAspectFill }
    final class CameraView: UIView { override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self } }
}
#endif
