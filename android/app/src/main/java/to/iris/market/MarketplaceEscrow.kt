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

data class EscrowInboxCard(val id:String,val title:String,val participants:List<String>,val listing:String,val sats:Long?,val outcome:String,val orderId:String?,val joined:Boolean=false) {
    fun matches(order:MarketOrder) = id==order.escrowTradeId && orderId==order.id && listing==order.items.firstOrNull()?.id &&
        participants==listOf(order.buyer,order.seller,order.escrowProvider)
}
internal data class EscrowCheckout(val quantity:Int,val note:String,val delivery:OrderDeliveryRequest?=null,val resumeOrder:MarketOrder?=null) {
    fun selection()=JSONObject().put("quantity",quantity).put("note",note).apply {
        resumeOrder?.let { put("resume",true);put("provider",it.escrowProvider) }
    }
}
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
        cards[id]=EscrowInboxCard(id,d.optString("title","Trade"),participants,d.optString("listing_id"),d.optLong("sats").takeIf {it>0},s.optString("outcome"),d.textOrNull("order_id"))
    }
    return cards.values.reversed().map {it.copy(joined=it.id in joined)}
}
@Composable internal fun EscrowCardsView(state:MarketSnapshot,model:MarketModel,peer:String?=null,listing:String?=null,jobsOnly:Boolean=false){
    var active by remember(state.publicKey){mutableStateOf<String?>(null)}
    val enabled=JSONObject(state.settings).optBoolean("escrow_ui")
    val coordinate=listing?.removePrefix("30402:")
    val cards=state.escrowInvites.filter {(enabled || it.joined) && (peer==null || peer in it.participants) && (coordinate==null || coordinate==it.listing) && (!jobsOnly || it.participants[2]==state.publicKey)}
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        if(jobsOnly && cards.isEmpty()) {
            Text("No escrow jobs yet",style=MaterialTheme.typography.titleMedium)
            Text("Private invitations to provide escrow appear here. You choose which jobs to accept.")
        }
        for(card in cards){
            val status=when(card.outcome){"release"->"Payment released";"refund"->"Payment refunded";"declined"->"Declined";"disputed"->"Help requested";else->if(card.joined)"In progress" else "Invitation"}
            val amount=card.sats?.let { java.text.NumberFormat.getIntegerInstance().format(it)+" sats" }
            OutlinedButton(onClick={active=card.id}){Text(listOfNotNull(if(card.participants[2]==state.publicKey)"Escrow job" else "Escrow",card.title,amount,status).joinToString(" · "))}
        }
    }
    active?.let {id->EscrowDialog(model,null,id){active=null}}
}

private const val escrowOrigin="https://escrow.iris.invalid/"
private val assets=mapOf("index.html" to "text/html","trade.js" to "text/javascript","screen.js" to "text/javascript","native.js" to "text/javascript","trade.css" to "text/css")
private class TradeBridge(val model:MarketModel,val owner:String,val listing:String?,var trade:String?,val checkout:EscrowCheckout?,val orderCreated:(String)->Unit,val openChat:(String)->Unit,val scope:CoroutineScope) {
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
            "selection"->JSONObject().put("listing_id",listing).put("trade_id",trade).put("order",checkout?.selection())
            "createOrder"->{
                val id=args.getString("trade_id")
                val provider=args.getString("provider")
                val checkout=checkNotNull(checkout)
                check(enabled && listing==args.getString("listing_id") && (trade==null || id==trade))
                check(checkout.quantity==args.getInt("quantity") && checkout.note==args.getString("note"))
                fun existing()=model.state.value.orders.firstOrNull { it.escrowTradeId==id && it.buyer==owner && it.escrowProvider==provider &&
                    it.items.firstOrNull()?.id==listing && it.items.firstOrNull()?.quantity==checkout.quantity && it.note==checkout.note }
                existing()?.let { if(checkout.resumeOrder==null)orderCreated(it.id); it.id } ?: run {
                    check(checkout.resumeOrder==null) {"The order changed. Reopen it to continue."}
                    val request=JSONObject().put("type","request_order").put("listing_id",listing).put("quantity",checkout.quantity)
                        .put("note",checkout.note).put("escrow_trade_id",id).put("escrow_provider",provider)
                    checkout.delivery?.let {request.put("delivery_request",it.json())}
                    model.escrowSend(request,owner)
                    val order=existing() ?: error("Could not find the saved order.")
                    orderCreated(order.id)
                    order.id
                }
            }
            "acceptOrder"->{
                check(enabled && trade!=null && args.getString("trade_id")==trade)
                val order=s.orders.firstOrNull { it.id==args.getString("id") && it.seller==owner } ?: error("Open this order as the seller.")
                check(order.escrowProvider==args.getString("provider") && s.escrowInvites.any { it.id==trade && it.matches(order) && it.outcome!="declined" } &&
                    order.status in setOf("requested","accepted","in-transit")){"Review the current order and its provider before accepting."}
                if(order.status=="requested")model.escrowSend(JSONObject().put("type","update_order").put("order_id",order.id)
                    .put("patch",JSONObject().put("status","accepted")),owner)
                true
            }
            "order"->{
                val order=s.orders.firstOrNull { it.id==args.getString("id") && owner in listOf(it.buyer,it.seller) }
                    ?: error("The linked order has not reached this device yet.")
                check(order.escrowTradeId!=null && order.escrowProvider!=null)
                JSONObject().put("id",order.id).put("buyer",order.buyer).put("seller",order.seller).put("listing_id",order.items.first().id)
                    .put("provider",order.escrowProvider).put("trade_id",order.escrowTradeId).put("status",order.status).put("quantity",order.items.first().quantity)
            }
            "contact"->{
                val peer=args.getString("peer")
                check(peer!=owner && trade==args.getString("trade_id") && s.escrowInvites.any { it.id==trade && peer in it.participants && owner in it.participants })
                model.escrowSend(JSONObject().put("type","contact").put("author",peer),owner)
                openChat(peer)
                true
            }
            "context"->{
                val names=s.people.mapValues { it.value.name }
                val candidates=names.filterValues {it.isNotBlank()}.mapValues { (id,name)->JSONObject().put("id",id).put("name",name) }.toMutableMap()
                s.conversations.forEach { candidates[it.id]=JSONObject().put("id",it.id).put("name",names[it.id]?:it.name).put("contact",true) }
                JSONObject().put("owner",owner).put("enabled",true).put("canProvide",s.canSign).put("allowFunding",enabled).put("names",JSONObject(names))
                    .put("contacts",JSONArray(candidates.values.toList())).put("mints",JSONArray().apply {
                        if(BuildConfig.DEBUG)System.getenv("MARKET_ESCROW_TEST_MINT")?.takeIf {it.startsWith("http://127.0.0.1:")}?.let{put(it)}
                        put("https://mint.coinos.io");put("https://testnut.cashu.space")
                    })
            }
            "discoverProviders"->{
                check(enabled && trade==null && listing!=null && args.getString("listing_id")==listing)
                model.escrowSend(JSONObject().put("type","discover_escrow_providers"),owner)
                JSONObject(model.escrowRead("listing",listing,owner)).optJSONArray("escrow_candidates") ?: JSONArray()
            }
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
            "wallet"->{check(trade!=null && args.getString("trade_id")==trade)
                val op=args.getString("op")
                check(op!="fund" || enabled){"Enable escrow in Settings before funding this order."}
                check(op !in setOf("fund","prepare","cosign","complete") || s.messagingReady){"Approve this device for private messages before moving funds."}
                val material=model.walletMaterial(owner)
                withContext(Dispatchers.IO){MarketWallet(material.baseDirectory.absolutePath,material.owner,material.device,material.seed).use { wallet -> JSONTokener(wallet.escrow(args.toString())).nextValue() }}
            }
            "rate"->{check(trade!=null && args.getString("trade_id")==trade);val rating=args.getInt("rating");check(rating in 1..5);model.publishReview(args.getString("profile"),rating,"",owner);true}
            else->error("Unknown trade action.")
        }
    }
}
@SuppressLint("SetJavaScriptEnabled")
@Composable internal fun EscrowDialog(model:MarketModel,listing:String?,trade:String?,checkout:EscrowCheckout?=null,orderCreated:(String)->Unit={},done:()->Unit){
    val state by model.state.collectAsState()
    val scope=rememberCoroutineScope()
    val owner=remember {state.publicKey}
    var chatPeer by remember(owner,listing,trade){mutableStateOf<String?>(null)}
    val bridge=remember(owner,listing,trade){TradeBridge(model,owner,listing,trade,checkout,orderCreated,{chatPeer=it},scope)}
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
    chatPeer?.let { peer ->
        Dialog(onDismissRequest={chatPeer=null},properties=DialogProperties(usePlatformDefaultWidth=false)) {
            Surface(Modifier.fillMaxSize().systemBarsPadding()) {
                val chat=state.conversations.firstOrNull {it.id==peer} ?: Conversation(peer,"Conversation",emptyList())
                ConversationView(chat.copy(messages=chat.messages.filter {it.threadKey=="general"}), state.people[peer]?:PublicPerson.unnamed(peer),
                    model,false,{},context=null,accountID=owner,threadKey="general",back={chatPeer=null})
            }
        }
    }
}
