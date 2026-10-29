package to.iris.market

/** Presentation-only entry-feed preference; saved/profile projections remain complete. */
object NativePhotoFilter {
    fun wantsPhotos(choice: Boolean?, query: String, side: String, map: Boolean): Boolean =
        choice ?: (!map && query.isBlank() && side == "offer")
    fun includes(imageURL: String?, choice: Boolean?, query: String, side: String, map: Boolean): Boolean =
        !wantsPhotos(choice,query,side,map) || !imageURL.isNullOrEmpty()
}
