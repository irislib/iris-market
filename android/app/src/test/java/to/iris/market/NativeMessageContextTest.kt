package to.iris.market
import org.junit.Assert.*
import org.junit.Test

class NativeMessageContextTest {
    @Test fun fullOrderIdentityKeepsBuyerPrefixAndUsesUuidThreadSuffix() {
        val uuid="e166c41b-ed90-4d76-aa37-2ed2b2ff4f31"
        val id="${"a".repeat(64)}:$uuid"
        val context=MessageContext.order(id)
        assertEquals(uuid,context.threadId)
        assertEquals(id,context.orderId)
        assertEquals("order:$id",context.key)
    }
}
