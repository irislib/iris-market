import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Exercises the same rasterizer and image importer as the order sheet without a network or camera.
@main struct OrderHandoffQRChecks {
    static func main() throws {
        let value = "iris-handoff:1:pickup:" + String(repeating: "1", count: 32) + ":1794990000:" + String(repeating: "a", count: 128)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        defer { try? FileManager.default.removeItem(at: url) }
        let vectorURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/pickup-receipt-vector.json")
        let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: vectorURL)) as! [String: Any]
        let acknowledgment = vector["ackQr"] as! String
        let receipt = vector["receiptQr"] as! String
        for (source, completed) in [(value, false), (acknowledgment, false), (receipt, true)] {
            guard let qr = MarketQRCode.raster(source),
                  let image = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("Could not produce QR image") }
            CGImageDestinationAddImage(image, qr, nil)
            precondition(CGImageDestinationFinalize(image))
            let decoded = try MarketQRImage.read(url)
            precondition(decoded == source)
            precondition((completed ? MarketOrderHandoff.receiptInput(decoded) : MarketOrderHandoff.passInput(decoded)) == source)
        }
        try Data("invalid image".utf8).write(to: url)
        do { _ = try MarketQRImage.read(url); fatalError("Invalid image accepted") } catch MarketQRImage.ReadError.unreadable {}
        print("QR image round trip and invalid image checks passed.")
    }
}
