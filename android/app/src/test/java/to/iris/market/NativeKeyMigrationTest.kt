package to.iris.market

import org.junit.Assert.*
import org.junit.Test

class NativeKeyMigrationTest {
    @Test fun clearedScopedKeyCannotReviveOnReopen() {
        val records = mutableMapOf("ai-compatible" to "legacy-secret")
        val read: (String)->String = { records[it] ?: "" }
        val write: (String,String)->Unit = { key,value -> records[key]=value }
        NativeKeyMigration.migrate("compatible","https://original.invalid/v1",{ "original-slot" },read,records::containsKey,write)
        assertEquals("legacy-secret",read("original-slot"))
        NativeKeyMigration.replace("compatible","original-slot","",write)
        // Simulate a stale copy/downgrade or failed legacy erasure.
        records["ai-compatible"]="legacy-secret"
        NativeKeyMigration.migrate("compatible","https://original.invalid/v1",{ "original-slot" },read,records::containsKey,write)
        assertEquals("",read("original-slot"))
    }
    @Test fun legacyKeyNeverMovesToAnotherEndpoint() {
        val records=mutableMapOf("ai-compatible" to "legacy-secret", "ai-legacy-endpoint-compatible" to "https://original.invalid/v1")
        NativeKeyMigration.migrate("compatible","https://different.invalid/v1",{ endpoint -> if(endpoint=="https://original.invalid/v1") "original-slot" else "other-slot" },{records[it] ?: ""},records::containsKey,{key,value -> records[key]=value})
        assertNull(records["other-slot"])
        assertEquals("legacy-secret",records["original-slot"])
        assertEquals("https://original.invalid/v1",records["ai-legacy-endpoint-compatible"])
    }
    @Test fun clearRemainsAuthoritativeIfLegacyEraseFails() {
        val records=mutableMapOf("ai-compatible" to "legacy-secret")
        val write: (String,String)->Unit={key,value -> if(key=="ai-compatible") throw IllegalStateException("storage interruption") else records[key]=value}
        try { NativeKeyMigration.replace("compatible","original-slot","",write);fail("Expected simulated storage interruption") } catch (_:IllegalStateException) {}
        NativeKeyMigration.migrate("compatible","https://original.invalid/v1",{ "original-slot" },{records[it] ?: ""},records::containsKey,{key,value -> records[key]=value})
        assertEquals("",records["original-slot"])
        assertEquals("1",records["ai-legacy-migrated-compatible"])
    }
    @Test fun previouslyClearedEmptyScopedRecordIsPreservedDuringMigration() {
        val records=mutableMapOf("ai-compatible" to "legacy-secret", "original-slot" to "")
        NativeKeyMigration.migrate("compatible","https://original.invalid/v1",{ "original-slot" },{records[it] ?: ""},records::containsKey,{key,value -> records[key]=value})
        assertEquals("",records["original-slot"])
        assertEquals("",records["ai-compatible"])
    }

}
