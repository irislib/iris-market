package to.iris.market

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.*
import org.json.JSONObject
import to.iris.market.core.buildPushRequest
import to.iris.market.core.generateSecretKey
import to.iris.market.core.resolvePushPreview
import to.iris.market.core.pushEventId
import java.net.HttpURLConnection
import java.net.URL
import java.io.File
import android.util.AtomicFile

private fun JSONObject.optional(name:String):String? = if(isNull(name)) null else optString(name).takeIf {it.isNotBlank()}

data class NativePushRoute(val peerID:String,val threadID:String?=null,val orderID:String?=null)
/** Only authenticated local resolution supplies a route; transport fields are never UI text. */
data class NativePushResolution(val show:Boolean,val notificationID:String,val messageID:String?,val route:NativePushRoute?) {
    companion object {
        fun parse(raw:String):NativePushResolution {
            val value=JSONObject(raw)
            val peer=value.optional("peer_id")
            return NativePushResolution(value.optBoolean("show"),value.optString("notification_id"),value.optional("message_id"),peer?.let {NativePushRoute(it,value.optional("thread_id"),value.optional("order_id"))})
        }
    }
}
object NativePushBridge {
    private val model=NativePushLifecycle<MarketModel>()
    fun attach(value:MarketModel){model.attach(value)}
    fun detach(value:MarketModel){model.detach(value)}
    fun current():MarketModel?=model.current()
    fun withCurrent(value:MarketModel,action:()->Unit):Boolean=model.withCurrent(value,action)
}
class MarketFirebaseMessagingService:FirebaseMessagingService() {
    override fun onNewToken(token:String) {
        runCatching {
            NativePushRuntime.shared(application).recordToken(token)
            NativePushBridge.current()?.syncPush()
        }
    }
    override fun onMessageReceived(message:RemoteMessage) {
        // Keep Firebase's short wake lease while doing bounded local reads. No relay waits.
        val payload=JSONObject(message.data).toString()
        if(payload.length>65536)return
        runCatching {
            val secure=SecureRecord(application,"notifications")
            val credentialRaw=secure.get("preview").takeIf {it.isNotBlank()} ?: return
            val credential=JSONObject(credentialRaw)
            val owner=credential.getString("owner")
            if(secure.get("active-owner")!=owner||secure.get("desired-$owner")!="true")return
            val replay=NativePushPending.appendAndContext(applicationContext,credential.getString("owner"),payload) ?: return
            val resolution=NativePushResolution.parse(resolvePushPreview(credential.getString("directory"),credential.getString("owner"),credential.getString("device"),replay))
            if(secure.get("preview")!=credentialRaw)return
            NativePushBridge.current()?.ingestBackgroundPush(payload)
            if(!resolution.show || NativePushBridge.current()?.suppressPush(resolution.route)==true)return
            if(!claim(secure,resolution.notificationID))return
            show(applicationContext,resolution,payload)
        }
    }
    private fun claim(secure:SecureRecord,id:String):Boolean=synchronized(receiptLock) {
        val ids=runCatching {org.json.JSONArray(secure.get("receipts").ifBlank {"[]"})}.getOrDefault(org.json.JSONArray())
        val values=(0 until ids.length()).map {ids.getString(it)}
        if(id in values)return false
        secure.put("receipts",org.json.JSONArray((values+id).takeLast(2048)).toString());true
    }
    companion object {
        private val receiptLock=Any()
        fun show(context:Context,resolution:NativePushResolution,payload:String) {
            if(Build.VERSION.SDK_INT>=33&&ContextCompat.checkSelfPermission(context,Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return
            val manager=context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel("private-activity","Private updates",NotificationManager.IMPORTANCE_DEFAULT))
            val intent=Intent(context,MainActivity::class.java).setData(android.net.Uri.parse("irismarket://notification/${resolution.notificationID}")).putExtra("market_push_payload",payload).putExtra("market_push_message_id",resolution.messageID).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val pending=PendingIntent.getActivity(context,0,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification=NotificationCompat.Builder(context,"private-activity").setSmallIcon(R.drawable.ic_notification).setContentTitle("Iris Market").setContentText("New private activity").setAutoCancel(true).setContentIntent(pending).setGroup("private-market").build()
            manager.notify(resolution.notificationID,0,notification)
        }
    }
}
/** Signed ciphertext handoff, separate from the public listing cache and ratchet writer. */
object NativePushPending {
    private val lock=Any()
    private fun file(context:Context)=AtomicFile(File(context.noBackupFilesDir,"market-push-pending.json"))
    private fun read(file:AtomicFile):List<JSONObject> {
        if(file.baseFile.length()>65536)return emptyList()
        val raw=runCatching {org.json.JSONArray(String(file.readFully(),Charsets.UTF_8))}.getOrDefault(org.json.JSONArray())
        return ((raw.length()-16).coerceAtLeast(0) until raw.length()).mapNotNull {raw.optJSONObject(it)}
    }
    private fun write(file:AtomicFile,values:List<JSONObject>) {
        val keep=values.takeLast(16).toMutableList()
        while(keep.isNotEmpty()&&org.json.JSONArray(keep).toString().toByteArray().size>65536)keep.removeAt(0)
        val stream=file.startWrite()
        try{stream.write(org.json.JSONArray(keep).toString().toByteArray());file.finishWrite(stream)}catch(e:Exception){file.failWrite(stream);throw e}
    }
    fun appendAndContext(context:Context,owner:String,payload:String):String? {
        val id=pushEventId(payload) ?: return null
        val current=JSONObject(payload)
        val raw=current.opt("event") ?: current.opt("outer_event") ?: current.opt("outer_event_json") ?: current.opt("nostr_event") ?: current.opt("nostr_event_json") ?: return null
        val event=if(raw is JSONObject)raw else JSONObject(raw as? String ?: return null)
        return synchronized(lock) {
            val file=file(context);val values=read(file).toMutableList()
            if(values.none {it.optString("account")==owner&&it.optJSONObject("event")?.optString("id")==id})values.add(JSONObject().put("account",owner).put("event",event))
            val limited=values.takeLast(16)
            write(file,limited)
            val prior=limited.filter {it.optString("account")==owner}.mapNotNull {it.optJSONObject("event")}.filter {it.optString("id")!=id}.toMutableList()
            current.remove("pending_events");current.put("pending_events",org.json.JSONArray(prior))
            while(prior.isNotEmpty()&&current.toString().toByteArray().size>65536){prior.removeAt(0);current.put("pending_events",org.json.JSONArray(prior))}
            current.toString().takeIf {it.toByteArray().size<=65536}
        }
    }
    fun drain(context:Context,owner:String,receive:(String)->Unit)=synchronized(lock) {
        val file=file(context);val values=read(file);val keep=mutableListOf<JSONObject>()
        for(item in values) {
            if(item.optString("account")==owner)runCatching {receive(JSONObject().put("event",item.getJSONObject("event")).toString())} else keep.add(item)
        }
        write(file,keep)
    }
}

class NativePushRuntime private constructor(private val application:android.app.Application) {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val secure=SecureRecord(application,"notifications")
    private val state=NativePushRegistrationQueue()
    private val wake=kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)
    private var lastHTTPStatus=0
    private val tokenLock=Any()
    private var tokenPending=false
    private var lastTokenAttempt:Long?=null
    init {
        state.recordToken(secure.get("token"))
        for(owner in knownOwners()) {
            state.setIntent(owner,secure.get("desired-$owner")=="true")
            state.publish(owner,secure.get("filters-$owner"),android.os.SystemClock.elapsedRealtime())
        }
        scope.launch {
            while(isActive) {
                val work=state.next()
                if(work==null){wake.receive();continue}
                val wait=(work.readyAt-android.os.SystemClock.elapsedRealtime()).coerceAtLeast(0)
                if(wait>0){withTimeoutOrNull(wait){wake.receive()};continue}
                if(!state.begin(work,android.os.SystemClock.elapsedRealtime()))continue
                val success=runCatching {performWork(work)}.getOrDefault(false)
                val current=state.finish(work,success,android.os.SystemClock.elapsedRealtime())
                if(current&&success&&!work.enabled)forgetDisabled(work.owner)
            }
        }
        ensureToken()
    }
    /** Account activation / settings only. Callbacks and polling never set intent. */
    @Synchronized fun activate(owner:String,enabled:Boolean) {
        val previous=secure.get("active-owner")
        if(previous.isNotBlank()&&previous!=owner)setEnabled(previous,false)
        secure.put("active-owner",owner);setEnabled(owner,enabled)
    }
    @Synchronized fun setEnabled(owner:String,enabled:Boolean) {
        if(owner.isBlank())return
        val owners=knownOwners()
        if(owner !in owners&&owners.size>=64)return
        if(owner !in owners)secure.put("owners",org.json.JSONArray(owners+owner).toString())
        if(secure.get("desired-$owner")!=enabled.toString())secure.put("desired-$owner",enabled.toString())
        state.setIntent(owner,enabled)
        wake.trySend(Unit);ensureToken()
    }
    /** Save retrieval scopes even when Firebase has not returned a token yet. */
    @Synchronized fun publish(owner:String,filters:String) {
        if(owner.isBlank()||filters.length>4*1024*1024)return
        if(secure.get("filters-$owner")!=filters)secure.put("filters-$owner",filters)
        state.publish(owner,filters,android.os.SystemClock.elapsedRealtime())
        wake.trySend(Unit);ensureToken()
    }
    @Synchronized fun recordToken(token:String) {
        secure.put("token",token);state.recordToken(token);wake.trySend(Unit)
    }
    private fun ensureToken() {
        if(!state.wantsToken())return
        synchronized(tokenLock) {
            val now=android.os.SystemClock.elapsedRealtime()
            if(tokenPending||lastTokenAttempt?.let {now-it<10000}==true)return
            tokenPending=true;lastTokenAttempt=now
        }
        val revision=state.tokenRevision()
        try {
            FirebaseMessaging.getInstance().token.addOnCompleteListener {result->
                synchronized(tokenLock){tokenPending=false}
                if(result.isSuccessful)result.result?.takeIf {it.isNotBlank()}?.let {value->recordFetchedToken(value,revision)}
            }
        } catch(_:Exception){synchronized(tokenLock){tokenPending=false}}
    }
    @Synchronized private fun recordFetchedToken(token:String,revision:Long) {
        if(!state.recordFetchedToken(token,revision))return
        secure.put("token",token);wake.trySend(Unit)
    }
    private fun performWork(work:NativePushRegistrationQueue.Work):Boolean {
        // Recheck persisted user intent immediately before every request. A token
        // callback cannot revive a disabled account, including across restarts.
        if(!state.isCurrent(work)||secure.get("desired-${work.owner}")!=work.enabled.toString())return false
        val storage="subscription-${work.owner}";val id=secure.get(storage).ifBlank {null}
        val filters=if(work.enabled)JSONObject(work.filters).getJSONArray("filters") else null
        val remove=!work.enabled||filters?.length()==0
        if(remove&&id==null)return true
        val key="registration-${work.owner}";val secret=secure.get(key).ifBlank {generateSecretKey().also {secure.put(key,it)}}
        if(remove) {
            val result=perform(buildPushRequest(secret,"DELETE",ENDPOINT,id,null))
            if(result==null&&lastHTTPStatus!=404)return false
            secure.put(storage,"");return true
        }
        val delivery=JSONObject().put("platform","android").put("token",work.token).put("production",!BuildConfig.DEBUG).put("filters",filters)
        var response=perform(buildPushRequest(secret,"POST",ENDPOINT,id,delivery.toString()))
        var created=id==null
        if(response==null&&id!=null&&lastHTTPStatus==404){response=perform(buildPushRequest(secret,"POST",ENDPOINT,null,delivery.toString()));created=true}
        if(response==null)return false
        // Retain an ID even if disable raced the HTTP response, so the next
        // coalesced cleanup can delete the just-created subscription.
        if(created)secure.put(storage,JSONObject(response).getString("id"))
        return true
    }
    @Synchronized private fun knownOwners():List<String> {
        val values=runCatching {org.json.JSONArray(secure.get("owners").ifBlank {"[]"})}.getOrDefault(org.json.JSONArray())
        return (0 until values.length()).map {values.optString(it)}.filter {it.isNotBlank()}.distinct().take(64)
    }
    @Synchronized private fun forgetDisabled(owner:String) {
        if(secure.get("desired-$owner")!="false")return
        secure.put("owners",org.json.JSONArray(knownOwners().filter {it!=owner}).toString())
    }
    private fun perform(raw:String):String? {
        lastHTTPStatus=0
        val request=JSONObject(raw);val connection=URL(request.getString("url")).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod=request.getString("method");connection.connectTimeout=10000;connection.readTimeout=10000;connection.instanceFollowRedirects=false;connection.useCaches=false
            connection.setRequestProperty("Authorization",request.getString("authorization"));connection.setRequestProperty("Content-Type","application/json")
            request.optional("body")?.let {connection.doOutput=true;connection.outputStream.use {out->out.write(it.toByteArray())}}
            lastHTTPStatus=connection.responseCode
            if(lastHTTPStatus !in 200..299)null else connection.inputStream.bufferedReader().use {reader->
                val buffer=CharArray(65537);var size=0
                while(size<buffer.size){val count=reader.read(buffer,size,buffer.size-size);if(count<0)break;size+=count}
                if(size>65536)null else String(buffer,0,size)
            }
        } finally {connection.disconnect()}
    }
    companion object {
        private const val ENDPOINT="https://notifications.iris.to"
        private var instance:NativePushRuntime?=null
        @Synchronized fun shared(application:android.app.Application):NativePushRuntime = instance ?: NativePushRuntime(application).also {instance=it}
    }
}
