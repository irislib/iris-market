package to.iris.market

import android.app.Application
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import to.iris.market.core.MarketApp
import to.iris.market.core.generateSecretKey

data class Listing(
    val id: String, val author: String, val title: String, val description: String, val side: String,
    val price: String, val currency: String, val location: String, val category: String,
    val imageUrl: String?, val saved: Boolean, val mine: Boolean, val status: String,
    val delivery: String, val relevance: String?, val relevanceShow: Boolean?
) {
    val displayPrice: String get() = when {
        price.isBlank() -> "Let's talk"
        currency == "EUR" -> "€$price"
        currency == "USD" -> "$$price"
        currency == "GBP" -> "£$price"
        else -> "$price $currency"
    }
}
data class Message(val id: String, val text: String, val mine: Boolean)
data class Conversation(val id: String, val name: String, val messages: List<Message>)
data class MarketSnapshot(
    val publicKey: String = "", val demo: Boolean = false, val status: String = "Opening your market…",
    val error: String? = null, val query: String = "", val side: String = "all",
    val listings: List<Listing> = emptyList(), val savedCount: Int = 0,
    val settings: String = "{}", val conversations: List<Conversation> = emptyList(),
    val invite: String? = null
) {
    companion object {
        fun parse(raw: String): MarketSnapshot {
            val o = JSONObject(raw)
            val ls = o.optJSONArray("listings") ?: JSONArray()
            val cs = o.optJSONArray("conversations") ?: JSONArray()
            return MarketSnapshot(
                publicKey = o.optString("public_key"), demo = o.optBoolean("demo"),
                status = o.optString("status", "Ready"), error = o.optional("error"),
                query = o.optString("query"), side = o.optString("side", "all"),
                listings = (0 until ls.length()).map { i ->
                    val l = ls.getJSONObject(i)
                    Listing(l.getString("id"), l.optString("author"), l.getString("title"), l.optString("description"),
                        l.optString("side", "offer"), l.optString("price"), l.optString("currency", "EUR"),
                        l.optString("location"), l.optString("category", "Other"), l.optional("image_url"),
                        l.optBoolean("saved"), l.optBoolean("mine"), l.optString("status", "active"),
                        l.optString("delivery"), l.optJSONObject("relevance")?.optional("reason"),
                        l.optJSONObject("relevance")?.let { decision ->
                            if (decision.has("show") && !decision.isNull("show")) decision.optBoolean("show") else null
                        })
                }, savedCount = o.optInt("saved_count"),
                settings = (o.optJSONObject("settings") ?: JSONObject()).toString(),
                conversations = (0 until cs.length()).map { i ->
                    val c = cs.getJSONObject(i); val ms = c.optJSONArray("messages") ?: JSONArray()
                    Conversation(c.getString("id"), c.optString("name", "Conversation"),
                        (0 until ms.length()).map { j -> val m = ms.getJSONObject(j)
                            Message(m.getString("id"), m.optString("text"), m.optBoolean("mine")) })
                }, invite = o.optional("invite")
            )
        }
    }
}
private fun JSONObject.optional(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }

/** The Keystore key is non-exportable. Only authenticated ciphertext is written to disk. */
class SecureRecord(application: Application) {
    private val file = AtomicFile(File(application.noBackupFilesDir, "market-secrets.v1"))
    private val alias = "iris-market-record-v1"
    private val aad = "to.iris.market.secrets.v1".toByteArray()
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setKeySize(256).build())
            generateKey()
        }
    }
    private fun read(): JSONObject {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return JSONObject()
        val envelope = JSONObject(String(file.readFully(), Charsets.UTF_8))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)))
        cipher.updateAAD(aad)
        return JSONObject(String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), Charsets.UTF_8))
    }
    @Synchronized fun get(name: String): String = read().optString(name)
    @Synchronized fun put(name: String, value: String) {
        val values = read().put(name, value)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(aad)
        val envelope = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(values.toString().toByteArray()), Base64.NO_WRAP))
        val stream = file.startWrite()
        try { stream.write(envelope.toString().toByteArray()); file.finishWrite(stream) }
        catch (e: Exception) { file.failWrite(stream); throw e }
    }
}

class MarketModel(application: Application, private val preview: Boolean) : AndroidViewModel(application) {
    private val secure = SecureRecord(application)
    private var core: MarketApp? = null
    private val mutex = Mutex()
    private val mutable = MutableStateFlow(MarketSnapshot(demo = preview))
    val state = mutable.asStateFlow()
    private val working = MutableStateFlow(false)
    val busy = working.asStateFlow()
    private val alert = MutableStateFlow<String?>(null)
    val notice = alert.asStateFlow()
    @Volatile private var active = true
    private var operationCount = 0

    init {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val name = if (preview) "identity-preview" else "identity"
                val secret = secure.get(name).ifBlank { generateSecretKey().also { secure.put(name, it) } }
                val directory = File(application.filesDir, if (preview) "preview" else "market").apply { mkdirs() }
                mutex.withLock { core = MarketApp(directory.absolutePath, secret, preview); refreshSnapshot() }
                while (isActive) { delay(2_000); if (active) mutex.withLock { refreshSnapshot() } }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { alert.value = "Your market could not open. Close and reopen the app to try again." }
        }
    }
    fun setActive(value: Boolean) { active = value }
    private fun refreshSnapshot() { core?.let { mutable.value = MarketSnapshot.parse(it.snapshot()) } }
    fun dismissNotice() { alert.value = null }
    fun command(request: JSONObject, onSuccess: (() -> Unit)? = null) {
        viewModelScope.launch {
            operationCount += 1; working.value = true
            try {
                withContext(Dispatchers.IO) {
                    mutex.withLock {
                        val app = core ?: error("Not ready")
                        mutable.value = MarketSnapshot.parse(app.command(request.toString()))
                    }
                }
                onSuccess?.invoke()
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { alert.value = "That didn’t go through. Check your connection and details, then try again." }
            finally { operationCount -= 1; working.value = operationCount > 0 }
        }
    }
    fun filter(query: String, side: String) = command(JSONObject().put("type", "set_filter").put("query", query).put("side", side))
    fun save(id: String) = command(JSONObject().put("type", "save").put("id", id))
    fun action(type: String) = command(JSONObject().put("type", type))
    fun ai(type: String) {
        viewModelScope.launch {
            try {
                val provider = JSONObject(state.value.settings).optJSONObject("ai")?.optString("provider", "compatible") ?: "compatible"
                val key = withContext(Dispatchers.IO) { secure.get("ai-$provider") }
                command(JSONObject().put("type", type).put("api_key", key))
            } catch (_: Exception) { alert.value = "Could not unlock the saved provider key." }
        }
    }
    fun saveSettings(settings: JSONObject, provider: String, apiKey: String, replaceKey: Boolean, done: () -> Unit) {
        viewModelScope.launch {
            try {
                if (replaceKey) withContext(Dispatchers.IO) { secure.put("ai-$provider", apiKey) }
                command(JSONObject().put("type", "set_settings").put("settings", settings), done)
            } catch (_: Exception) { alert.value = "Could not securely save your provider key." }
        }
    }
    override fun onCleared() {
        super.onCleared()
        CoroutineScope(Dispatchers.IO).launch { mutex.withLock {
            runCatching { core?.shutdown() }; core?.close(); core = null
        } }
    }
}
