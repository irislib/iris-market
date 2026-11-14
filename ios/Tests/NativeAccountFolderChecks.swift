import Foundation

@main struct NativeAccountFolderChecks {
    static func main() {
        let base = URL(fileURLWithPath: "/data/IrisMarket", isDirectory: true)
        precondition(NativeAccountFolder.url(base: base, owner: "abc", legacy: false).path == "/data/IrisMarket/accounts/abc")
        precondition(NativeAccountFolder.url(base: base, owner: "abc", legacy: true) == base, "The legacy profile keeps the base folder")
        precondition(NativeAccountFolder.seedTarget(base: base, owner: "abc", legacy: false) == NativeAccountFolder.url(base: base, owner: "abc", legacy: false), "A new profile folder is seeded where it will open")
        precondition(NativeAccountFolder.seedTarget(base: base, owner: "abc", legacy: true) == nil, "The legacy profile's servers are never replaced")
        print("Native account folder: 4 folder/seed-target checks passed")
    }
}
