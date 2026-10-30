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
import kotlinx.coroutines.flow.update
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
    val delivery: String, val relevance: String?, val relevanceShow: Boolean?, val coordinates: List<Double>? = null,
    val serviceAreas: String? = null, val priceDisplay: PriceDisplay? = null, val expiresAt: Long? = null, val tags: List<String> = emptyList(), val createdAt: Long = 0
) {
    val localSearchRevision: String get() {
        val content = listOf(title, description, side, price, currency, location, category).joinToString("\u0000")
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8))
        return "$id|$createdAt|${digest.joinToString("") { "%02x".format(it) }}"
    }
    val displayPrice: String get() {
        if (price.isBlank()) return "Let's talk"
        val amount = priceDisplay?.amount ?: price.toDoubleOrNull() ?: return "$price $currency"
        if (!amount.isFinite()) return "$price $currency"
        if (amount == 0.0) return "Free"
        val code = (priceDisplay?.currency ?: currency).uppercase()
        val suffix = if(priceDisplay?.stale == true) " · older rate" else ""
        if (code in setOf("SAT", "SATS", "BTC")) {
            val formatter = java.text.NumberFormat.getNumberInstance().apply { maximumFractionDigits = if(code=="BTC") 8 else 0 }
            return "${formatter.format(amount)} ${if(code=="BTC") "BTC" else "sats"}$suffix"
        }
        return runCatching { java.text.NumberFormat.getCurrencyInstance().apply { this.currency = java.util.Currency.getInstance(code) }.format(amount) }.getOrDefault("$amount $code") + suffix
    }
    companion object {
        fun parse(l: JSONObject) = Listing(l.getString("id"), l.optString("author"), l.getString("title"), l.optString("description"),
            l.optString("side", "offer"), l.optString("price"), l.optString("currency", "EUR"),
            l.optString("location"), l.optString("category", "Other"), l.optional("image_url"),
            l.optBoolean("saved"), l.optBoolean("mine"), l.optString("status", "active"),
            l.optString("delivery"), l.optJSONObject("relevance")?.optional("reason"),
            l.optJSONObject("relevance")?.let { decision ->
                if (decision.has("show") && !decision.isNull("show")) decision.optBoolean("show") else null
            }, l.optJSONArray("coordinates")?.let { a -> if (a.length()==2) listOf(a.optDouble(0),a.optDouble(1)).takeIf { values -> values.all { it.isFinite() } } else null },
            l.optJSONObject("service_areas")?.toString()?.takeIf { it.toByteArray(Charsets.UTF_8).size <= 32832 },
            l.optJSONObject("display_price")?.let { d -> PriceDisplay(d.optDouble("amount"),d.optString("currency"),d.optBoolean("approximate"),d.optBoolean("stale")) },
            if(l.has("expires_at")&&!l.isNull("expires_at")) l.getLong("expires_at") else null,
            l.optJSONArray("tags")?.let { a -> (0 until minOf(a.length(),64)).map { a.optString(it) } } ?: emptyList(), l.optLong("created_at"))
    }

}
data class PriceDisplay(val amount: Double, val currency: String, val approximate: Boolean, val stale: Boolean)
data class MessageContext(val threadId:String,val orderId:String?=null,val listing:String?=null) {
    val key:String get()=orderId?.let { "order:$it" }?:"thread:$threadId"
    fun json()=JSONObject().put("thread_id",threadId).apply { orderId?.let { put("order_id",it) };listing?.let { put("listing",it) } }
    companion object { fun order(id:String)=MessageContext(id.substringAfterLast(':'),id)
        fun parse(value:JSONObject)=MessageContext(value.getString("thread_id"),value.optional("order_id"),value.optional("listing")) }
}
data class MessageReaction(val emoji:String,val count:Int,val reactedByMe:Boolean)
data class Message(val id: String, val text: String, val mine: Boolean, val orderId: String? = null, val cashu: CashuPayment? = null,val context:MessageContext?=null,val createdAt:Long=0L,val delivery:String?=null,val reactions:List<MessageReaction> = emptyList()) {
    val threadKey:String get()=orderId?.let { "order:$it" }?:context?.key?:"general"
}
data class Conversation(val id: String, val name: String, val messages: List<Message>)
data class SearchDiscoveryStatus(val loading: Boolean, val hasMore: Boolean)
data class MarketSnapshot(
    val publicKey: String = "", val canSign: Boolean = false, val messagingReady: Boolean = false, val demo: Boolean = false, val status: String = "Opening your market…",
    val error: String? = null, val query: String = "", val side: String = "offer",
    val listings: List<Listing> = emptyList(), val savedCount: Int = 0,
    val settings: String = "{}", val conversations: List<Conversation> = emptyList(),
    val invite: String? = null, val aiSearch: Boolean = false, val sort: String = "suggested",
    val orders: List<MarketOrder> = emptyList(), val liveLocationSupported: Boolean = false,
    val people: Map<String, PublicPerson> = emptyMap(), val profile: PublicProfile? = null, val graphContextLoaded: Boolean = false,
    val profileListings: ProfileListings? = null,
    val localCuration: LocalCurationBatch? = null,
    val searchDiscovery: SearchDiscoveryStatus? = null,
    val searchGeneration: Long = 0, val searchPlanPending: Boolean = false, val searchPlanTags: List<String> = emptyList(),
    val satsDisplayPrice: PriceDisplay? = null,
    val supportedCurrencies: List<String> = emptyList(),
    val revision: Long = 0, val aiMessage: String? = null, val aiTestResult: NativeAITestResult? = null, val savedListings: List<Listing>? = null, val aiConfigured: Boolean = true, val profileNameRequired: Boolean = false
) {
    companion object {
        fun parse(raw: String): MarketSnapshot {
            val o = JSONObject(raw)
            val ls = o.optJSONArray("listings") ?: JSONArray()
            val cs = o.optJSONArray("conversations") ?: JSONArray()
            return MarketSnapshot(
                publicKey = o.optString("public_key"), canSign = o.optBoolean("can_sign"), messagingReady = o.optBoolean("messaging_ready"), demo = o.optBoolean("demo"),
                status = o.optString("status", "Ready"), error = o.optional("error"), revision = o.optLong("revision"), aiMessage = o.optional("ai_message"), aiTestResult=o.optJSONObject("ai_test_result")?.let {NativeAITestResult.parse(it)},
                query = o.optString("query"), side = o.optString("side", "offer"),
                listings = (0 until ls.length()).map { Listing.parse(ls.getJSONObject(it)) }, savedCount = o.optInt("saved_count"),
                settings = (o.optJSONObject("settings") ?: JSONObject()).toString(),
                supportedCurrencies = o.optJSONArray("supported_currencies")?.let { list -> (0 until list.length()).map { list.getString(it) } } ?: emptyList(),
                satsDisplayPrice = o.optJSONObject("sats_display_price")?.let { d -> PriceDisplay(d.optDouble("amount"),d.optString("currency"),d.optBoolean("approximate"),d.optBoolean("stale")) },
                savedListings = o.optJSONArray("saved_listings")?.let { a -> (0 until a.length()).map { Listing.parse(a.getJSONObject(it)) } },
                aiConfigured = o.optBoolean("ai_configured",true), profileNameRequired = o.optBoolean("profile_name_required"),
                conversations = (0 until cs.length()).map { i ->
                    val c = cs.getJSONObject(i); val ms = c.optJSONArray("messages") ?: JSONArray()
                    Conversation(c.getString("id"), c.optString("name", "Conversation"),
                        (0 until ms.length()).map { j -> val m = ms.getJSONObject(j)
                            Message(m.getString("id"), m.optString("text"), m.optBoolean("mine"), m.optional("order_id"), m.optJSONObject("cashu")?.let(CashuPayment::parse),m.optJSONObject("context")?.let(MessageContext::parse),createdAt=m.optLong("created_at",0L),delivery=m.optional("delivery"),reactions=m.optJSONArray("reactions")?.let { values -> (0 until values.length()).map { i -> values.getJSONObject(i).let { reaction -> MessageReaction(reaction.getString("emoji"),reaction.getInt("count"),reaction.optBoolean("reacted_by_me")) } } } ?: emptyList()) })
                }, invite = o.optional("invite"), aiSearch = o.optBoolean("ai_search"), sort = o.optString("sort", "suggested"),
                liveLocationSupported = o.optBoolean("live_location_supported", false),
                orders = o.optJSONArray("orders")?.let { a -> (0 until a.length()).map { MarketOrder.parse(a.getJSONObject(it)) } } ?: emptyList(),
                people = o.optJSONObject("people")?.let { people -> people.keys().asSequence().associateWith { PublicPerson.parse(people.getJSONObject(it)) } } ?: emptyMap(),
                profile = o.optJSONObject("profile")?.let(PublicProfile::parse), graphContextLoaded = o.optBoolean("graph_context_loaded"),
                profileListings = o.optJSONObject("profile_listings")?.let(ProfileListings::parse),
                searchDiscovery = o.optJSONObject("search_discovery")?.let { SearchDiscoveryStatus(it.optBoolean("loading"),it.optBoolean("has_more")) },
                searchGeneration = o.optLong("search_generation"), searchPlanPending = o.optBoolean("search_plan_pending"),
                searchPlanTags = o.optJSONArray("search_plan_tags")?.let { a -> (0 until minOf(a.length(),128)).map { a.getString(it) } } ?: emptyList(),
                localCuration = o.optJSONObject("local_curation")?.let { batch ->
                    val candidates = batch.getJSONArray("candidates")
                    require(candidates.length() <= 24)
                    LocalCurationBatch(batch.getString("id"), batch.getString("interests"),
                        (0 until candidates.length()).map { index -> val candidate = candidates.getJSONObject(index)
                            LocalCurationCandidate(candidate.getString("event_id"), Listing.parse(candidate.getJSONObject("listing"))) })
                }
            )
        }
    }
}
private fun JSONObject.optional(name: String): String? =
    if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }

/** The Keystore key is non-exportable. Only authenticated ciphertext is written to disk. */
class SecureRecord(application: Application, namespace: String = "market") {
    private companion object { val recordLock = Any() }
    private val file = AtomicFile(File(application.noBackupFilesDir, if(namespace=="market") "market-secrets.v1" else "market-notifications.v1"))
    private val alias = if(namespace=="market") "iris-market-record-v1" else "iris-market-notifications-v1"
    private val aad = (if(namespace=="market") "to.iris.market.secrets.v1" else "to.iris.market.notifications.v1").toByteArray()
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
    fun contains(name: String): Boolean = synchronized(recordLock) { read().has(name) }
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
    @Volatile private var core: MarketApp? = null
    private val aiIntentGate = NativeAIIntentGate()
    val aiIntentEpoch: Long get() = aiIntentGate.current
    private val mutex = Mutex()
    private val mutable = MutableStateFlow(MarketSnapshot(demo = preview))
    val state = mutable.asStateFlow()
    private val working = MutableStateFlow(false)
    val busy = working.asStateFlow()
    private val mutableProfileSetupRequested = MutableStateFlow(false)
    val profileSetupRequested = mutableProfileSetupRequested.asStateFlow()
    fun requestProfileSetup() { if (!state.value.demo && state.value.profileNameRequired) mutableProfileSetupRequested.value = true }
    fun dismissProfileSetup() { mutableProfileSetupRequested.value = false }
    private val alert = MutableStateFlow<String?>(null)
    val notice = alert.asStateFlow()
    @Volatile private var active = true
    private var operationCount = 0
    @Volatile private var accountGeneration = 0L
    private val linking = MutableStateFlow<String?>(null)
    val deviceLinkUrl = linking.asStateFlow()
    private var linkJob: Job? = null
    private val localModel = LocalModel(application, viewModelScope)
    val localModelState = localModel.state
    private var localCurationJob: Job? = null
    @Volatile private var remoteCurationRunning = false
    @Volatile private var remoteSnapshotLease: Pair<MarketApp, Long>? = null
    private val searchContinuation = NativeSearchContinuation()
    private val drafts=NativeMessageDrafts()
    private val mutableMessageDrafts=MutableStateFlow<Map<NativeMessageDrafts.Key,String>>(emptyMap())
    val messageDrafts=mutableMessageDrafts.asStateFlow()
    fun setMessageDraft(key:NativeMessageDrafts.Key,text:String) {
        if(key.account!=state.value.publicKey)return
        drafts[key]=text;mutableMessageDrafts.value=drafts.snapshot()
    }
    fun finishMessageDraft(key:NativeMessageDrafts.Key,text:String,success:Boolean) {
        drafts.sent(text,key,success);mutableMessageDrafts.value=drafts.snapshot()
    }
    private val pushSecure = SecureRecord(application,"notifications")
    private val pushRuntime = NativePushRuntime.shared(application)
    private val mutablePushEnabled = MutableStateFlow(false)
    val pushEnabled = mutablePushEnabled.asStateFlow()
    private val mutablePushRoute = MutableStateFlow<NativePushRoute?>(null)
    val pushRoute = mutablePushRoute.asStateFlow()
    @Volatile private var activePushPeerID: String? = null
    @Volatile private var activePushThreadID: String? = null
    private var pushDirectory: String? = null
    private var pushDeviceSecret: String? = null
    @Volatile private var pushAccountReady=false
    @Volatile private var pushConsentRevision=0L
    @Volatile private var pendingPushIntent: android.content.Intent? = null
    private val mutableAITest=MutableStateFlow(NativeAITestUI())
    val aiTest=mutableAITest.asStateFlow()
    private val aiTestSession=NativeAITestSession()
    private var aiTestJob: Job?=null
    private val aiTestClearMutex=Mutex()
    @Volatile var aiPreferencesEditing = false

    fun downloadLocalModel() { if (!state.value.demo) localModel.download() }
    fun cancelLocalModelDownload() = localModel.cancelDownload()
    fun deleteLocalModel() { if (!state.value.demo) localModel.delete() }
    fun continueSearch() {
        searchContinuation.start(searchContext())
        command(JSONObject().put("type", "continue_search")) { if (state.value.aiSearch) ai("curate") }
    }
    fun cancelSearch() {
        searchContinuation.stop()
        val app = core ?: return
        viewModelScope.launch(Dispatchers.IO) { runCatching { app.command("{\"type\":\"cancel_search\"}") } }
    }
    fun cancelLocalAI() { cancelSearch(); searchContinuation.stop(); localCurationJob?.cancel() }

    init {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                mutex.withLock { openSavedAccount() }
                while (isActive) { delay(2_000); if (active) pollSnapshot() }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { alert.value = "Your market could not open. Close and reopen the app to try again." }
        }
    }
    /** Called only after an explicit wallet action; returns a separate secure wallet seed. */
    suspend fun walletMaterial(expectedOwner:String): WalletCredentials.Material = withContext(Dispatchers.IO) {
        mutex.withLock {
            check(!preview && state.value.publicKey==expectedOwner && expectedOwner.isNotBlank()) { "Choose your profile before opening its wallet." }
            val device=pushDeviceSecret ?: error("Your device is not ready.")
            WalletCredentials.loadOrCreate(getApplication(),state.value.publicKey,publicKeyForSecret(device))
        }
    }
    private fun openSavedAccount() {
        pushAccountReady=false
        invalidateAITest()
        dismissProfileSetup()
        val previousOwner=state.value.publicKey
        if(!preview) {
            NativePushBridge.attach(this)
            if(!NativePushBridge.withCurrent(this) {
                if(previousOwner.isNotBlank())pushRuntime.setEnabled(previousOwner,false)
                pushSecure.put("preview","")
            })return
        }
        mutablePushRoute.value=null;activePushPeerID=null;activePushThreadID=null
        accountGeneration += 1
        aiIntentGate.advance()
        core?.shutdown();core?.close();core=null
        val application=getApplication<Application>()
        val name=if(preview) "identity-preview" else "identity"
        val legacy=secure.get(name).ifBlank {generateSecretKey().also {
            if(!preview) secure.put("identity-bootstrap",publicKeyForSecret(it))
            secure.put(name,it)
        }}
        val owner=if(preview) "" else secure.get("active-account")
        val saved=if(owner.isBlank()) "" else secure.get("account-$owner")
        check(owner.isBlank() || saved.isNotBlank()) { "This profile’s sign-in details are unavailable" }
        val base=File(application.filesDir,if(preview) "preview" else "market")
        if(saved.isNotBlank()) {
            val bundle=JSONObject(saved)
            val directory=if(bundle.optBoolean("legacy")) base else File(base,"accounts/$owner")
            directory.mkdirs()
            pushDirectory=directory.absolutePath;pushDeviceSecret=bundle.getString("device")
            core=MarketApp.withIdentity(directory.absolutePath,owner,bundle.optional("secret"),bundle.getString("device"),bundle.optional("authorization"))
        } else {
            base.mkdirs()
            pushDirectory=base.absolutePath;pushDeviceSecret=legacy
            core=if(!preview && secure.get("identity-bootstrap")==publicKeyForSecret(legacy)) {
                MarketApp.freshProfile(base.absolutePath,legacy).also {secure.put("identity-bootstrap","")}
            } else MarketApp(base.absolutePath,legacy,preview)
        }
        core?.command(JSONObject().put("type", "set_filter").put("query", "").put("side", "offer").put("ai_search", false).toString())
        core?.let { app ->
            val initial = MarketSnapshot.parse(app.snapshot())
            if (!JSONObject(initial.settings).optBoolean("currency_initialized", true)) {
                val regional = runCatching { java.util.Currency.getInstance(java.util.Locale.getDefault()).currencyCode }.getOrDefault("USD")
                val preferred = if (initial.supportedCurrencies.contains(regional)) regional else "USD"
                app.command(JSONObject().put("type","initialize_currency").put("currency",preferred).toString())
            }
        }
        refreshSnapshot(reset = true)
        val notificationsEnabled=!preview && pushSecure.get("enabled-${state.value.publicKey}")=="true"
        core?.command(JSONObject().put("type","set_push_enabled").put("enabled",notificationsEnabled).toString())
        if(!preview)core?.let {app->NativePushPending.drain(application,state.value.publicKey){payload->app.ingestPushPayload(payload)}}
        if(!preview && !NativePushBridge.withCurrent(this) {
            mutablePushEnabled.value=notificationsEnabled
            runCatching {com.google.firebase.messaging.FirebaseMessaging.getInstance().isAutoInitEnabled=notificationsEnabled}
            if(notificationsEnabled) {
                val directory=pushDirectory;val device=pushDeviceSecret
                if(directory!=null&&device!=null)pushSecure.put("preview",JSONObject().put("owner",state.value.publicKey).put("device",device).put("directory",directory).toString())
            }
            pushRuntime.activate(state.value.publicKey,notificationsEnabled)
            pushAccountReady=true
        })return
        syncPush()
        pendingPushIntent?.let {pendingPushIntent=null;handlePushIntent(it)}
        if (!preview) {
            val ai = JSONObject(state.value.settings).optJSONObject("ai") ?: JSONObject()
            val originalEndpoint = ai.optString("base_url")
            val originalProvider = ai.optString("provider", "compatible")
            NativeKeyMigration.migrate(originalProvider, originalEndpoint,
                { endpoint -> NativePreferences.keySlot(originalProvider, endpoint) }, secure::get, secure::contains, secure::put)
            val initialGeneration = accountGeneration
            val initialAIIntent = aiIntentEpoch
            viewModelScope.launch(Dispatchers.IO) {
                val installed = localModel.verifyInstalled()
                mutex.withLock {
                    if (installed && accountGeneration == initialGeneration && !state.value.aiConfigured && !aiPreferencesEditing) {
                        val settings = JSONObject(state.value.settings)
                        settings.put("ai", JSONObject().put("enabled", true).put("provider", "litert").put("base_url", "").put("model", LocalModelManifest.ID).put("interests", "").put("curate_feed", false))
                        aiIntentGate.perform(initialAIIntent) {
                            val app = core ?: return@perform
                            if(!MarketSnapshot.parse(app.snapshot()).aiConfigured) {
                                app.command(JSONObject().put("type", "set_settings").put("settings", settings).toString())
                                refreshSnapshot()
                            }
                        }
                    }
                }
            }
        }
    }
    fun signIn(secret: String, done:()->Unit) {
        cancelLocalAI()
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
    fun setActive(value: Boolean) { active = value; if (!value) { setActivePushContext(null,null);cancelLocalAI() } else syncPush() }
    private fun publishSnapshot(next: MarketSnapshot) {
        mutable.update { previous -> if(previous.publicKey==next.publicKey&&next.revision<previous.revision) previous else next }
        if (!state.value.profileNameRequired || state.value.demo) dismissProfileSetup()
        viewModelScope.launch { continueLocalSearch();syncPush() }
    }
    private suspend fun pollSnapshot() {
        val lease = remoteSnapshotLease
        if (lease == null) { mutex.withLock { refreshSnapshot() }; return }
        // The command holds the lifecycle mutex; UniFFI also retains each concurrent call.
        // A completed/closed lease is harmless: discard its snapshot or closed-object error.
        runCatching { MarketSnapshot.parse(lease.first.snapshot()) }.getOrNull()?.let { next ->
            if (remoteSnapshotLease === lease && accountGeneration == lease.second && core === lease.first) publishSnapshot(next)
        }
    }
    private fun refreshSnapshot(reset: Boolean = false) { core?.let {
        val next=MarketSnapshot.parse(it.snapshot())
        if(reset) mutable.value=next else publishSnapshot(next)
    } }
    fun dismissNotice() { alert.value = null }
    fun command(request: JSONObject, onSuccess: (() -> Unit)? = null) = submit(request, onSuccess, null)
    fun publishListing(draft: JSONObject, expiry: NativeListingExpiry, onSuccess: () -> Unit) = submit(JSONObject().put("type","publish").put("draft",JSONObject(draft.toString())), onSuccess, null, publishExpiry=expiry)
    fun orderCommand(request: JSONObject, onSuccess: () -> Unit = {}, onError: (String) -> Unit) = submit(request, onSuccess, onError)
    private fun submit(request: JSONObject, onSuccess: (() -> Unit)?, onError: ((String) -> Unit)?, expectedAIIntent: Long? = null, publishExpiry: NativeListingExpiry? = null) {
        if (NativeProfileSetupGate.requiresSetup(request.optString("type"), state.value.profileNameRequired, state.value.demo)) {
            requestProfileSetup(); onError?.invoke("Sign in to continue."); return
        }
        val generation = accountGeneration
        if (request.optString("type") in setOf("set_filter", "set_settings")) cancelLocalAI()
        val preferenceEpoch = if(request.optString("type")=="set_settings") expectedAIIntent ?: aiIntentEpoch else null
        viewModelScope.launch {
            operationCount += 1; working.value = true
            try {
                withContext(Dispatchers.IO) {
                    mutex.withLock {
                        if (generation != accountGeneration) throw CancellationException("Profile changed")
                        val app = core ?: error("Not ready")
                        if(preferenceEpoch!=null) {
                            val next=aiIntentGate.perform(preferenceEpoch) {
                                val commit=JSONObject(request.toString())
                                val fresh=JSONObject(MarketSnapshot.parse(app.snapshot()).settings)
                                if(expectedAIIntent==null) commit.getJSONObject("settings").put("ai",fresh.getJSONObject("ai"))
                                else { fresh.put("ai",commit.getJSONObject("settings").getJSONObject("ai"));commit.put("settings",fresh) }
                                MarketSnapshot.parse(app.command(commit.toString()))
                            } ?: throw CancellationException("Superseded AI preference")
                            publishSnapshot(next)
                        } else {
                            val commit=JSONObject(request.toString())
                            if(publishExpiry!=null && commit.optString("type")=="publish") commit.getJSONObject("draft").put("expires_at",publishExpiry.deadline(System.currentTimeMillis()/1000) ?: JSONObject.NULL)
                            publishSnapshot(MarketSnapshot.parse(app.command(commit.toString())))
                        }
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
    fun toggleAI(openSettings: () -> Unit) {
        val ai=JSONObject(state.value.settings).optJSONObject("ai") ?: JSONObject()
        val action=NativeAIReadiness.tapAction(ai.optBoolean("enabled"),
            NativeAIReadiness.canEnable(ai.optString("provider"),ai.optString("model"),ai.optString("base_url"),localModelState.value.available,state.value.demo),
            !state.value.demo&&localModelState.value.available&&NativeAIReadiness.canSelectLocalOnTap(ai.optString("provider"),ai.optString("model"),ai.optString("base_url")))
        if(action==NativeAITapAction.SETTINGS) { openSettings();return }
        if(working.value&&action!=NativeAITapAction.OFF) return
        val epoch=aiIntentGate.advance()
        if(action==NativeAITapAction.OFF) { disableAI(epoch);return }
        viewModelScope.launch {
            operationCount+=1;working.value=true
            try {
                withContext(Dispatchers.IO) { mutex.withLock {
                    val app=core ?: error("Not ready")
                    val next=aiIntentGate.perform(epoch) {
                        val current=MarketSnapshot.parse(app.snapshot())
                        val settings=JSONObject(current.settings)
                        val selected=settings.getJSONObject("ai")
                        if(action==NativeAITapAction.LOCAL) {
                            check(!current.demo&&localModelState.value.available)
                            selected.put("provider","litert").put("model",LocalModelManifest.ID).put("base_url","")
                        }
                        selected.put("enabled",true)
                        val saved=MarketSnapshot.parse(app.command(JSONObject().put("type","set_settings").put("settings",settings).toString()))
                        check(saved.error.isNullOrBlank())
                        MarketSnapshot.parse(app.command(JSONObject().put("type","set_filter").put("query",current.query).put("side",current.side).put("ai_search",true).toString()))
                    }
                    if(next!=null) publishSnapshot(next)
                } }
            } catch(e:CancellationException){throw e}
            catch(_:Exception){alert.value="Could not change AI search. Check your AI settings."}
            finally{operationCount-=1;working.value=operationCount>0}
        }
    }
    private fun disableAI(epoch: Long, requestedAI: JSONObject? = null, done: () -> Unit = {}) {
        cancelLocalAI()
        val app=core ?: return
        val generation=accountGeneration
        viewModelScope.launch {
            operationCount+=1;working.value=true
            try {
                val next=withContext(Dispatchers.IO) { aiIntentGate.perform(epoch) {
                    val fresh=MarketSnapshot.parse(app.snapshot())
                    val settings=JSONObject(fresh.settings)
                    if(requestedAI!=null) settings.put("ai",JSONObject(requestedAI.toString()))
                    settings.getJSONObject("ai").put("enabled",false)
                    MarketSnapshot.parse(app.command(JSONObject().put("type","set_settings").put("settings",settings).toString()))
                } }
                if(generation==accountGeneration&&next!=null) {
                    publishSnapshot(next)
                    if(next.error.isNullOrBlank()) done() else alert.value=next.error
                }
            } catch(e:CancellationException){throw e}
            catch(_:Exception){if(generation==accountGeneration) alert.value="Could not turn AI search off. Try again."}
            finally{operationCount-=1;working.value=operationCount>0}
        }
    }
    fun filter(query: String, side: String, aiSearch: Boolean = false) = command(JSONObject().put("type", "set_filter").put("query", query).put("side", side).put("ai_search", aiSearch)) { if (query.isNotBlank()) searchContinuation.start(searchContext()) }
    fun searchAI(query: String, side: String) = command(JSONObject().put("type", "set_filter").put("query", query).put("side", side).put("ai_search", true)) { searchContinuation.start(searchContext()); ai("curate") }
    fun save(id: String) = command(JSONObject().put("type", "save").put("id", id))
    fun action(type: String) = command(JSONObject().put("type", type))
    private fun aiTestContext(): NativeAITestContext {
        val ai=JSONObject(state.value.settings).optJSONObject("ai") ?: JSONObject()
        return NativeAITestContext(accountGeneration,aiIntentEpoch,ai.optString("provider"),ai.optString("model"),ai.optString("base_url"),ai.optBoolean("enabled"))
    }
    private fun invalidateAITest(): Long {
        val revision=aiTestSession.invalidate();aiTestJob?.cancel();aiTestJob=null;mutableAITest.value=NativeAITestUI();return revision
    }
    fun clearAITest() {
        val revision=invalidateAITest();val app=core ?: return;val generation=accountGeneration
        mutableAITest.value=NativeAITestUI(busy=true)
        viewModelScope.launch {
            aiTestClearMutex.withLock { withContext(Dispatchers.IO) { runCatching {app.command("{\"type\":\"check_ai\",\"clear\":true,\"token\":\"$revision\"}")} } }
            if(accountGeneration==generation&&aiTestSession.revision==revision) mutableAITest.value=NativeAITestUI()
        }
    }
    fun testAI(sample: NativeAITestInput) {
        if(working.value || mutableAITest.value.busy || localCurationJob?.isActive==true)return
        val revision=invalidateAITest();val context=aiTestContext()
        sample.validationError?.let {mutableAITest.value=NativeAITestUI(error=it);return}
        if(state.value.demo){mutableAITest.value=NativeAITestUI(error="Preview stays offline. Leave preview to test this provider.");return}
        if(context.provider=="litert"&&!localModelState.value.available){mutableAITest.value=NativeAITestUI(error=if(localModelState.value.busy) "The on-device model is preparing. Try again when ready." else "Download and verify the on-device model in Settings first.");return}
        if(context.provider!="litert"&&!NativeAIReadiness.canEnable(context.provider,context.model,context.endpoint,false)){mutableAITest.value=NativeAITestUI(error="Choose a model and provider URL before testing.");return}
        val app=core ?: return
        mutableAITest.value=NativeAITestUI(busy=true)
        aiTestJob=viewModelScope.launch {
            val started=System.nanoTime()
            try {
                val result=if(context.provider=="litert") {
                    val matched=withTimeout(45_000){NativeAITestRunner.run(sample) {localModel.classify(it,sandbox=true)}}
                    ensureActive()
                    NativeAITestResult(matched,(System.nanoTime()-started)/1_000_000,context.provider,context.model)
                } else withContext(Dispatchers.IO) { mutex.withLock {
                    check(aiTestSession.accepts(revision,context,aiTestContext()))
                    val settings=JSONObject(MarketSnapshot.parse(app.snapshot()).settings).getJSONObject("ai")
                    check(settings.optString("provider")==context.provider&&settings.optString("model")==context.model&&settings.optString("base_url")==context.endpoint&&settings.optBoolean("enabled")==context.enabled)
                    val key=secure.get(NativePreferences.keySlot(context.provider,context.endpoint))
                    val request=JSONObject().put("type","check_ai").put("api_key",key).put("test",JSONObject().put("query",sample.query).put("listing",sample.listing)).put("token",revision.toString())
                        .put("expected",JSONObject().put("provider",context.provider).put("model",context.model).put("base_url",context.endpoint).put("enabled",context.enabled))
                    aiTestClearMutex.withLock {
                        check(aiTestSession.accepts(revision,context,aiTestContext()))
                        app.command(JSONObject().put("type","check_ai").put("clear",true).put("token",revision.toString()).toString())
                    }
                    val next=MarketSnapshot.parse(app.command(request.toString()))
                    val returned=JSONObject(next.settings).getJSONObject("ai")
                    check(returned.optString("provider")==context.provider&&returned.optString("model")==context.model&&returned.optString("base_url")==context.endpoint&&returned.optBoolean("enabled")==context.enabled)
                    next.aiTestResult?.takeIf {it.provider==context.provider&&it.model==context.model}
                } }
                ensureActive()
                if(aiTestSession.accepts(revision,context,aiTestContext())) mutableAITest.value=NativeAITestUI(result=result,error=if(result==null) "Test cancelled. Try again when ready." else null)
            } catch(_:TimeoutCancellationException){if(aiTestSession.accepts(revision,context,aiTestContext())) mutableAITest.value=NativeAITestUI(error="The model took too long to finish this test.")}
            catch(e:CancellationException){throw e}
            catch(e:Exception){if(aiTestSession.accepts(revision,context,aiTestContext())) mutableAITest.value=NativeAITestUI(error=if(e.message?.contains("Stop the current search before testing.")==true) "Stop the current search before testing." else "Could not finish the test. Check this model’s settings and try again.")}
            catch(_:LinkageError){if(aiTestSession.accepts(revision,context,aiTestContext())) mutableAITest.value=NativeAITestUI(error="This model could not load on this device.")}
            catch(_:OutOfMemoryError){if(aiTestSession.accepts(revision,context,aiTestContext())) mutableAITest.value=NativeAITestUI(error="Not enough memory for this model.")}
            finally {if(aiTestSession.revision==revision) {mutableAITest.value=mutableAITest.value.copy(busy=false);aiTestJob=null}}
        }
    }
    private fun searchContext(): String {
        val snapshot = state.value
        val ai = JSONObject(snapshot.settings).optJSONObject("ai") ?: JSONObject()
        return listOf(snapshot.publicKey, snapshot.query, snapshot.side, ai.optString("provider"), ai.optString("model"), ai.optString("base_url")).joinToString("\n")
    }
    private fun continueDiscovery() {
        val snapshot = state.value
        val discovery = snapshot.searchDiscovery ?: return
        if (!active || working.value || mutableAITest.value.busy || localCurationJob?.isActive == true || snapshot.query.isBlank() || snapshot.error != null || discovery.loading || !discovery.hasMore) return
        val unresolved = snapshot.aiSearch && snapshot.listings.any { it.relevanceShow == null }
        val matches = if (snapshot.aiSearch) snapshot.listings.count { it.relevanceShow == true } else snapshot.listings.size
        if (!unresolved && matches < 24 && searchContinuation.claimHistory(searchContext())) command(JSONObject().put("type", "continue_search"))
    }
    private fun continueLocalSearch() {
        continueDiscovery()
        val snapshot = state.value
        val ai = JSONObject(snapshot.settings).optJSONObject("ai") ?: return
        if (!active || working.value || mutableAITest.value.busy || localCurationJob?.isActive == true || !snapshot.aiSearch || !ai.optBoolean("enabled") || snapshot.query.isBlank() || snapshot.error != null) return
        if (snapshot.listings.count { it.relevanceShow == true } >= 24) return
        val candidates = snapshot.listings.filter { it.relevanceShow == null }.map { it.localSearchRevision }
        if (ai.optString("provider") == "litert") {
            if (searchContinuation.claim(searchContext(), candidates)) runLocalCuration(checkOnly = false)
        } else if (searchContinuation.canReview(searchContext(), candidates, batchSize = 12)) ai("curate")
    }
    fun ai(type: String) {
        if (remoteCurationRunning || mutableAITest.value.busy) return
        val provider = JSONObject(state.value.settings).optJSONObject("ai")?.optString("provider", "compatible") ?: "compatible"
        if (provider == "litert") { runLocalCuration(checkOnly = type == "check_ai"); return }
        val requestEpoch=aiIntentEpoch
        val generation=accountGeneration
        val context=searchContext()
        val searchGeneration=state.value.searchGeneration
        remoteCurationRunning = true
        operationCount += 1; working.value = true
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { mutex.withLock {
                    val app = core ?: error("Not ready")
                    val settings = JSONObject(MarketSnapshot.parse(app.snapshot()).settings).getJSONObject("ai")
                    check(settings.optString("provider") == provider) { "Provider changed" }
                    val key = secure.get(NativePreferences.keySlot(provider, settings.optString("base_url")))
                    val initialListings = MarketSnapshot.parse(app.snapshot()).listings
                    val hadCandidates = initialListings.any { it.relevanceShow == null }
                    val before = initialListings.filter { it.relevanceShow != null }.map { it.localSearchRevision }.toSet()
                    val next = try {
                        if (type == "curate") remoteSnapshotLease = app to generation
                        MarketSnapshot.parse(app.command(JSONObject().put("type", type).put("api_key", key).toString()))
                    } finally { remoteSnapshotLease = null }
                    if (type == "curate" && requestEpoch == aiIntentEpoch && generation == accountGeneration && context == searchContext() && searchGeneration == next.searchGeneration) {
                        // Planning can reorder the selected twelve: count actual decisions, not a guessed prefix.
                        val reviewed = next.listings.filter { it.relevanceShow != null && it.localSearchRevision !in before }.map { it.localSearchRevision }
                        searchContinuation.record(reviewed)
                        if (next.error != null || reviewed.isEmpty() && hadCandidates) searchContinuation.stop()
                    }
                    publishSnapshot(next)
                } }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { if(requestEpoch==aiIntentEpoch&&generation==accountGeneration) {
                if (type == "curate") searchContinuation.stop()
                alert.value = if (type == "curate") "Search paused. Check this provider’s settings and try again." else "Could not test this provider. Check its settings and try again."
            } }
            finally {
                remoteCurationRunning = false
                operationCount -= 1; working.value = operationCount > 0
                if (type == "curate" && requestEpoch == aiIntentEpoch && generation == accountGeneration) continueLocalSearch()
            }
        }
    }

    private fun runLocalCuration(checkOnly: Boolean) {
        if (state.value.demo || localCurationJob?.isActive == true || mutableAITest.value.busy) return
        val previous = localCurationJob
        localCurationJob = viewModelScope.launch {
            previous?.join()
            if (!localModelState.value.available) { alert.value = "Download the on-device model in Settings first."; return@launch }
            operationCount += 1; working.value = true
            var batchId: String? = null
            var generation = -1L
            var searchGeneration = 0L
            var planning: LocalSearchPlanInput? = null
            try {
                val batch = withContext(Dispatchers.IO) { mutex.withLock {
                    generation = accountGeneration
                    if (checkOnly) LocalCurationBatch("", "wooden dining table", listOf(
                        LocalCurationCandidate("local-check-table", Listing("local-check-table","","Oak dining table",
                            "Solid oak dining table, seats six.","offer","80","EUR","","furniture",null,false,false,"active","",null,null)),
                        LocalCurationCandidate("local-check-shoes", Listing("local-check-shoes","","Running shoes",
                            "A pair of used running shoes, size 42.","offer","20","EUR","","clothing",null,false,false,"active","",null,null))
                    )) else {
                        val app = core ?: error("Not ready")
                        val current = state.value
                        searchGeneration = current.searchGeneration
                        if (current.searchPlanPending && current.listings.size > 24) {
                            planning = LocalSearchPlanInput(current.query, current.searchPlanTags)
                            LocalCurationBatch("", current.query, emptyList())
                        } else {
                            publishSnapshot(MarketSnapshot.parse(app.command(JSONObject().put("type", "begin_local_curation").toString())))
                            state.value.localCuration ?: error("Could not prepare listings")
                        }
                    }
                } }
                batchId = batch.id.takeIf { it.isNotEmpty() }
                if (!checkOnly) searchContinuation.record(batch.candidates.map { it.listing.localSearchRevision })
                if (!checkOnly && planning == null && batch.candidates.isEmpty()) return@launch
                var activeBatch = batch
                val checkStarted = System.nanoTime()
                val decisions = withTimeout(270_000) { localModel.classify(batch, planning = planning, onPlan = { terms ->
                    withContext(Dispatchers.IO) { mutex.withLock {
                        ensureActive()
                        check(accountGeneration == generation && state.value.searchGeneration == searchGeneration) { "Search changed" }
                        val app = core ?: error("Not ready")
                        app.command(JSONObject().put("type", "apply_search_plan").put("generation", searchGeneration).put("terms", JSONArray(terms)).toString())
                        publishSnapshot(MarketSnapshot.parse(app.command(JSONObject().put("type", "begin_local_curation").toString())))
                        activeBatch = state.value.localCuration ?: error("Could not prepare listings")
                        batchId = activeBatch.id
                        searchContinuation.record(activeBatch.candidates.map { it.listing.localSearchRevision })
                        activeBatch
                    } }
                }, onDecision = { decision ->
                    if (!checkOnly) withContext(Dispatchers.IO) { mutex.withLock {
                        ensureActive()
                        check(accountGeneration == generation) { "Profile changed" }
                        val rows = JSONArray().put(JSONObject().put("event_id", decision.eventId)
                            .put("show", decision.show).put("reason", decision.reason))
                        val request = JSONObject().put("type", "apply_local_curation").put("id", activeBatch.id)
                            .put("partial", true).put("decisions", rows)
                        publishSnapshot(MarketSnapshot.parse((core ?: error("Not ready")).command(request.toString())))
                    } }
                }) }
                ensureActive()
                if (!checkOnly && activeBatch.candidates.isNotEmpty()) batchId = null
                if (checkOnly) alert.value = if (decisions.map { it.show } == listOf(true,false)) "Search check passed · %.1f s".format((System.nanoTime()-checkStarted)/1_000_000_000.0)
                    else "The model missed the search check. Listings remain visible."
            } catch (e: TimeoutCancellationException) {
                alert.value = "The model took too long. Listings remain visible."
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { alert.value = "The on-device model could not finish. Listings remain visible." }
            catch (_: LinkageError) { alert.value = "This model could not load on this device. Listings remain visible." }
            catch (_: OutOfMemoryError) { alert.value = "Not enough memory for this model. Listings remain visible." }
            finally {
                val id = batchId
                try {
                    if (id != null) withContext(NonCancellable + Dispatchers.IO) { mutex.withLock {
                        if (accountGeneration == generation) runCatching {
                            core?.command(JSONObject().put("type", "cancel_local_curation").put("id", id).toString())
                            refreshSnapshot()
                        }
                    } }
                } finally { operationCount -= 1; working.value = operationCount > 0 }
            }
        }
    }
    fun saveSettings(settings: JSONObject, provider: String, apiKey: String, replaceKey: Boolean, expectedAIIntent: Long? = null, onIntentCommitted: (Long) -> Unit = {}, done: () -> Unit) {
        viewModelScope.launch {
            try {
                if(expectedAIIntent!=null&&expectedAIIntent!=aiIntentEpoch) return@launch
                if (replaceKey) {
                    val written=withContext(Dispatchers.IO) { aiIntentGate.perform(expectedAIIntent ?: aiIntentEpoch) {
                        NativeKeyMigration.replace(provider, NativePreferences.keySlot(provider, settings.getJSONObject("ai").optString("base_url")), apiKey, secure::put)
                        true
                    } }
                    if(written==null) return@launch
                }
                if(expectedAIIntent!=null&&expectedAIIntent!=aiIntentEpoch) return@launch
                val turningOff=JSONObject(state.value.settings).optJSONObject("ai")?.optBoolean("enabled")==true&&!settings.getJSONObject("ai").optBoolean("enabled")
                val committedEpoch=if(turningOff) aiIntentGate.advance() else expectedAIIntent ?: aiIntentEpoch
                val committed={onIntentCommitted(committedEpoch);done()}
                if(turningOff) disableAI(committedEpoch,settings.getJSONObject("ai"),committed)
                else submit(JSONObject().put("type", "set_settings").put("settings", settings), committed, null, expectedAIIntent)
            } catch (_: Exception) { alert.value = "Could not securely save your provider key." }
        }
    }
    fun markMessagesRead(messageIDs:List<String>,onComplete:(Boolean)->Unit) = submit(JSONObject().put("type","mark_messages_read").put("message_ids",JSONArray(messageIDs.take(256))),{onComplete(true)},{onComplete(false)})
    fun setActivePushContext(peerID:String?,threadID:String?) {activePushPeerID=peerID;activePushThreadID=threadID}
    fun consumePushRoute(){mutablePushRoute.value=null}
    fun suppressPush(route:NativePushRoute?):Boolean {
        if(!active || route==null || activePushPeerID!=route.peerID)return false
        val key=route.orderID?.let {"order:$it"} ?: route.threadID?.let {"thread:$it"} ?: "general"
        return activePushThreadID=="*" || activePushThreadID==key
    }
    fun pushConsentScope():String = "$accountGeneration|$pushConsentRevision|${state.value.publicKey}"
    fun setPushEnabled(enabled:Boolean,expectedOwner:String?=null,expectedScope:String?=null) {
        if(preview || NativePushBridge.current()!==this || !pushAccountReady || state.value.publicKey.isBlank() || state.value.profileNameRequired || expectedOwner!=null&&expectedOwner!=state.value.publicKey || expectedScope!=null&&expectedScope!=pushConsentScope())return
        pushConsentRevision+=1
        mutablePushEnabled.value=enabled
        runCatching {com.google.firebase.messaging.FirebaseMessaging.getInstance().isAutoInitEnabled=enabled}
        val owner=state.value.publicKey
        pushSecure.put("enabled-$owner",enabled.toString())
        if(enabled) {
            val directory=pushDirectory ?: return;val device=pushDeviceSecret ?: return
            pushSecure.put("preview",JSONObject().put("owner",owner).put("device",device).put("directory",directory).toString())
        } else pushSecure.put("preview","")
        pushRuntime.setEnabled(owner,enabled)
        command(JSONObject().put("type","set_push_enabled").put("enabled",enabled)){syncPush()}
    }
    fun syncPush() {
        if(preview || !state.value.publicKey.isNotBlank())return
        val app=core ?: return;val owner=state.value.publicKey;val generation=accountGeneration
        viewModelScope.launch(Dispatchers.IO) {
            val filters=runCatching {app.pushSnapshot()}.getOrNull() ?: return@launch
            if(accountGeneration==generation)pushRuntime.publish(owner,filters)
        }
    }
    fun ingestBackgroundPush(payload:String) {
        if(payload.length>65536)return
        viewModelScope.launch(Dispatchers.IO) {mutex.withLock {
            core?.let {app->runCatching {app.ingestPushPayload(payload)};refreshSnapshot()}
        }}
    }
    fun handlePushIntent(intent:android.content.Intent) {
        val payload=intent.getStringExtra("market_push_payload") ?: return
        val messageID=intent.getStringExtra("market_push_message_id")
        if(core==null){
            pendingPushIntent=android.content.Intent(intent)
            intent.removeExtra("market_push_payload");intent.removeExtra("market_push_message_id");return
        }
        intent.removeExtra("market_push_payload");intent.removeExtra("market_push_message_id")
        if(payload.length>65536)return
        viewModelScope.launch(Dispatchers.IO) {mutex.withLock {
            val app=core ?: return@withLock
            runCatching {app.ingestPushPayload(payload)}
            val next=MarketSnapshot.parse(app.snapshot());publishSnapshot(next)
            // Never trust an externally supplied peer/order route. Resolve the message locally.
            next.conversations.firstNotNullOfOrNull {thread->thread.messages.firstOrNull {it.id==messageID}?.let {message->
                NativePushRoute(thread.id,message.context?.threadId,message.orderId ?: message.context?.orderId)
            }}?.let {mutablePushRoute.value=it}
        }}
    }
    override fun onCleared() {
        NativePushBridge.detach(this)
        invalidateAITest()
        val app=core
        super.onCleared()
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { app?.shutdown() }
            mutex.withLock {
                val opened=core
                if(opened!==app)runCatching {opened?.shutdown()}
                opened?.close();core=null
            }
        }
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
    val followers: List<PublicPerson>, val known: List<PublicPerson>, val graphLabel: String, val graphLoaded: Boolean, val coverage: String, val loading: Boolean, val error: String?, val followersLoaded: Boolean = false, val followersLoading: Boolean = false, val followersError: String? = null) {
    companion object {
        fun parse(o: JSONObject): PublicProfile {
            fun people(key: String): List<PublicPerson> { val a = o.optJSONArray(key) ?: return emptyList(); return (0 until a.length()).map { PublicPerson.parse(a.getJSONObject(it)) } }
            return PublicProfile(PublicPerson.parse(o.getJSONObject("person")),o.optString("about"),o.optional("website"),people("following"),o.optInt("following_count"),
                people("followers"),people("followed_by_known"),o.optString("graph_label"),o.optBoolean("graph_context_loaded"),o.optString("coverage"),o.optBoolean("loading"),o.optional("error"),o.optBoolean("followers_loaded"),o.optBoolean("followers_loading"),o.optional("followers_error"))
        }
    }
}
