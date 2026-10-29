import Foundation

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
enum NativeProfileNames {
    private static let adjectives = ["Amber", "Analog", "Arcane", "Astral", "Aurora", "Azure", "Blissful", "Blooming", "Bold", "Bright", "Brilliant", "Calm", "Celestial", "Charming", "Clear", "Clever", "Cosmic", "Crimson", "Crystal", "Curious", "Daring", "Deep", "Dreamy", "Electric", "Emerald", "Ethereal", "Fabled", "Feral", "Festival", "Floating", "Fluent", "Free", "Friendly", "Gentle", "Glowing", "Golden", "Graceful", "Harmonic", "Hidden", "Honey", "Infinite", "Kind", "Laughing", "Liminal", "Lucid", "Lunar", "Lush", "Magnetic", "Mellow", "Mercury", "Midnight", "Mirrored", "Mystic", "Neon", "Nimble", "Noble", "Northern", "Nova", "Opal", "Open", "Pacific", "Patient", "Pearl", "Playful", "Polished", "Prismatic", "Quiet", "Radiant", "Restless", "River", "Ruby", "Saffron", "Secret", "Serene", "Signal", "Silver", "Solar", "Sparkling", "Spiral", "Stellar", "Still", "Stormy", "Sunny", "Swift", "Tender", "Verdant", "Velvet", "Vivid", "Warm", "Wandering", "Wild", "Wise", "Witty", "Wonder", "Zephyr"]
    private static let nouns = ["Anchor", "Archive", "Atlas", "Aurora", "Beacon", "Bloom", "Bridge", "Canvas", "Cascade", "Cipher", "Circuit", "Cloud", "Comet", "Compass", "Constellation", "Cove", "Daydream", "Drift", "Echo", "Ember", "Field", "Festival", "Flame", "Flux", "Forest", "Forge", "Fountain", "Garden", "Glacier", "Halo", "Harbor", "Harmony", "Hearth", "Horizon", "Lantern", "Library", "Lighthouse", "Lagoon", "Labyrinth", "Meadow", "Melody", "Mirage", "Mosaic", "Nebula", "Nimbus", "Nova", "Oasis", "Opal", "Orbit", "Orchard", "Paradox", "Pearl", "Planet", "Portal", "Prism", "Pulse", "Quartz", "Quest", "Radiance", "Rain", "Reef", "Riddle", "Ripple", "River", "Sanctuary", "Satellite", "Serenade", "Signal", "Solstice", "Spark", "Spectrum", "Spiral", "Starlight", "Station", "Studio", "Summit", "Sunrise", "Tempo", "Thread", "Tide", "Trail", "Valley", "Velvet", "Voyager", "Vortex", "Wave", "Wonder", "Zenith"]
    static func name(seed: String) -> String {
        let value = seed.trimmingCharacters(in: .whitespacesAndNewlines)
        var first: UInt32 = 2166136261, second: UInt32 = 2246822507
        for code in (value.isEmpty ? "iris" : value).utf16 {
            first = (first ^ UInt32(code)) &* 16777619
            second = (second ^ UInt32(code)) &* 2246822519
        }
        return "\(adjectives[Int(first) % adjectives.count]) \(nouns[Int(second) % nouns.count])"
    }
}

struct NativeAIProvider: Identifiable {
    let id: String, label: String, provider: String, endpoint: String
    let models: [(id: String, label: String)]
    let keyURL: String?
    let infoURL: String?
    static let presets: [NativeAIProvider] = [
        .init(id: "apple", label: "Apple on-device", provider: "apple", endpoint: "", models: [("apple-system", "Apple system model")], keyURL: nil, infoURL: nil),
        .init(id: "systemone", label: "Jev · free promotion", provider: "systemone", endpoint: "https://opencode.ai/inference/systemone/v1", models: [("jev-1.13-free", "Jev 1.13")], keyURL: "https://opencode.ai/v2/docs/console/models/", infoURL: "https://opencode.ai/v2/docs/console/models/"),
        .init(id: "gemini", label: "Gemini", provider: "compatible", endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", models: [("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"), ("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite")], keyURL: "https://aistudio.google.com/app/apikey", infoURL: "https://ai.google.dev/gemini-api/terms"),
        .init(id: "groq", label: "Groq · free quota", provider: "compatible", endpoint: "https://api.groq.com/openai/v1", models: [("openai/gpt-oss-20b", "GPT OSS 20B"), ("openai/gpt-oss-120b", "GPT OSS 120B")], keyURL: "https://console.groq.com/keys", infoURL: "https://console.groq.com/docs/rate-limits"),
        .init(id: "openai", label: "OpenAI · paid", provider: "compatible", endpoint: "https://api.openai.com/v1", models: [("gpt-6-luna", "GPT-6 Luna")], keyURL: "https://platform.openai.com/api-keys", infoURL: "https://openai.com/api/pricing/"),
        .init(id: "ollama", label: "Ollama", provider: "ollama", endpoint: "http://127.0.0.1:11434", models: [("gemma3:4b", "Gemma 3 · 4B"), ("gemma3:1b", "Gemma 3 · 1B")], keyURL: nil, infoURL: "https://ollama.com/library/gemma3"),
        .init(id: "anthropic", label: "Anthropic · paid", provider: "anthropic", endpoint: "https://api.anthropic.com/v1", models: [("claude-haiku-5-5", "Claude Haiku 5.5"), ("claude-sonnet-5-5", "Claude Sonnet 5.5")], keyURL: "https://platform.claude.com/", infoURL: "https://platform.claude.com/docs/en/models/overview"),
        .init(id: "custom", label: "Custom compatible service", provider: "compatible", endpoint: "", models: [], keyURL: nil, infoURL: nil)
    ]
    static func matching(_ ai: AISettings) -> NativeAIProvider {
        presets.first { $0.id != "custom" && $0.provider == ai.provider && (ai.provider == "apple" || $0.endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == ai.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) } ?? presets.last!
    }
}
let nativeCurrencyOptions = ["EUR", "USD", "GBP", "SEK", "NOK", "DKK", "CHF", "CAD", "AUD", "JPY", "CNY", "INR", "SATS", "BTC"]
