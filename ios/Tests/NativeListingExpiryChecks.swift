@main struct NativeListingExpiryChecks {
    static func main() {
        let opened: Int64 = 1_000, published: Int64 = 9_000
        precondition(NativeListingExpiry.never.deadline(publishedAt: published) == nil)
        for (preset, days) in zip(NativeListingExpiry.presets.dropFirst(), [1,7,30,90,365]) {
            precondition(preset.deadline(publishedAt: published) == published + Int64(days) * 86_400)
        }
        precondition(NativeListingExpiry.day.deadline(publishedAt: published) != opened + 86_400, "Time spent editing must not consume duration")
        let original: Int64 = 12_345
        precondition(NativeListingExpiry.unchanged(original).deadline(publishedAt: published) == original, "Unchanged edit must not extend expiry")
        precondition(NativeListingExpiry.unchanged(nil).deadline(publishedAt: published) == nil)
        precondition(NativeListingExpiry.day.deadline(publishedAt: Int64.max - 1) == Int64.max)
        precondition(NativeListingExpiry.detail(deadline: nil, now: published) == "No expiry")
        precondition(NativeListingExpiry.detail(deadline: published, now: published) == "Expired")
        precondition(NativeListingExpiry.detail(deadline: published-1, now: published) == "Expired")
        precondition(NativeListingExpiry.detail(deadline: published+1, now: published) == "Expires in less than a minute")
        precondition(NativeListingExpiry.detail(deadline: published+60, now: published) == "Expires in 1 minute")
        precondition(NativeListingExpiry.detail(deadline: published+86_400, now: published) == "Expires in 1 day")
        precondition(NativeListingExpiry.detail(deadline: published+604_800, now: published) == "Expires in 1 week")
        print("Native listing expiry: 17 preset/publish-anchor/unchanged-edit/boundary checks passed")
    }
}
