package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativePushRegistrationQueueTest {
    private fun ready():NativePushRegistrationQueue = NativePushRegistrationQueue().apply {
        setIntent("owner",true);publish("owner","filters-a",0);recordToken("token-a")
    }
    @Test fun scopesWaitForTokenAndSurviveItsLateArrival() {
        val queue=NativePushRegistrationQueue()
        queue.setIntent("owner",true);queue.publish("owner","latest-private-scopes",0)
        assertTrue(queue.wantsToken());assertNull(queue.next())
        queue.recordToken("new-token")
        val work=queue.next()!!
        assertTrue(work.enabled);assertEquals("latest-private-scopes",work.filters);assertEquals("new-token",work.token)
    }
    @Test fun refreshDuringRequestIsCoalescedAndRunsAfterThrottleWithoutUIPolling() {
        val queue=ready();val old=queue.next()!!;assertTrue(queue.begin(old,0))
        queue.recordToken("token-b")
        assertFalse(queue.finish(old,true,1))
        val next=queue.next()!!
        assertEquals("token-b",next.token);assertEquals(10000L,next.readyAt)
        assertFalse(queue.begin(next,9999));assertTrue(queue.begin(next,10000))
        assertTrue(queue.finish(next,true,10001));assertNull(queue.next())
    }
    @Test fun tokenAfterSuccessfulRequestIsRetainedWhileThrottled() {
        val queue=ready();val old=queue.next()!!;queue.begin(old,0);queue.finish(old,true,1)
        queue.recordToken("token-b")
        val next=queue.next()!!;assertEquals(10000L,next.readyAt)
        assertTrue(queue.begin(next,10000));queue.finish(next,true,10001);assertNull(queue.next())
    }
    @Test fun callbackCannotReenableDisabledOrReplacedAccount() {
        val queue=ready();val old=queue.next()!!;queue.begin(old,0)
        queue.setIntent("owner",false)
        queue.setIntent("replacement",true);queue.publish("replacement","replacement-scopes",1)
        queue.recordToken("token-b");assertFalse(queue.finish(old,true,2))
        val replacement=queue.next()!!;assertEquals("replacement",replacement.owner);assertTrue(replacement.enabled)
        queue.begin(replacement,2);queue.finish(replacement,true,3)
        val cleanup=queue.next()!!;assertEquals("owner",cleanup.owner);assertFalse(cleanup.enabled)
        queue.begin(cleanup,10000);queue.finish(cleanup,true,10001)
        queue.recordToken("token-c")
        assertEquals("replacement",queue.next()!!.owner)
    }
    @Test fun latestSnapshotWinsAndUnchangedSuccessfulInputsDoNotRepeat() {
        val queue=ready();val old=queue.next()!!;queue.begin(old,0)
        queue.publish("owner","filters-b",1);queue.publish("owner","filters-c",2)
        assertFalse(queue.finish(old,true,3))
        val latest=queue.next()!!;assertEquals("filters-c",latest.filters)
        queue.begin(latest,10000);queue.finish(latest,true,10001)
        queue.publish("owner","filters-c",10002);assertNull(queue.next())
    }
    @Test fun disableRoundTripStillCleansUpAnObsoleteInFlightCreate() {
        val queue=NativePushRegistrationQueue();queue.setIntent("owner",false)
        val initial=queue.next()!!;queue.begin(initial,0);queue.finish(initial,true,1)
        queue.setIntent("owner",true);queue.publish("owner","filters",1);queue.recordToken("token")
        val create=queue.next()!!;queue.begin(create,10000)
        queue.setIntent("owner",false);assertFalse(queue.finish(create,true,10001))
        assertFalse(queue.next()!!.enabled)
    }
    @Test fun automaticFailuresStopAfterThreeAttemptsUntilNewForegroundEvidence() {
        val queue=ready()
        for(now in listOf(0L,10000L,40000L)) {
            val work=queue.next()!!;assertTrue(queue.begin(work,now));queue.finish(work,false,now)
        }
        assertNull(queue.next())
        queue.publish("owner","filters-a",99999);assertNull(queue.next())
        queue.publish("owner","filters-a",100000);assertNotNull(queue.next())
    }
    @Test fun staleTokenFetchCannotOverwriteANewerRefreshOrChangeIntent() {
        val queue=NativePushRegistrationQueue();queue.setIntent("owner",true);queue.publish("owner","filters",0)
        val fetchRevision=queue.tokenRevision()
        queue.setIntent("owner",false);queue.recordToken("authoritative-new-token")
        assertFalse(queue.recordFetchedToken("stale-fetched-token",fetchRevision))
        val cleanup=queue.next()!!;assertFalse(cleanup.enabled)
        queue.begin(cleanup,0);queue.finish(cleanup,true,1)
        queue.setIntent("owner",true)
        assertEquals("authoritative-new-token",queue.next()!!.token)
    }

}
