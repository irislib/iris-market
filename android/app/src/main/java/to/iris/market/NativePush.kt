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
import java.lang.ref.WeakReference
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
    @Volatile private var model=WeakReference<MarketModel>(null)
    fun attach(value:MarketModel){model=WeakReference(value)}
    fun current():MarketModel?=model.get()
}
class MarketFirebaseMessagingService:FirebaseMessagingService() {
    override fun onNewToken(token:String) {
        runCatching {
            val secure=SecureRecord(application,"notifications");secure.put("token",token)
            val model=NativePushBridge.current()
            if(model!=null)model.syncPush() else {
                val owner=secure.get("preview").takeIf {it.isNotBlank()}?.let(::JSONObject)?.optString("owner")
                if(!owner.isNullOrBlank()&&secure.get("desired-$owner")=="true") {
                    val filters=secure.get("filters-$owner")
                    if(filters.isNotBlank())NativePushRuntime(application).sync(owner,filters,true)
                }
            }
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

class NativePushRuntime(private val application:android.app.Application) {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val secure=SecureRecord(application,"notifications")
    private val syncMutex=kotlinx.coroutines.sync.Mutex()
    private var signature:String?=null
    private var lastHTTPStatus=0
    private val inFlight=java.util.concurrent.atomic.AtomicBoolean(false)
    private var lastAttempt=0L
    private val pendingDisable=mutableSetOf<String>()
    fun sync(owner:String,filters:String,enabled:Boolean) {
        secure.put("desired-$owner",enabled.toString())
        if(enabled) {
            if(!inFlight.compareAndSet(false,true))return
            if(System.currentTimeMillis()-lastAttempt<10000){inFlight.set(false);return}
            lastAttempt=System.currentTimeMillis()
        } else synchronized(pendingDisable){if(!pendingDisable.add(owner))return}
        scope.launch {
            syncMutex.lock()
            try {
                if(secure.get("desired-$owner")!=enabled.toString())return@launch
                val token=secure.get("token")
                val next="$owner|$enabled|$token|$filters"
                if(next==signature)return@launch
                val key="registration-$owner";val secret=secure.get(key).ifBlank {generateSecretKey().also {secure.put(key,it)}}
                val storage="subscription-$owner";val id=secure.get(storage).ifBlank {null}
                if(!enabled) {
                    if(id!=null && perform(buildPushRequest(secret,"DELETE",ENDPOINT,id,null))==null && lastHTTPStatus!=404)return@launch
                    secure.put(storage,"");signature=next;return@launch
                }
                if(token.isBlank()){FirebaseMessaging.getInstance().token.addOnSuccessListener {value->secure.put("token",value);if(secure.get("desired-$owner")=="true")sync(owner,filters,true)};return@launch}
                val filter=JSONObject(filters).getJSONArray("filters");if(filter.length()==0)return@launch
                secure.put("filters-$owner",filters)
                val delivery=JSONObject().put("platform","android").put("token",token).put("production",!BuildConfig.DEBUG).put("filters",filter)
                var response=perform(buildPushRequest(secret,"POST",ENDPOINT,id,delivery.toString()))
                var created=id==null
                if(response==null&&id!=null&&lastHTTPStatus==404){response=perform(buildPushRequest(secret,"POST",ENDPOINT,null,delivery.toString()));created=true}
                if(response==null)return@launch
                if(created)secure.put(storage,JSONObject(response).getString("id"))
                signature=next
            } catch(_:Exception) { /* Foreground state refresh retries; UI remains local-first. */ }
            finally {syncMutex.unlock();if(enabled)inFlight.set(false) else synchronized(pendingDisable){pendingDisable.remove(owner)}}
        }
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
    companion object {private const val ENDPOINT="https://notifications.iris.to"}
}
