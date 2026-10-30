package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeProfileSetupGateTest {
    @Test fun guestWritesRequireAnExplicitNewAttemptAfterSetup() {
        val writes = listOf("publish", "close", "contact", "create_invite", "accept_invite", "send_message", "request_order", "update_order")
        writes.forEach {
            assertTrue(NativeProfileSetupGate.requiresSetup(it, true, false))
            assertFalse(NativeProfileSetupGate.requiresSetup(it, false, false))
            assertFalse(NativeProfileSetupGate.requiresSetup(it, true, true))
        }
    }
    @Test fun browseLocalActionsAndExplicitSetupRemainAvailable() {
        listOf("update_profile", "save", "archive_order", "set_filter", "load_profile", "continue_search", "set_settings").forEach {
            assertFalse(NativeProfileSetupGate.requiresSetup(it, true, false))
        }
    }
}
