package to.iris.market

/** One migration per provider. The captured endpoint is never reassigned. */
object NativeKeyMigration {
    fun migrate(provider: String, endpoint: String, slotForEndpoint: (String) -> String, read: (String) -> String, contains: (String) -> Boolean, write: (String, String) -> Unit) {
        val marker = "ai-legacy-migrated-$provider"
        if (read(marker) == "1") return
        val legacySlot = "ai-$provider"
        val legacy = read(legacySlot)
        val capture = "ai-legacy-endpoint-$provider"
        if (legacy.isNotBlank() && read(capture).isBlank() && endpoint.isNotBlank()) write(capture, endpoint)
        val capturedEndpoint = read(capture)
        if (legacy.isNotBlank() && capturedEndpoint.isNotBlank()) {
            val slot = slotForEndpoint(capturedEndpoint)
            if (!contains(slot)) write(slot, legacy)
        }
        if (legacy.isNotBlank() && capturedEndpoint.isBlank()) return
        write(marker, "1")
        // A failed erase remains safe because the durable marker prevents replay.
        if (legacy.isNotBlank()) write(legacySlot, "")
    }
    fun replace(provider: String, slot: String, value: String, write: (String, String) -> Unit) {
        // Commit migration suppression before clearing a scoped key, including crashes.
        write("ai-legacy-migrated-$provider", "1")
        write(slot, value)
        write("ai-$provider", "")
    }
}
