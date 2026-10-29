package to.iris.market
import org.junit.Assert.*
import org.junit.Test
class NativeProfileConnectionsTest {
    @Test fun knownFollowersLeadDeduplicateAndRemainWhileLoading() {
        assertEquals(listOf("b","a","c","d"),NativeProfileConnections.ordered(listOf("b","a","b"),listOf("c","a","d")))
        assertEquals(listOf("a"),NativeProfileConnections.ordered(listOf("a"),emptyList()))
        assertEquals(listOf("c","b"),NativeProfileConnections.ordered(emptyList(),listOf("c","c","b")))
        assertTrue(NativeProfileConnections.ordered(emptyList(),emptyList()).isEmpty())
    }
    @Test fun additionalKnownCountExcludesVisibleNames() {
        assertEquals(9,NativeProfileConnections.remaining(12,3))
        assertEquals(0,NativeProfileConnections.remaining(3,3))
        assertEquals(0,NativeProfileConnections.remaining(0,3))
    }
}
