package to.iris.market

/**
 * The settings editor owns these fields. A save keeps the latest stored values of every other
 * field (receipts, escrow and similar toggles saved elsewhere) and applies the editor's values
 * for its own fields, so message servers, currency and photo settings are never dropped.
 */
object NativeSettingsCommit {
    val editorFields = setOf("ai", "currency", "relays", "image_proxy")

    fun editorSave(stored: Map<String, Any?>, requested: Map<String, Any?>): Map<String, Any?> =
        stored + requested.filterKeys { it in editorFields }
}
