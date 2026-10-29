package to.iris.market

enum class NativeAISearchAction { WAIT, AI, TEXT, SETTINGS }
enum class NativeAITapAction { OFF, ON, LOCAL, SETTINGS }
object NativeAIReadiness {
    fun tapAction(enabled: Boolean,ready: Boolean,localFallback: Boolean): NativeAITapAction =
        if(enabled) NativeAITapAction.OFF else if(ready) NativeAITapAction.ON else if(localFallback) NativeAITapAction.LOCAL else NativeAITapAction.SETTINGS
    fun searchAction(intentOn: Boolean,ready: Boolean,busy: Boolean,inference: Boolean,query: String): NativeAISearchAction =
        if(busy||inference) NativeAISearchAction.WAIT else if(query.isBlank()||!intentOn) NativeAISearchAction.TEXT else if(ready) NativeAISearchAction.AI else NativeAISearchAction.SETTINGS
    fun localReady(phase: LocalModelPhase) = phase in setOf(LocalModelPhase.DOWNLOADED,LocalModelPhase.LOADING,LocalModelPhase.REVIEWING)
    fun canSelectLocalOnTap(provider: String,model: String,endpoint: String): Boolean =
        provider.isEmpty() || provider=="none" || provider=="compatible"&&model.isBlank()&&endpoint.trimEnd('/') in setOf("","https://api.openai.com/v1")
    fun canEnable(provider: String, model: String, endpoint: String, localAvailable: Boolean, preview: Boolean = false): Boolean {
        if(preview) return false
        if(provider=="litert") return localAvailable
        if(model.isBlank()) return false
        if(provider !in setOf("compatible","ollama","anthropic","systemone")) return false
        return runCatching {
            val uri=java.net.URI(endpoint);val host=uri.host ?: return false
            val address=host.lowercase().trim('[',']')
            val parts=address.split('.')
            val octets=parts.mapNotNull { it.toIntOrNull() }
            val privateIPv4=parts.size==4 && octets.size==4 && octets.all { it in 0..255 } && (octets[0]==127 || octets[0]==10 || octets[0]==192&&octets[1]==168 || octets[0]==172&&octets[1] in 16..31)
            val privateIPv6=address=="::1" || address.contains(':')&&(address.startsWith("fc")||address.startsWith("fd"))
            uri.rawUserInfo==null && uri.rawQuery==null && uri.rawFragment==null &&
                (uri.scheme.equals("https",true) || uri.scheme.equals("http",true) && (address=="localhost" || privateIPv4 || privateIPv6))
        }.getOrDefault(false)
    }
    fun isOn(enabled: Boolean, provider: String, model: String, endpoint: String, localAvailable: Boolean, preview: Boolean = false) =
        enabled && canEnable(provider,model,endpoint,localAvailable,preview)
}
