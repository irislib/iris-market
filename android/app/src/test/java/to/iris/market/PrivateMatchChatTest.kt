package to.iris.market

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateMatchChatTest {
    @Test fun aliasChatsAreKeyedByMatchNotPerson() {
        // Alias chats get the match banner and never timers, escrow, reactions or a profile.
        assertTrue(isPrivateMatch("match:4f1c2b9e-0d7a-4c55-9a51-2f3c8d1e6b70"))
        assertFalse(isPrivateMatch("a".repeat(64)))
        assertFalse(isPrivateMatch("npub1match"))
    }
}
