package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeVisibleThreadReadsTest {
    private class Fixture {
        var allowed=true
        val contexts=mutableListOf<Pair<String?,String?>>()
        val batches=mutableListOf<List<String>>()
        val acknowledgements=mutableListOf<(Boolean)->Unit>()
        val reads=VisibleThreadReads("peer","thread:chosen",{allowed},{peer,key->contexts.add(peer to key)},{ids,complete->batches.add(ids);acknowledgements.add(complete)})
    }
    @Test fun onlyVisibleCurrentAccountGetsBoundedAcknowledgedBatches() {
        val f=Fixture();val ids=(0 until 300).map {"incoming-$it"}
        f.reads.update(false,ids);assertTrue(f.batches.isEmpty());assertTrue(f.contexts.isEmpty())
        f.reads.update(true,ids);assertEquals(listOf(256),f.batches.map {it.size});assertEquals("peer" to "thread:chosen",f.contexts.last())
        f.acknowledgements[0](true);assertEquals(listOf(256,44),f.batches.map {it.size})
        f.acknowledgements[1](true);f.reads.update(true,ids);assertEquals(2,f.batches.size)
    }
    @Test fun backgroundAndCloseStopLateAcknowledgementFromReadingMore() {
        for(close in listOf(false,true)) {
            val f=Fixture();val ids=(0 until 300).map {"incoming-$it"};f.reads.update(true,ids)
            if(close)f.reads.close() else f.reads.update(false,ids)
            f.acknowledgements[0](true);assertEquals(1,f.batches.size);assertEquals(null to null,f.contexts.last())
        }
    }
    @Test fun accountSwapBlocksReadsAndLateContinuation() {
        val f=Fixture();f.allowed=false;f.reads.update(true,listOf("old-account"));assertTrue(f.batches.isEmpty())
        f.allowed=true;f.reads.update(true,(0 until 300).map {"incoming-$it"});f.allowed=false;f.acknowledgements[0](true);assertEquals(1,f.batches.size)
    }
    @Test fun failureRetriesOnlyAfterANewVisibleUpdate() {
        val f=Fixture();val ids=listOf("incoming-one");f.reads.update(true,ids);f.acknowledgements[0](false);assertEquals(1,f.batches.size)
        f.reads.update(true,ids);assertEquals(listOf(ids,ids),f.batches)
    }
}

class MessageViewportTest {
    @org.junit.Test fun offscreenAndThinEdgeRowsNeverBecomeSeen() {
        val rows=listOf(MessageViewportItem("old",-100,60),MessageViewportItem("visible",30,60),MessageViewportItem("new",450,60),MessageViewportItem("edge",395,60),MessageViewportItem("mine",100,60))
        org.junit.Assert.assertEquals(listOf("visible"),visibleIncomingMessages(rows,0,400,setOf("old","visible","new","edge")))
        org.junit.Assert.assertEquals(emptyList<String>(),visibleIncomingMessages(listOf(MessageViewportItem("tiny",400,1)),0,400,setOf("tiny")))
    }
    @org.junit.Test fun receiptsDistinguishRelaySentFromRecipientDeliveredAndSeen() {
        org.junit.Assert.assertEquals("Sent",messageDeliveryLabel("sent"))
        org.junit.Assert.assertEquals("Delivered",messageDeliveryLabel("delivered"))
        org.junit.Assert.assertEquals("Seen",messageDeliveryLabel("seen"))
        org.junit.Assert.assertEquals("Queued",messageDeliveryLabel("queued"))
    }
}
