import SwiftUI
import CoreImage.CIFilterBuiltins
import ImageIO

struct MarketQRCode: View {
    let text: String
    let label: String
    var size: CGFloat = 240
    private static let context = CIContext(options: [.cacheIntermediates: false])

    static func raster(_ text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let qr = filter.outputImage else { return nil }
        // Four light modules on each edge give cameras a quiet zone even on a dark screen.
        let bounds = qr.extent.insetBy(dx: -4, dy: -4)
        let white = CIImage(color: .white).cropped(to: bounds)
        let image = qr.composited(over: white).transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        return context.createCGImage(image, from: image.extent)
    }

    var body: some View {
        if let image = Self.raster(text) {
            Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit()
                .frame(maxWidth: size, maxHeight: size).padding(8).background(.white, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement().accessibilityLabel(label)
        }
    }
}

enum MarketQRImage {
    enum ReadError: Error { case unreadable, noSingleCode }

    static func read(_ url: URL) throws -> String {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048
              ] as CFDictionary) else { throw ReadError.unreadable }
        let context = CIContext(options: [.useSoftwareRenderer: true, .cacheIntermediates: false])
        guard let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: context, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { throw ReadError.unreadable }
        let codes = detector.features(in: CIImage(cgImage: image))
        guard codes.count == 1, let value = (codes[0] as? CIQRCodeFeature)?.messageString else { throw ReadError.noSingleCode }
        return value
    }
}
