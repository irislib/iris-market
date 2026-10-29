package to.iris.market

/*
Iris Kit @iris/svelte-ui profile helpers. The source package declares MIT.
Source commit: f412197215d78fb5fdb02f8a444f189d0bec1d8d

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Word lists and UTF-16 hash behavior match web/src/shared/iris-kit/profile.ts.
*/
object NativeProfileNames {
    private val adjectives = listOf("Amber", "Analog", "Arcane", "Astral", "Aurora", "Azure", "Blissful", "Blooming", "Bold", "Bright", "Brilliant", "Calm", "Celestial", "Charming", "Clear", "Clever", "Cosmic", "Crimson", "Crystal", "Curious", "Daring", "Deep", "Dreamy", "Electric", "Emerald", "Ethereal", "Fabled", "Feral", "Festival", "Floating", "Fluent", "Free", "Friendly", "Gentle", "Glowing", "Golden", "Graceful", "Harmonic", "Hidden", "Honey", "Infinite", "Kind", "Laughing", "Liminal", "Lucid", "Lunar", "Lush", "Magnetic", "Mellow", "Mercury", "Midnight", "Mirrored", "Mystic", "Neon", "Nimble", "Noble", "Northern", "Nova", "Opal", "Open", "Pacific", "Patient", "Pearl", "Playful", "Polished", "Prismatic", "Quiet", "Radiant", "Restless", "River", "Ruby", "Saffron", "Secret", "Serene", "Signal", "Silver", "Solar", "Sparkling", "Spiral", "Stellar", "Still", "Stormy", "Sunny", "Swift", "Tender", "Verdant", "Velvet", "Vivid", "Warm", "Wandering", "Wild", "Wise", "Witty", "Wonder", "Zephyr")
    private val nouns = listOf("Anchor", "Archive", "Atlas", "Aurora", "Beacon", "Bloom", "Bridge", "Canvas", "Cascade", "Cipher", "Circuit", "Cloud", "Comet", "Compass", "Constellation", "Cove", "Daydream", "Drift", "Echo", "Ember", "Field", "Festival", "Flame", "Flux", "Forest", "Forge", "Fountain", "Garden", "Glacier", "Halo", "Harbor", "Harmony", "Hearth", "Horizon", "Lantern", "Library", "Lighthouse", "Lagoon", "Labyrinth", "Meadow", "Melody", "Mirage", "Mosaic", "Nebula", "Nimbus", "Nova", "Oasis", "Opal", "Orbit", "Orchard", "Paradox", "Pearl", "Planet", "Portal", "Prism", "Pulse", "Quartz", "Quest", "Radiance", "Rain", "Reef", "Riddle", "Ripple", "River", "Sanctuary", "Satellite", "Serenade", "Signal", "Solstice", "Spark", "Spectrum", "Spiral", "Starlight", "Station", "Studio", "Summit", "Sunrise", "Tempo", "Thread", "Tide", "Trail", "Valley", "Velvet", "Voyager", "Vortex", "Wave", "Wonder", "Zenith")
    fun name(seed: String): String {
        val value = seed.trim().ifEmpty { "iris" }
        var first = 2166136261u; var second = 2246822507u
        for (code in value) { first = (first xor code.code.toUInt()) * 16777619u; second = (second xor code.code.toUInt()) * 2246822519u }
        return "${adjectives[(first % adjectives.size.toUInt()).toInt()]} ${nouns[(second % nouns.size.toUInt()).toInt()]}"
    }
}

data class NativeAIProvider(val id: String, val label: String, val provider: String, val endpoint: String,
    val models: List<Pair<String,String>>, val keyURL: String? = null, val infoURL: String? = null)
object NativePreferences {
    val currencies = listOf("EUR", "USD", "GBP", "SEK", "NOK", "DKK", "CHF", "CAD", "AUD", "JPY", "CNY", "INR", "SATS", "BTC")
    val providers = listOf(
        NativeAIProvider("litert","On device · Gemma 4","litert","",listOf(LocalModelManifest.ID to "Gemma 4 E2B")),
        NativeAIProvider("systemone","Jev · free promotion","systemone","https://opencode.ai/inference/systemone/v1",listOf("jev-1.13-free" to "Jev 1.13"),"https://opencode.ai/v2/docs/console/models/","https://opencode.ai/v2/docs/console/models/"),
        NativeAIProvider("gemini","Gemini","compatible","https://generativelanguage.googleapis.com/v1beta/openai",listOf("gemini-3.5-flash-lite" to "Gemini 3.5 Flash-Lite","gemini-3.1-flash-lite" to "Gemini 3.1 Flash-Lite"),"https://aistudio.google.com/app/apikey","https://ai.google.dev/gemini-api/terms"),
        NativeAIProvider("groq","Groq · free quota","compatible","https://api.groq.com/openai/v1",listOf("openai/gpt-oss-20b" to "GPT OSS 20B","openai/gpt-oss-120b" to "GPT OSS 120B"),"https://console.groq.com/keys","https://console.groq.com/docs/rate-limits"),
        NativeAIProvider("openai","OpenAI · paid","compatible","https://api.openai.com/v1",listOf("gpt-6-luna" to "GPT-6 Luna"),"https://platform.openai.com/api-keys","https://openai.com/api/pricing/"),
        NativeAIProvider("ollama","Ollama","ollama","http://127.0.0.1:11434",listOf("gemma3:4b" to "Gemma 3 · 4B","gemma3:1b" to "Gemma 3 · 1B"),infoURL="https://ollama.com/library/gemma3"),
        NativeAIProvider("anthropic","Anthropic · paid","anthropic","https://api.anthropic.com/v1",listOf("claude-haiku-5-5" to "Claude Haiku 5.5","claude-sonnet-5-5" to "Claude Sonnet 5.5"),"https://platform.claude.com/","https://platform.claude.com/docs/en/models/overview"),
        NativeAIProvider("custom","Custom compatible service","compatible","",emptyList())
    )
    fun matching(provider: String, endpoint: String) = providers.firstOrNull { it.id!="custom" && it.provider==provider && (provider=="litert" || it.endpoint.trimEnd('/')==endpoint.trimEnd('/')) } ?: providers.last()
    fun keySlot(provider: String, endpoint: String): String {
        val normalized = endpoint.trim().trimEnd('/')
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        return "ai-v2-$provider-$hash"
    }
}
