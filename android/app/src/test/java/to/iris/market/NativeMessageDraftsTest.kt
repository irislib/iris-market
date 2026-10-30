package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeMessageDraftsTest {
    @Test fun navigatingBetweenAccountsPeersAndContextsPreservesSeparateDrafts() {
        val drafts=NativeMessageDrafts()
        val general=NativeMessageDrafts.key("account-a","peer-a","general")
        val thread=NativeMessageDrafts.key("account-a","peer-a","thread:one")
        val other=NativeMessageDrafts.key("account-b","peer-a","general")
        drafts[general]="general draft";drafts[thread]="thread draft";drafts[other]="other account"
        assertEquals("general draft",drafts[NativeMessageDrafts.key("account-a","peer-a","*")])
        assertEquals("thread draft",drafts[thread]);assertEquals("other account",drafts[other])
        assertEquals("",drafts[NativeMessageDrafts.key("account-a","peer-b","general")])
    }
    @Test fun failedOrLateSuccessfulSendDoesNotEraseNewTyping() {
        val drafts=NativeMessageDrafts();val key=NativeMessageDrafts.key("account","peer","general")
        drafts[key]="sending";drafts.sent("sending",key,false);assertEquals("sending",drafts[key])
        drafts[key]="new typing";drafts.sent("sending",key,true);assertEquals("new typing",drafts[key])
        drafts.sent("new typing",key,true);assertEquals("",drafts[key]);assertTrue(drafts.snapshot().isEmpty())
    }
    @Test fun emptyOrUnscopedDraftsAreNotRetained() {
        val drafts=NativeMessageDrafts();val key=NativeMessageDrafts.key("account","peer","general")
        drafts[key]="text";drafts[key]="";drafts[NativeMessageDrafts.key("","peer","general")]="unscoped"
        assertTrue(drafts.snapshot().isEmpty())
    }
}
