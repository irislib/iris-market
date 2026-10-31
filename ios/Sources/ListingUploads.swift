import SwiftUI
import UniformTypeIdentifiers
import ImageIO

struct ListingMediaUpload: Decodable {
    let url: String, nhash: String, fileLink: String, name: String, mime: String
    let size: Int, isImage: Bool
}
struct PreparedListingFile {
    let data: Data, name: String, mime: String
    static func read(_ url: URL) throws -> Self {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 8 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .image) == true {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 48000000 / height,
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2560] as CFDictionary) else { throw CocoaError(.fileReadCorruptFile) }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { throw CocoaError(.fileWriteUnknown) }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
            guard CGImageDestinationFinalize(destination), output.length <= 8 * 1024 * 1024 else { throw CocoaError(.fileWriteUnknown) }
            return Self(data: output as Data, name: url.deletingPathExtension().lastPathComponent + ".jpg", mime: "image/jpeg")
        }
        return Self(data: data, name: url.lastPathComponent, mime: type?.preferredMIMEType ?? "application/octet-stream")
    }
}
struct ListingUploadButton: View {
    @EnvironmentObject private var store: MarketStore
    @Binding var uploading: Bool
    let onUpload: (ListingMediaUpload) -> Void
    @State private var chooseFile = false
    @State private var failure: String?
    @State private var uploadTask: Task<Void, Never>?
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button { chooseFile = true } label: {
                HStack { if uploading { ProgressView() }; Label(uploading ? "Uploading…" : "Add photo or file", systemImage: "photo.badge.plus") }
            }.disabled(uploading || store.demo || !store.snapshot.canSign).accessibilityIdentifier("listingUpload")
            Text("Uploads are public. Photos have location metadata removed.").font(.caption).foregroundStyle(MarketTheme.muted)
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
        }
        .fileImporter(isPresented: $chooseFile, allowedContentTypes: [.item]) { result in
            guard case .success(let url) = result else { return }
            let owner = store.snapshot.publicKey
            uploading = true; failure = nil
            uploadTask = Task {
                do {
                    let prepared = try await Task.detached(priority: .userInitiated) { try PreparedListingFile.read(url) }.value
                    try Task.checkCancellation()
                    let result = try await store.uploadMedia(prepared, expectedOwner: owner)
                    try Task.checkCancellation()
                    onUpload(result)
                } catch is CancellationError { } catch { if !Task.isCancelled { failure = "Could not upload this file. Choose a file under 8 MiB and try again." } }
                uploading = false
            }
        }
        .onDisappear { uploadTask?.cancel(); uploading = false }
        .onChange(of: store.snapshot.publicKey) { _ in uploadTask?.cancel(); uploading = false; failure = nil }
    }
}
