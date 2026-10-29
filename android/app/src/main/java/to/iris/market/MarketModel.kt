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
import to.iris.market.core.MarketDeviceLink
import to.iris.market.core.publicKeyForSecret
import to.iris.market.core.registerIdentityDevice

data class Listing(
    val id: String, val author: String, val title: String, val description: String, val side: String,
    val price: String, val currency: String, val location: String, val category: String,
    val imageUrl: String?, val saved: Boolean, val mine: Boolean, val status: String,
    val delivery: String, val relevance: String?, val relevanceShow: Boolean?, val coordinates: List<Double>? = null
) {
    val displayPrice: String get() = when {
        price.isBlank() -> "Let's talk"
        currency == "EUR" -> "€$price"
        currency == "USD" -> "$$price"
        currency == "GBP" -> "£$price"
        else -> "$price $currency"
    }
    companion object {
        fun parse(l: JSONObject) = Listing(l.getString("id"), l.optString("author"), l.getString("title"), l.optString("description"),
            l.optString("side", "offer"), l.optString("price"), l.optString("currency", "EUR"),
            l.optString("location"), l.optString("category", "Other"), l.optional("image_url"),
            l.optBoolean("saved"), l.optBoolean("mine"), l.optString("status", "active"),
            l.optString("delivery"), l.optJSONObject("relevance")?.optional("reason"),
            l.optJSONObject("relevance")?.let { decision ->
                if (decision.has("show") && !decision.isNull("show")) decision.optBoolean("show") else null
            }, l.optJSONArray("coordinates")?.let { a -> if (a.length()==2) listOf(a.optDouble(0),a.optDouble(1)).takeIf { values -> values.all { it.isFinite() } } else null })
    }

}
data class Message(val id: String, val text: String, val mine: Boolean, val orderId: String? = null, val cashu: CashuPayment? = null)
data class Conversation(val id: String, val name: String, val messages: List<Message>)
data class MarketSnapshot(
    val publicKey: String = "", val canSign: Boolean = false, val messagingReady: Boolean = false, val demo: Boolean = false, val status: String = "Opening your market…",
    val error: String? = null, val query: String = "", val side: String = "offer",
    val listings: List<Listing> = emptyList(), val savedCount: Int = 0,
    val settings: String = "{}", val conversations: List<Conversation> = emptyList(),
    val invite: String? = null, val aiSearch: Boolean = false, val sort: String = "suggested",
    val orders: List<MarketOrder> = emptyList(), val liveLocationSupported: Boolean = false,
    val people: Map<String, PublicPerson> = emptyMap(), val profile: PublicProfile? = null, val graphContextLoaded: Boolean = false,
    val profileListings: ProfileListings? = null
) {
    companion object {
        fun parse(raw: String): MarketSnapshot {
            val o = JSONObject(raw)
            val ls = o.optJSONArray("listings") ?: JSONArray()
            val cs = o.optJSONArray("conversations") ?: JSONArray()
            return MarketSnapshot(
                publicKey = o.optString("public_key"), canSign = o.optBoolean("can_sign"), messagingReady = o.optBoolean("messaging_ready"), demo = o.optBoolean("demo"),
                status = o.optString("status", "Ready"), error = o.optional("error"),
                query = o.optString("query"), side = o.optString("side", "offer"),
                listings = (0 until ls.length()).map { Listing.parse(ls.getJSONObject(it)) }, savedCount = o.optInt("saved_count"),
                settings = (o.optJSONObject("settings") ?: JSONObject()).toString(),
                conversations = (0 until cs.length()).map { i ->
                    val c = cs.getJSONObject(i); val ms = c.optJSONArray("messages") ?: JSONArray()
                    Conversation(c.getString("id"), c.optString("name", "Conversation"),
                        (0 until ms.length()).map { j -> val m = ms.getJSONObject(j)
                            Message(m.getString("id"), m.optString("text"), m.optBoolean("mine"), m.optional("order_id"), m.optJSONObject("cashu")?.let(CashuPayment::parse)) })
                }, invite = o.optional("invite"), aiSearch = o.optBoolean("ai_search"), sort = o.optString("sort", "suggested"),
                liveLocationSupported = o.optBoolean("live_location_supported", false),
                orders = o.optJSONArray("orders")?.let { a -> (0 until a.length()).map { MarketOrder.parse(a.getJSONObject(it)) } } ?: emptyList(),
                people = o.optJSONObject("people")?.let { people -> people.keys().asSequence().associateWith { PublicPerson.parse(people.getJSONObject(it)) } } ?: emptyMap(),
                profile = o.optJSONObject("profile")?.let(PublicProfile::parse), graphContextLoaded = o.optBoolean("graph_context_loaded"),
                profileListings = o.optJSONObject("profile_listings")?.let(ProfileListings::parse)
            )
        }
    }
}
private fun JSONObject.optional(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }

/** The Keystore key is non-exportable. Only authenticated ciphertext is written to disk. */
class SecureRecord(application: Application) {
    private companion object { val recordLock = Any() }
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
    fun get(name: String): String = synchronized(recordLock) { read().optString(name) }
    fun put(name: String, value: String) = synchronized(recordLock) {
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
    private var accountGeneration = 0L
    private val linking = MutableStateFlow<String?>(null)
    val deviceLinkUrl = linking.asStateFlow()
    private var linkJob: Job? = null

    init {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                mutex.withLock { openSavedAccount() }
                while (isActive) { delay(2_000); if (active) mutex.withLock { refreshSnapshot() } }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { alert.value = "Your market could not open. Close and reopen the app to try again." }
        }
    }
    private fun openSavedAccount() {
        accountGeneration += 1
        core?.shutdown();core?.close();core=null
        val application=getApplication<Application>()
        val name=if(preview) "identity-preview" else "identity"
        val legacy=secure.get(name).ifBlank {generateSecretKey().also {
            if(!preview) secure.put("identity-bootstrap",publicKeyForSecret(it))
            secure.put(name,it)
        }}
        val owner=if(preview) "" else secure.get("active-account")
        val saved=if(owner.isBlank()) "" else secure.get("account-$owner")
        check(owner.isBlank() || saved.isNotBlank()) { "Active account credentials are unavailable" }
        val base=File(application.filesDir,if(preview) "preview" else "market")
        if(saved.isNotBlank()) {
            val bundle=JSONObject(saved)
            val directory=if(bundle.optBoolean("legacy")) base else File(base,"accounts/$owner")
            directory.mkdirs()
            core=MarketApp.withIdentity(directory.absolutePath,owner,bundle.optional("secret"),bundle.getString("device"),bundle.optional("authorization"))
        } else {
            base.mkdirs()
            core=if(!preview && secure.get("identity-bootstrap")==publicKeyForSecret(legacy)) {
                MarketApp.freshProfile(base.absolutePath,legacy).also {secure.put("identity-bootstrap","")}
            } else MarketApp(base.absolutePath,legacy,preview)
        }
        core?.command(JSONObject().put("type", "set_filter").put("query", "").put("side", "offer").put("ai_search", false).toString())
        refreshSnapshot()
    }
    fun signIn(secret: String, done:()->Unit) {
        if(preview||working.value)return
        viewModelScope.launch {
            working.value=true;alert.value=null
            try {
                val saved=withContext(Dispatchers.IO) {
                    mutex.withLock {
                        val owner=publicKeyForSecret(secret)
                        val prior=secure.get("account-$owner")
                        val legacy=secure.get("identity")
                        val usesLegacy=legacy.isNotBlank()&&publicKeyForSecret(legacy)==owner
                        val bundle=if(prior.isNotBlank()) JSONObject(prior) else JSONObject().put("owner",owner).put("device",if(usesLegacy)legacy else generateSecretKey()).put("legacy",usesLegacy)
                        bundle.put("secret",secret)
                        val relays=JSONObject(state.value.settings).optJSONArray("relays")?.toString() ?: "[]"
                        // Durable local identity and core open do not await relay discovery.
                        secure.put("account-$owner",bundle.toString());secure.put("active-account",owner)
                        openSavedAccount()
                        NativeEnrollment(owner,bundle.getString("device"),relays,accountGeneration)
                    }
                }
                done()
                viewModelScope.launch(Dispatchers.IO) {
                    try {
                        // No core mutex is held during the blocking enrollment call.
                        val proof=registerIdentityDevice(secret,saved.device,saved.relays)
                        ensureActive()
                        mutex.withLock {
                            ensureActive()
                            if(accountGeneration!=saved.generation || secure.get("active-account")!=saved.owner)return@withLock
                            val current=JSONObject(secure.get("account-${saved.owner}"))
                            if(current.getString("device")!=saved.device)return@withLock
                            current.put("authorization",proof);secure.put("account-${saved.owner}",current.toString())
                            // Core verifies the published proof on its isolated owner-roster
                            // stream; the UI never overrides messagingReady.
                            refreshSnapshot()
                        }
                    } catch(e:CancellationException) {throw e}
                    catch(_:Exception) {
                        mutex.withLock {
                            if(isActive && accountGeneration==saved.generation && runCatching {secure.get("active-account")}.getOrNull()==saved.owner)
                                alert.value="Your profile is ready. Private messaging is waiting for device approval; sign in again to retry."
                        }
                    }
                }
            } catch(e:CancellationException) {throw e}
            catch(_:Exception) {alert.value="Could not save this profile. Check the key and try again."}
            finally {working.value=operationCount>0}
        }
    }
    private data class NativeEnrollment(val owner:String,val device:String,val relays:String,val generation:Long)
    fun beginDeviceLink() {
        if(preview||working.value)return
        closeDeviceLink()
        linkJob=viewModelScope.launch {
            working.value=true;alert.value=null
            var link:MarketDeviceLink?=null
            try {
                val secret=withContext(Dispatchers.IO) {secure.get("device-link-secret").ifBlank {generateSecretKey().also {secure.put("device-link-secret",it)}}}
                val activeLink=withContext(Dispatchers.IO) {
                    MarketDeviceLink(secret,secure.get("device-link-bootstrap").ifBlank {null},"wss://temp.iris.to").also {secure.put("device-link-bootstrap",it.bootstrap())}
                }
                link=activeLink
                linking.value=activeLink.invitation();working.value=false
                val accountRoot=File(getApplication<Application>().filesDir,"market/accounts")
                while(isActive) {
                    try {
                        val approval=withContext(Dispatchers.IO) {activeLink.poll(accountRoot.absolutePath).also {secure.put("device-link-bootstrap",activeLink.bootstrap())}}
                        if(approval!=null) {
                            ensureActive()
                            val result=JSONObject(approval);val owner=result.getString("owner_public_key")
                            val bundle=JSONObject().put("owner",owner).put("device",secret).put("authorization",result.getJSONObject("authorization").toString()).put("legacy",false)
                            // Main-thread commit cannot race the user's Cancel action.
                            secure.put("account-$owner",bundle.toString());secure.put("active-account",owner)
                            secure.put("device-link-secret","");secure.put("device-link-bootstrap","")
                            withContext(Dispatchers.IO) {mutex.withLock {openSavedAccount()}}
                            linking.value=null;break
                        }
                    } catch(e:CancellationException) {throw e}
                    catch(_:Exception) {alert.value="Waiting for the device approval server. Trying again…"}
                    delay(4_000)
                }
            } catch(e:CancellationException) {throw e}
            catch(_:Exception) {alert.value="Could not start device linking. Try again."}
            finally {link?.close();working.value=false}
        }
    }
    fun closeDeviceLink() {linkJob?.cancel();linkJob=null;linking.value=null}
    fun setActive(value: Boolean) { active = value }
    private fun refreshSnapshot() { core?.let { mutable.value = MarketSnapshot.parse(it.snapshot()) } }
    fun dismissNotice() { alert.value = null }
    fun command(request: JSONObject, onSuccess: (() -> Unit)? = null) = submit(request, onSuccess, null)
    fun orderCommand(request: JSONObject, onSuccess: () -> Unit = {}, onError: (String) -> Unit) = submit(request, onSuccess, onError)
    private fun submit(request: JSONObject, onSuccess: (() -> Unit)?, onError: ((String) -> Unit)?) {
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
            catch (_: Exception) {
                val message = "Couldn’t save that change. Check the details and try again."
                if (onError != null) onError(message) else alert.value = message
            }
            finally { operationCount -= 1; working.value = operationCount > 0 }
        }
    }
    fun filter(query: String, side: String, aiSearch: Boolean = false) = command(JSONObject().put("type", "set_filter").put("query", query).put("side", side).put("ai_search", aiSearch))
    fun searchAI(query: String, side: String) = command(JSONObject().put("type", "set_filter").put("query", query).put("side", side).put("ai_search", true)) { ai("curate") }
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

data class ProfileListings(val author: String, val listings: List<Listing>, val loading: Boolean, val canLoadMore: Boolean, val error: String?) {
    companion object {
        fun parse(o: JSONObject): ProfileListings {
            val author = o.getString("author")
            val rows = o.optJSONArray("listings") ?: JSONArray()
            return ProfileListings(author, (0 until rows.length()).map { Listing.parse(rows.getJSONObject(it)) }.filter { it.author == author },
                o.optBoolean("loading"), o.optBoolean("can_load_more"), o.optional("error"))
        }
    }
}

data class PublicConnection(val badge: String?, val distance: Int?, val knownFollowers: Int, val description: String) {
    companion object { fun parse(o: JSONObject) = PublicConnection(o.optional("badge"), if(o.isNull("follow_distance")) null else o.optInt("follow_distance"), o.optInt("followed_by_friends"), o.optString("description")) }
}
data class PublicPerson(val author: String, val name: String, val pictureUrl: String?, val connection: PublicConnection) {
    companion object {
        fun unnamed(author: String) = PublicPerson(author,"Unnamed user",null,PublicConnection(null,null,0,""))
        fun parse(o: JSONObject) = PublicPerson(o.getString("author"), o.optString("name","Unnamed user"), o.optional("picture_url"), PublicConnection.parse(o.getJSONObject("connection")))
    }
}
data class PublicProfile(val person: PublicPerson, val about: String, val website: String?, val following: List<PublicPerson>, val followingCount: Int,
    val followers: List<PublicPerson>, val known: List<PublicPerson>, val graphLabel: String, val graphLoaded: Boolean, val coverage: String, val loading: Boolean, val error: String?) {
    companion object {
        fun parse(o: JSONObject): PublicProfile {
            fun people(key: String): List<PublicPerson> { val a = o.optJSONArray(key) ?: return emptyList(); return (0 until a.length()).map { PublicPerson.parse(a.getJSONObject(it)) } }
            return PublicProfile(PublicPerson.parse(o.getJSONObject("person")),o.optString("about"),o.optional("website"),people("following"),o.optInt("following_count"),
                people("followers"),people("followed_by_known"),o.optString("graph_label"),o.optBoolean("graph_context_loaded"),o.optString("coverage"),o.optBoolean("loading"),o.optional("error"))
        }
    }
}
