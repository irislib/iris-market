package to.iris.market
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
class NativeAITestTest {
    @Test fun isolatedLocalClassifierUsesOnlyEditableInputAndReturnsNoMatch() = runBlocking {
        var called=false
        val matched=NativeAITestRunner.run(NativeAITestInput("violin","Wooden office desk")) { batch ->
            called=true;assertEquals("violin",batch.interests);assertEquals(1,batch.candidates.size)
            assertEquals("Wooden office desk",batch.candidates.single().listing.description)
            val longQuery="q".repeat(1000);val longListing="d".repeat(2000)
            val prompt=LocalModelContract.prompt(longQuery,batch.candidates.single().listing.copy(description=longListing),sandbox=true)
            assertTrue(prompt.contains(longQuery));assertTrue(prompt.contains(longListing))
            listOf(LocalCurationDecision("settings-test",false,"Does not match"))
        }
        assertTrue(called);assertFalse(matched)
        assertEquals("No match · On-device · gemma · 42 ms",NativeAITestResult(false,42,"litert","gemma").summary)
    }
    @Test fun boundedInputsAndStaleQueuedCompletionsCannotReportSuccess() {
        assertNotNull(NativeAITestInput(" ","sample").validationError)
        assertNotNull(NativeAITestInput("é".repeat(501),"sample").validationError)
        assertNull(NativeAITestInput("é".repeat(500),"sample").validationError)
        assertNotNull(NativeAITestInput("test","x".repeat(2001)).validationError)
        val context=NativeAITestContext(1,2,"litert","gemma","",true)
        val session=NativeAITestSession();val submitted=session.invalidate()
        assertTrue(session.accepts(submitted,context,context));session.invalidate();assertFalse(session.accepts(submitted,context,context))
        val off=context.copy(enabled=false);assertTrue(session.accepts(session.revision,off,off))
        for(next in listOf(context.copy(account=2),context.copy(epoch=3),context.copy(provider="compatible",model="new",endpoint="https://example.invalid"),context.copy(enabled=false))) assertFalse(session.accepts(session.revision,context,next))
    }
}
