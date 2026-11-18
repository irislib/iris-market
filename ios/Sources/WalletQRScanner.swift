import SwiftUI
import AVFoundation
import UniformTypeIdentifiers

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
        case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in DispatchQueue.main.async { guard let self, self.active else { return }; if allowed { self.configure() } else { self.error = "Camera access is off." } } }
        default: error = "Camera access is off."
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
                } catch { DispatchQueue.main.async { self.error = "This camera cannot scan QR codes." }; return }
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

struct MarketQRScanner: View {
    enum Kind {
        case token, invoice, handoff(String)
        var name: String {
            switch self { case .token: return "token"; case .invoice: return "invoice"; case .handoff(let name): return name }
        }
        var isHandoff: Bool { if case .handoff = self { return true }; return false }
        func input(_ value: String) -> String? {
            switch self {
            case .token: return WalletQRInput.token(value)
            case .invoice: return WalletQRInput.invoice(value)
            case .handoff: return MarketOrderHandoff.passInput(value)
            }
        }
    }
    let kind: Kind
    let onValue: (String, @escaping (String?) -> Void) -> Void
    init(kind: Kind, onValue: @escaping (String) -> Void) {
        self.kind = kind
        self.onValue = { value, done in onValue(value); done(nil) }
    }
    init(handoff name: String, verify: @escaping (String, @escaping (String?) -> Void) -> Void) {
        kind = .handoff(name)
        onValue = verify
    }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var camera = WalletCamera()
    @State private var readingImage: Task<Void, Never>?
    @State private var cameraEnabled = false
    @State private var importing = false
    @State private var finished = false
    @State private var feedback: String?
    @State private var failedVerification = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if cameraEnabled {
                    if let error = camera.error {
                        Label(error, systemImage: "camera.fill").foregroundStyle(MarketTheme.muted)
                    } else {
                        WalletCameraPreview(session: camera.session).frame(minHeight: 220, idealHeight: 320).clipShape(RoundedRectangle(cornerRadius: 20))
                        Text("Place the QR code inside the camera view.").foregroundStyle(MarketTheme.muted)
                    }
                } else {
                    Button("Use camera") { cameraEnabled = true; camera.start() }.buttonStyle(PrimaryButton())
                }
                if kind.isHandoff {
                    Button("Choose QR image") { camera.stop(); feedback = nil; importing = true }
                    if readingImage != nil { ProgressView("Reading QR image…") }
                } else if camera.error != nil {
                    Text("You can paste the " + kind.name + " instead.").foregroundStyle(MarketTheme.muted)
                }
                if let feedback, !failedVerification { Text(feedback).foregroundStyle(MarketTheme.muted) }
            }.padding(24).navigationTitle("Scan " + kind.name).marketInlineTitle()
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image]) { result in
            switch result {
            case .success(let url):
                readingImage = Task {
                    let decoded = await Task.detached { try? MarketQRImage.read(url) }.value
                    guard !Task.isCancelled else { return }
                    readingImage = nil
                    if let decoded { accept(decoded) }
                    else { feedback = "Choose an image with one clear QR code." }
                    resumeCamera()
                }
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError { feedback = "Could not open that image." }
                resumeCamera()
            }
        }
        .alert("Could not verify this code", isPresented: $failedVerification) {
            Button("Try again") { feedback = nil; finished = false; resumeCamera() }
            Button("Cancel", role: .cancel) { dismiss() }
        } message: { Text(feedback ?? "Ask for a new code for this handoff.") }
        .onAppear {
            camera.onValue = accept
            #if os(macOS)
            cameraEnabled = !kind.isHandoff
            #else
            cameraEnabled = true
            #endif
            resumeCamera()
        }
        .onDisappear { finished = true; readingImage?.cancel(); camera.stop(); camera.onValue = nil }
        .onChange(of: scenePhase) { phase in if phase == .active { resumeCamera() } else { camera.stop() } }
        .onChange(of: importing) { open in if !open { resumeCamera() } }
        .marketSheetFrame()
    }
    private func resumeCamera() {
        if cameraEnabled && scenePhase == .active && !finished && !importing && readingImage == nil { camera.start() }
    }
    private func accept(_ value: String) {
        guard !finished else { return }
        guard let valid = kind.input(value) else { feedback = "That QR code is not a supported " + kind.name + "."; return }
        finished = true; camera.stop()
        onValue(valid) { error in
            if let error { feedback = error; failedVerification = true }
            else { dismiss() }
        }
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
