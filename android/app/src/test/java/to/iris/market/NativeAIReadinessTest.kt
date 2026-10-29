package to.iris.market
import org.junit.Assert.*
import org.junit.Test
class NativeAIReadinessTest {
    @Test fun onStateRequiresPreferenceAndActualProviderReadiness() {
        assertFalse(NativeAIReadiness.isOn(true,"litert","model","",false))
        assertTrue(NativeAIReadiness.isOn(true,"litert","model","",true))
        assertFalse(NativeAIReadiness.isOn(false,"litert","model","",true))
        assertFalse(NativeAIReadiness.isOn(true,"litert","model","",true,preview=true))
        assertFalse(NativeAIReadiness.canEnable("compatible","","https://service.invalid/v1",true))
        assertTrue(NativeAIReadiness.canEnable("compatible","model","https://service.invalid/v1",false))
        assertFalse(NativeAIReadiness.canEnable("compatible","model","http://10.evil.invalid/v1",false))
        assertTrue(NativeAIReadiness.canEnable("ollama","model","http://172.16.2.3:11434",false))
        assertFalse(NativeAIReadiness.canEnable("compatible","model","https://user:secret@service.invalid/v1",false))
    }
    @Test fun workingLocalModelStaysReadyAndCannotFallThroughToLiteralSearch() {
        for(phase in listOf(LocalModelPhase.VERIFYING,LocalModelPhase.LOADING,LocalModelPhase.REVIEWING)) {
            val on=NativeAIReadiness.isOn(true,"litert","model","",NativeAIReadiness.localReady(phase))
            assertEquals(phase!=LocalModelPhase.VERIFYING,on)
            assertEquals(NativeAISearchAction.WAIT,NativeAIReadiness.searchAction(true,on,false,true,"bicycle"))
        }
        assertEquals(NativeAISearchAction.AI,NativeAIReadiness.searchAction(true,true,false,false,"bicycle"))
        assertEquals(NativeAISearchAction.TEXT,NativeAIReadiness.searchAction(false,false,false,false,"bicycle"))
        assertEquals(NativeAISearchAction.WAIT,NativeAIReadiness.searchAction(true,true,true,false,"bicycle"))
        assertTrue(NativeAIReadiness.canSelectLocalOnTap("compatible","","https://api.openai.com/v1"))
        assertFalse(NativeAIReadiness.canSelectLocalOnTap("compatible","selected-model","https://api.openai.com/v1"))
        assertFalse(NativeAIReadiness.canSelectLocalOnTap("compatible","","https://api.groq.com/openai/v1"))
    }

    @Test fun unavailableIntentRoutesSettingsAndCanAlwaysTurnOff() {
        assertEquals(NativeAISearchAction.SETTINGS,NativeAIReadiness.searchAction(true,false,false,false,"bicycle"))
        assertEquals(NativeAISearchAction.TEXT,NativeAIReadiness.searchAction(true,false,false,false,""))
        assertEquals(NativeAITapAction.OFF,NativeAIReadiness.tapAction(true,false,false))
        assertEquals(NativeAITapAction.ON,NativeAIReadiness.tapAction(false,true,true))
        assertEquals(NativeAITapAction.LOCAL,NativeAIReadiness.tapAction(false,false,true))
        assertEquals(NativeAITapAction.SETTINGS,NativeAIReadiness.tapAction(false,false,false))
        val gate=NativeAIIntentGate();val oldEditor=gate.current
        var enabled=true
        val off=gate.advance();gate.perform(off){enabled=false}
        assertNull(gate.perform(oldEditor){enabled=true})
        assertFalse(enabled)
        gate.perform(gate.advance()){enabled=true}
        assertTrue(enabled)
    }

}
