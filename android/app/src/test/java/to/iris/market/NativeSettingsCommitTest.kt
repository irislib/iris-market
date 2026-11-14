package to.iris.market

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeSettingsCommitTest {
    private val stored = mapOf("relays" to listOf("wss://relay.damus.io"), "currency" to "USD", "send_read_receipts" to false,
        "escrow_ui" to true, "image_proxy" to mapOf("enabled" to false), "ai" to mapOf("provider" to "compatible"))

    @Test fun editorSaveKeepsChangedMessageServers() {
        // The editor opened before a receipt toggle elsewhere, so its other fields are stale.
        val requested = mapOf("relays" to listOf("ws://127.0.0.1:7777"), "currency" to "EUR", "send_read_receipts" to true,
            "escrow_ui" to false, "image_proxy" to mapOf("enabled" to true), "ai" to mapOf("provider" to "litert"))
        val saved = NativeSettingsCommit.editorSave(stored, requested)
        assertEquals(listOf("ws://127.0.0.1:7777"), saved["relays"])
        assertEquals("EUR", saved["currency"])
        assertEquals(mapOf("enabled" to true), saved["image_proxy"])
        assertEquals(mapOf("provider" to "litert"), saved["ai"])
        // Fields the editor does not own keep their latest stored value.
        assertEquals(false, saved["send_read_receipts"])
        assertEquals(true, saved["escrow_ui"])
    }

    @Test fun editorSaveAllowsAnEmptyServerList() {
        val saved = NativeSettingsCommit.editorSave(stored, mapOf("relays" to emptyList<String>()))
        assertEquals(emptyList<String>(), saved["relays"])
        assertEquals("USD", saved["currency"])
    }
}
