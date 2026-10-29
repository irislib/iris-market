@main struct NativePhotoFilterChecks {
    static func main() {
        precondition(!NativePhotoFilter.includes(imageURL: nil, choice: nil, query: "", side: "offer", map: false))
        precondition(NativePhotoFilter.includes(imageURL: "https://photos.invalid/lamp.jpg", choice: nil, query: "", side: "offer", map: false))
        for context in [("lamp", "offer", false), ("", "request", false), ("", "offer", true)] {
            precondition(NativePhotoFilter.includes(imageURL: nil, choice: nil, query: context.0, side: context.1, map: context.2))
            precondition(!NativePhotoFilter.includes(imageURL: nil, choice: true, query: context.0, side: context.1, map: context.2))
        }
        precondition(NativePhotoFilter.includes(imageURL: nil, choice: false, query: "", side: "offer", map: false))
        precondition(NativePhotoFilter.wantsPhotos(choice: nil, query: "  \n", side: "offer", map: false))
        print("Native photo filter: 10 home/search/map/manual checks passed")
    }
}
