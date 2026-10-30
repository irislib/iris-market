package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativePushLifecycleTest {
    @Test fun clearingLiveModelEnablesColdRoutingWithoutWaitingForGC() {
        val bridge=NativePushLifecycle<Any>()
        val retainedOldModel=Any()
        bridge.attach(retainedOldModel)
        assertSame(retainedOldModel,bridge.current())
        bridge.detach(retainedOldModel)
        assertNull(bridge.current())
        // The old model is deliberately still strongly reachable, like a canceled VM.
        assertNotNull(retainedOldModel)
    }
    @Test fun delayedCleanupCannotDetachReplacementModel() {
        val bridge=NativePushLifecycle<Any>()
        val old=Any();val replacement=Any()
        bridge.attach(old);bridge.attach(replacement)
        bridge.detach(old)
        assertSame(replacement,bridge.current())
        bridge.detach(replacement);assertNull(bridge.current())
    }
    @Test fun unrelatedOrRepeatedCleanupLeavesCorrectRoutingState() {
        val bridge=NativePushLifecycle<Any>();val active=Any()
        bridge.detach(Any());assertNull(bridge.current())
        bridge.attach(active);bridge.detach(Any());assertSame(active,bridge.current())
        bridge.detach(active);bridge.detach(active);assertNull(bridge.current())
    }
    @Test fun lateInitializationCannotReattachAClearedModel() {
        val bridge=NativePushLifecycle<Any>();val cleared=Any();val replacement=Any()
        bridge.attach(cleared);bridge.detach(cleared)
        bridge.attach(cleared);assertNull(bridge.current())
        bridge.attach(replacement);bridge.attach(cleared)
        assertSame(replacement,bridge.current())
    }

    @Test fun staleInitializationCannotWriteProviderStateAfterDetachOrReplacement() {
        val bridge=NativePushLifecycle<Any>();val old=Any();val replacement=Any();var writes=0
        bridge.attach(old);assertTrue(bridge.withCurrent(old){writes++})
        bridge.detach(old);assertFalse(bridge.withCurrent(old){writes++})
        bridge.attach(replacement);assertFalse(bridge.withCurrent(old){writes++})
        assertTrue(bridge.withCurrent(replacement){writes++});assertEquals(2,writes)
    }

}
