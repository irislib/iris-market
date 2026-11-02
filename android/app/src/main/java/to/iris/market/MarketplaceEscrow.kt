package to.iris.market

import android.annotation.SuppressLint
import android.webkit.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import to.iris.market.core.MarketWallet
import to.iris.market.core.escrowProfileKey

data class EscrowInboxCard(val id:String,val title:String,val participants:List<String>,val listing:String,val sats:Long?,val outcome:String,val joined:Boolean=false)
internal fun escrowCards(snapshot:JSONObject):List<EscrowInboxCard> {
    val rows=snapshot.optJSONArray("trade_steps") ?: return emptyList()
    val owner=snapshot.optString("public_key")
    val cards=linkedMapOf<String,EscrowInboxCard>()
    val joined=mutableSetOf<String>()
    for(i in 0 until rows.length()) {
        val r=rows.optJSONObject(i) ?: continue
        val s=r.optJSONObject("step") ?: continue
        if(r.optBoolean("mine") && s.optString("action")=="join")joined+=s.optString("trade_id")
        val d=s.optJSONObject("deal") ?: continue
        val actor=if(r.optBoolean("mine"))owner else r.optString("peer")
        val participants=listOf("buyer","seller","provider").map { d.optString(it) }
        if(s.optString("action")!="invite" || d.optString("taker")!=actor || owner !in participants)continue
        val id=s.optString("trade_id")
        cards[id]=EscrowInboxCard(id,d.optString("title","Trade"),participants,d.optString("listing_id"),d.optLong("sats").takeIf {it>0},s.optString("outcome"))
    }
    return cards.values.reversed().map {it.copy(joined=it.id in joined)}
}
@Composable internal fun EscrowCardsView(state:MarketSnapshot,model:MarketModel,peer:String?=null,listing:String?=null){
    var active by remember(state.publicKey){mutableStateOf<String?>(null)}
    val enabled=JSONObject(state.settings).optBoolean("escrow_ui")
    val coordinate=listing?.removePrefix("30402:")
    Column {
        for(card in state.escrowInvites.filter {(enabled || it.joined) && (peer==null || peer in it.participants) && (coordinate==null || coordinate==it.listing)}){
            val status=when(card.outcome){"release"->"Release receipt";"refund"->"Refund receipt";else->if(card.joined)"In progress" else "Invitation"}
            val amount=card.sats?.let { java.text.NumberFormat.getIntegerInstance().format(it)+" sats" }
            OutlinedButton(onClick={active=card.id}){Text(listOfNotNull("Escrow",card.title,amount,status).joinToString(" · "))}
        }
    }
    active?.let {id->EscrowDialog(model,null,id){active=null}}
}

private const val escrowOrigin="https://escrow.iris.invalid/"
private val assets=mapOf("index.html" to "text/html","trade.js" to "text/javascript","screen.js" to "text/javascript","native.js" to "text/javascript","trade.css" to "text/css")
private class TradeBridge(val model:MarketModel,val owner:String,val listing:String?,var trade:String?,val scope:CoroutineScope) {
    var view:WebView?=null
    var revision=-1
    @JavascriptInterface fun request(id:Int,raw:String){
        if(id<1 || raw.length>350000)return
        scope.launch {
            val web=view ?: return@launch
            val response=JSONObject()
            try {
                check(web.url==escrowOrigin+"index.html" && model.state.value.publicKey==owner && !model.state.value.demo) { "Reopen the trade from your profile." }
                val envelope=JSONObject(raw)
                response.put("result",call(envelope.getString("method"),envelope.optJSONObject("args") ?: JSONObject()))
            }catch(e:CancellationException){return@launch}
             catch(e:Exception){response.put("error",e.message?.take(220) ?: "The trade could not complete this action.")}
            if(view===web && model.state.value.publicKey==owner)web.evaluateJavascript("window.escrowAnswer($id,JSON.parse("+JSONObject.quote(response.toString())+"));",null)
        }
    }
    private suspend fun call(method:String,args:JSONObject):Any {
        val s=model.state.value
        val enabled=JSONObject(s.settings).optBoolean("escrow_ui")
        check(enabled || s.escrowInvites.any { it.id==trade && it.joined }){"Enable escrow in Settings first."}
        return when(method){
            "selection"->JSONObject().apply { if(trade!=null)put("trade_id",trade)else put("listing_id",listing) }
            "context"->JSONObject().put("owner",owner).put("enabled",true).put("allowFunding",enabled).put("names",JSONObject(s.people.mapValues { it.value.name })).put("contacts",JSONArray().apply {s.conversations.forEach {put(JSONObject().put("id",it.id).put("name",s.people[it.id]?.name ?: it.name))}})
                .put("mints",JSONArray().apply { if(BuildConfig.DEBUG)System.getenv("MARKET_ESCROW_TEST_MINT")?.takeIf {it.startsWith("http://127.0.0.1:")}?.let{put(it)};put("https://mint.coinos.io");put("https://testnut.cashu.space") })
            "profileKey"->escrowProfileKey(args.getString("value"))
            "records"->{check(trade!=null && args.getString("trade_id")==trade);val rows=JSONArray(model.escrowRead(method,"",owner))
                JSONArray().apply {for(i in 0 until rows.length()){val r=rows.getJSONObject(i);if(r.getJSONObject("step").optString("trade_id")==trade)put(r)}}}
            "listing"->JSONObject(model.escrowRead(method,args.getString("id"),owner,args.optBoolean("latest")))
            "certificate"->JSONObject(model.escrowRead(method,args.getString("key"),owner))
            "send"->{val step=args.getJSONObject("step");val next=step.getString("trade_id")
                if(trade==null){val deal=step.getJSONObject("deal");check(step.getString("action")=="invite" && deal.getString("listing_id")==listing && deal.getString("taker")==owner)}
                else check(trade==next)
                model.escrowSend(JSONObject().put("type","send_trade_step").put("peers",args.getJSONArray("peers")).put("step",step).put("operation_id",args.getString("operation_id")),owner)
                trade=next;true
            }
            "wallet"->{check(trade!=null && args.getString("trade_id")==trade);val material=model.walletMaterial(owner)
                withContext(Dispatchers.IO){MarketWallet(material.baseDirectory.absolutePath,material.owner,material.device,material.seed).use { wallet -> JSONTokener(wallet.escrow(args.toString())).nextValue() }}
            }
            "rate"->{check(trade!=null && args.getString("trade_id")==trade);val rating=args.getInt("rating");check(rating in 1..5);model.publishReview(args.getString("profile"),rating,"",owner);true}
            else->error("Unknown trade action.")
        }
    }
}
@SuppressLint("SetJavaScriptEnabled")
@Composable internal fun EscrowDialog(model:MarketModel,listing:String?,trade:String?,done:()->Unit){
    val state by model.state.collectAsState()
    val scope=rememberCoroutineScope()
    val owner=remember {state.publicKey}
    val bridge=remember(owner,listing,trade){TradeBridge(model,owner,listing,trade,scope)}
    LaunchedEffect(state.publicKey){if(state.publicKey!=owner)done()}
    DisposableEffect(bridge){onDispose {bridge.view?.let {it.removeJavascriptInterface("IrisNativeEscrow");it.stopLoading();it.destroy()};bridge.view=null}}
    Dialog(onDismissRequest=done,properties=DialogProperties(usePlatformDefaultWidth=false)) {
        Surface(Modifier.fillMaxSize()) {Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal=12.dp),horizontalArrangement=Arrangement.SpaceBetween){Text("Escrow trade",Modifier.padding(12.dp),style=MaterialTheme.typography.titleLarge);TextButton(onClick=done){Text("Close")}}
            AndroidView(factory={ctx->WebView(ctx).apply {
                settings.javaScriptEnabled=true;settings.domStorageEnabled=false;settings.allowFileAccess=false;settings.allowContentAccess=false
                settings.javaScriptCanOpenWindowsAutomatically=false;settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
                webViewClient=object:WebViewClient(){
                    override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?):Boolean=true
                    override fun shouldInterceptRequest(view:WebView?,req:WebResourceRequest?):WebResourceResponse{
                        val name=req?.url?.toString()?.removePrefix(escrowOrigin)
                        val mime=assets[name]
                        return if(mime!=null && req?.url?.toString()==escrowOrigin+name) WebResourceResponse(mime,"UTF-8",ctx.assets.open(name!!))
                        else WebResourceResponse("text/plain","UTF-8",403,"Blocked",emptyMap(),null)
                    }
                }
                addJavascriptInterface(bridge,"IrisNativeEscrow");bridge.view=this;loadUrl(escrowOrigin+"index.html")
            }},modifier=Modifier.fillMaxSize(),update={if(bridge.revision!=state.escrowRevision){bridge.revision=state.escrowRevision;it.evaluateJavascript("window.escrowRefresh?.()",null)}})
        }}
    }
}
