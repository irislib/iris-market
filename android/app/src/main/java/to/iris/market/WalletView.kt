package to.iris.market

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import to.iris.market.core.MarketWallet
import to.iris.market.core.previewCashuToken
import to.iris.market.core.lightningInvoiceQr

val LocalWalletAmountFormatter = staticCompositionLocalOf<(String,String,Boolean)->String> { { amount,_,test -> "$amount ${if(test)"test sats" else "sats"}" } }
internal fun displayWalletAmount(sats:String,mint:String,profile:MarketSnapshot,testOnly:Boolean=false):String {
    val amount=sats.toDoubleOrNull()?:return "$sats sats"
    if(testOnly||isTestMint(mint))return "$sats test sats"
    val currency=runCatching {JSONObject(profile.settings).optString("currency","USD").uppercase()}.getOrDefault("USD")
    if(currency in setOf("SAT","SATS"))return "$sats sats"
    val rate=profile.satsDisplayPrice
    val value=if(currency=="BTC")amount/100_000_000 else if(amount==0.0)0.0 else {
        if(rate==null||rate.currency.uppercase()!=currency||!rate.amount.isFinite()||rate.amount<=0)return "$sats sats"
        amount*rate.amount
    }
    if(!value.isFinite())return "$sats sats"
    if(currency=="BTC")return java.text.NumberFormat.getNumberInstance().apply{maximumFractionDigits=8}.format(value)+" BTC"
    return runCatching {java.text.NumberFormat.getCurrencyInstance().apply{this.currency=java.util.Currency.getInstance(currency);if(value!=0.0&&(kotlin.math.abs(value)<0.01||kotlin.math.abs(value)<Math.pow(10.0,-maximumFractionDigits.toDouble())/2))maximumFractionDigits=8}.format(value)}.getOrDefault("$sats sats")+(if(amount!=0.0&&rate?.stale==true)" · older rate" else "")
}
val LocalWalletOpener = staticCompositionLocalOf<(String?) -> Unit> { {} }
private const val DEFAULT_WALLET_MINT = "https://mint.coinos.io"
private const val TEST_WALLET_MINT = "https://testnut.cashu.space"
private fun mintLabel(mint:String)=runCatching {java.net.URI(mint).host}.getOrNull()?:"Mint"
private fun isTestMint(mint:String)=mint.trimEnd('/')==TEST_WALLET_MINT
private fun exactAmountLabel(value:JSONObject):String="${value.optString("amount","0")} ${if(value.optBoolean("test_only")||isTestMint(value.optString("mint"))) "test sats" else "sats"}"
private fun entries(value:JSONObject,key:String):List<JSONObject> = value.optJSONArray(key)?.let { list -> (0 until list.length()).map {list.getJSONObject(it)} }?:emptyList()
private fun positiveAmount(value:String):ULong {
    require(value.matches(Regex("[1-9][0-9]{0,12}"))) { "Enter a whole amount of sats." }
    return value.toULong().also {require(it<=1_000_000_000_000uL)}
}
private data class NativeWalletState(val ready:Boolean=false,val busy:Boolean=false,val error:String="",val message:String="",val snapshot:JSONObject=JSONObject(),val preview:JSONObject?=null,val invoice:JSONObject?=null,val token:JSONObject?=null,val qr:JSONObject?=null)
/** One serialized session, separate from profile snapshots and messaging. */
private class NativeWalletSession(private val model:MarketModel,private val owner:String) {
    val state=MutableStateFlow(NativeWalletState())
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private val mutex=Mutex()
    private var wallet:MarketWallet?=null
    private var closing=false
    fun run(task:suspend NativeWalletSession.()->Unit) {
        if(closing||state.value.busy)return
        state.value=state.value.copy(busy=true,error="",message="")
        scope.launch {
            try {withContext(Dispatchers.IO){mutex.withLock {if(!closing)task()}}}
            catch(e:CancellationException){throw e}
            catch(_:Exception){state.value=state.value.copy(error="The wallet could not finish. Check your connection and refresh before trying again.")}
            finally {state.value=state.value.copy(busy=false)}
        }
    }
    suspend fun open(){val material=model.walletMaterial(owner);wallet?.close();wallet=null;wallet=MarketWallet(material.baseDirectory.absolutePath,material.owner,material.device,material.seed);refresh(false);state.value=state.value.copy(ready=true)}
    fun refresh(network:Boolean){state.value=state.value.copy(snapshot=JSONObject(requireNotNull(wallet).snapshot(network)))}
    fun preview(token:String){require(token.length<=2*1024*1024);state.value=state.value.copy(preview=JSONObject(previewCashuToken(token)))}
    fun clearPreview(){state.value=state.value.copy(preview=null)}
    fun receive(token:String,mint:String){requireNotNull(wallet).receive(token,mint);refresh(false);state.value=state.value.copy(preview=null,message="Token received in your wallet.")}
    fun send(mint:String,amount:ULong){val token=JSONObject(requireNotNull(wallet).send(mint,amount));refresh(false);state.value=state.value.copy(token=token)}
    fun pending(id:String){state.value=state.value.copy(token=JSONObject(requireNotNull(wallet).pendingToken(id)))}
    fun reclaim(mint:String,id:String){val reclaimed=requireNotNull(wallet).reclaim(mint,id);refresh(true);state.value=state.value.copy(token=null,message=if(reclaimed>0uL)"$reclaimed ${if(isTestMint(mint))"test sats" else "sats"} reclaimed into this wallet." else "No unredeemed funds were returned. Refresh to check this payment.")}
    fun topUp(mint:String,amount:ULong){val invoice=JSONObject(requireNotNull(wallet).topUp(mint,amount));state.value=state.value.copy(invoice=invoice,qr=null);runCatching {require(!invoice.optBoolean("test_only")&&!isTestMint(invoice.getString("mint")));JSONObject(lightningInvoiceQr(invoice.getString("invoice")))}.getOrNull()?.let {state.value=state.value.copy(qr=it)};refresh(false)}
    fun close(){closing=true;scope.launch(Dispatchers.IO){mutex.withLock {wallet?.close();wallet=null};scope.cancel()}}
}

@Composable fun WalletView(model:MarketModel,profile:MarketSnapshot,initialToken:String?=null,close:()->Unit) {
    fun amountLabel(value:JSONObject)=displayWalletAmount(value.optString("amount","0"),value.optString("mint"),profile,value.optBoolean("test_only"))
    val context=LocalContext.current
    val clipboard=LocalClipboardManager.current
    val session=remember(profile.publicKey){NativeWalletSession(model,profile.publicKey)}
    val state by session.state.collectAsState()
    var receiveText by remember(initialToken){mutableStateOf(initialToken?:"")}
    var mint by remember {mutableStateOf(DEFAULT_WALLET_MINT)}
    var amount by remember {mutableStateOf("")}
    var mode by remember(initialToken){mutableStateOf(if(initialToken.isNullOrBlank()) "" else "receive")}
    var approveMint by remember(state.preview){mutableStateOf(false)}
    var confirmSend by remember {mutableStateOf(false)}
    var confirmReclaim by remember {mutableStateOf<Pair<String,String>?>(null)}
    var notice by remember {mutableStateOf("")}
    DisposableEffect(session){onDispose {session.close()}}
    fun copy(text:String){clipboard.setText(AnnotatedString(text));notice="Copied"}
    fun openExternal(invoice:String){runCatching {context.startActivity(Intent(Intent.ACTION_VIEW,Uri.parse("lightning:"+invoice.removePrefix("lightning:"))))}.onFailure {notice="No Lightning wallet is available. Copy the invoice to your wallet."}}
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp).navigationBarsPadding(),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Wallet",style=MaterialTheme.typography.headlineMedium);TextButton(onClick=close){Text("Close")}}
        if(profile.demo||profile.publicKey.isBlank()) {Text("Choose your profile in the live market to use its wallet.");return@Column}
        Text("Cashu funds stay with their mint. This wallet is stored on this device, separately from your profile.",style=MaterialTheme.typography.bodySmall)
        if(state.error.isNotBlank())Text(state.error,color=MaterialTheme.colorScheme.error)
        if(state.message.isNotBlank())Text(state.message)
        if(notice.isNotBlank())Text(notice,style=MaterialTheme.typography.bodySmall)
        if(state.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(!state.ready){Button(enabled=!state.busy,onClick={session.run {open()}}){Icon(Icons.Filled.AccountBalanceWallet,null);Spacer(Modifier.width(8.dp));Text("Enable or open wallet")};return@Column}
        if(state.snapshot.optInt("warning_count")>0)Text("Some mint updates are unavailable. Saved funds are preserved; refresh to check again.",style=MaterialTheme.typography.bodySmall)
        Text("Balances",style=MaterialTheme.typography.titleLarge)
        val balances=entries(state.snapshot,"balances")
        if(balances.isEmpty())Text("No funds yet.",style=MaterialTheme.typography.bodySmall)
        balances.forEach {balance->Column {Text(amountLabel(balance),style=MaterialTheme.typography.titleMedium);if(amountLabel(balance)!=exactAmountLabel(balance))Text(exactAmountLabel(balance),style=MaterialTheme.typography.bodySmall);Text(mintLabel(balance.getString("mint")),style=MaterialTheme.typography.bodySmall);if(balance.optBoolean("test_only")||isTestMint(balance.getString("mint")))Text("Test money · no bitcoin value",style=MaterialTheme.typography.bodySmall)}}
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedButton(enabled=!state.busy,onClick={session.run{refresh(true)}}){Text("Refresh")};TextButton(onClick={mode="receive"}){Text("Receive")};TextButton(onClick={mode="send"}){Text("Send")};TextButton(onClick={mode="topup"}){Text("Add funds")}}
        if(mode=="receive"){
            Text("Receive Cashu",style=MaterialTheme.typography.titleMedium)
            OutlinedTextField(receiveText,{receiveText=it;session.clearPreview()},label={Text("Paste Cashu token")},modifier=Modifier.fillMaxWidth(),minLines=3,enabled=!state.busy)
            Button(enabled=!state.busy&&receiveText.isNotBlank(),onClick={val token=receiveText.trim();session.run{preview(token)}}){Text("Review token")}
            state.preview?.let {preview->
                Text(amountLabel(preview));if(amountLabel(preview)!=exactAmountLabel(preview))Text(exactAmountLabel(preview),style=MaterialTheme.typography.bodySmall);Text(preview.getString("mint"),style=MaterialTheme.typography.bodySmall)
                Row {Checkbox(approveMint,{approveMint=it},enabled=!state.busy);Text("I trust this mint to hold these funds.",Modifier.padding(top=12.dp))}
                Button(enabled=!state.busy&&approveMint,onClick={val token=receiveText.trim();val approved=preview.getString("mint");session.run{receive(token,approved);receiveText=""}}){Text("Receive into wallet")}
            }
        }
        if(mode=="send"||mode=="topup"){
            Text(if(mode=="send")"Send Cashu" else "Add funds with Lightning",style=MaterialTheme.typography.titleMedium)
            OutlinedTextField(mint,{mint=it},label={Text("Mint URL")},singleLine=true,modifier=Modifier.fillMaxWidth(),enabled=!state.busy)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){TextButton(onClick={mint=DEFAULT_WALLET_MINT}){Text("Coinos")};TextButton(onClick={mint=TEST_WALLET_MINT}){Text("Testnut · test money")}}
            OutlinedTextField(amount,{amount=it.filter {c->c in '0'..'9'}.take(13)},label={Text(if(isTestMint(mint))"Amount in test sats" else "Amount in sats")},singleLine=true,modifier=Modifier.fillMaxWidth(),enabled=!state.busy)
            if(isTestMint(mint))Text("Test money · no bitcoin value",style=MaterialTheme.typography.bodySmall)
            if(mode=="send")Button(enabled=!state.busy&&runCatching {positiveAmount(amount)}.isSuccess,onClick={confirmSend=true}){Text("Review transfer")}
            else Button(enabled=!state.busy&&runCatching {positiveAmount(amount)}.isSuccess,onClick={val target=mint.trim();val value=positiveAmount(amount);session.run{topUp(target,value)}}){Text("Create Lightning invoice")}
        }
        state.invoice?.let {invoice->
            Text("Lightning invoice",style=MaterialTheme.typography.titleMedium)
            Text(amountLabel(invoice));if(amountLabel(invoice)!=exactAmountLabel(invoice))Text(exactAmountLabel(invoice),style=MaterialTheme.typography.bodySmall);Text(mintLabel(invoice.getString("mint")),style=MaterialTheme.typography.bodySmall)
            val testOnly=invoice.optBoolean("test_only")||isTestMint(invoice.getString("mint"))
            if(testOnly)Text("Test money · no bitcoin value. Do not pay this invoice with a real Lightning wallet.",style=MaterialTheme.typography.bodySmall)
            else {state.qr?.let {InvoiceQr(it)};Text("Scan with your Lightning wallet, or copy the invoice. Refresh after paying to check receipt.",style=MaterialTheme.typography.bodySmall)}
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedButton(onClick={copy(invoice.getString("invoice"))}){Text(if(testOnly)"Copy test invoice" else "Copy invoice")};if(!testOnly)Button(onClick={openExternal(invoice.getString("invoice"))}){Text("Open wallet")}}
        }
        state.token?.let {token->
            Text("Cashu transfer",style=MaterialTheme.typography.titleMedium);Text(amountLabel(token));if(amountLabel(token)!=exactAmountLabel(token))Text(exactAmountLabel(token),style=MaterialTheme.typography.bodySmall);Text("Anyone with this token can redeem it. Keep it private.",style=MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button(onClick={copy(token.getString("token"))}){Text("Copy token")};OutlinedButton(onClick={context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,token.getString("token")),"Share Cashu token"))}){Text("Share")}}
            TextButton(enabled=!state.busy,onClick={confirmReclaim=token.getString("mint") to token.getString("operation_id")}){Text("Reclaim payment")}
        }
        Text("Activity",style=MaterialTheme.typography.titleLarge)
        entries(state.snapshot,"activity").take(40).forEach {entry->
            Column {Text("${entry.optString("kind").replace('_',' ')} · ${amountLabel(entry)}");Text("${mintLabel(entry.optString("mint"))} · ${entry.optString("status")}",style=MaterialTheme.typography.bodySmall)
                val operation=entry.optString("operation_id").takeUnless {it.isBlank()||it=="null"}
                if(entry.optString("kind")=="token_send"&&entry.optString("status")=="pending"&&operation!=null)Row{TextButton(enabled=!state.busy,onClick={session.run{pending(operation)}}){Text("Show recoverable token")};TextButton(enabled=!state.busy,onClick={confirmReclaim=entry.getString("mint") to operation}){Text("Reclaim payment")}}
            };HorizontalDivider()
        }
    }
    confirmReclaim?.let { target->AlertDialog(onDismissRequest={confirmReclaim=null},title={Text("Reclaim payment?")},text={Text("Only ordinary unredeemed tokens can return to this wallet. Locked payments may require the recipient. A successful reclaim makes the old token stop working.")},confirmButton={TextButton(enabled=!state.busy,onClick={confirmReclaim=null;session.run{reclaim(target.first,target.second)}}){Text("Reclaim unredeemed funds")}},dismissButton={TextButton(onClick={confirmReclaim=null}){Text("Cancel")}}) }
    if(confirmSend)AlertDialog(onDismissRequest={confirmSend=false},title={Text("Create Cashu token?")},text={Text("Send ${displayWalletAmount(amount,mint,profile)} ($amount ${if(isTestMint(mint))"test sats" else "sats"}) from ${mintLabel(mint)}. Mint fees may apply. Anyone you share the token with can redeem it.")},confirmButton={TextButton(onClick={confirmSend=false;val target=mint.trim();val value=positiveAmount(amount);session.run{send(target,value)}}){Text("Create token")}},dismissButton={TextButton(onClick={confirmSend=false}){Text("Cancel")}})
}

@Composable private fun InvoiceQr(qr:JSONObject) {
    val modules=qr.optJSONArray("modules")?:return
    if(modules.length()==0||modules.length()>177)return
    Canvas(Modifier.fillMaxWidth().aspectRatio(1f).background(Color.White).padding(12.dp).semantics {contentDescription="Lightning invoice QR code"}) {
        val count=modules.length();val step=size.minDimension/(count+8)
        for(y in 0 until count){val row=modules.optJSONArray(y)?:continue;for(x in 0 until count)if(row.optBoolean(x))drawRect(Color.Black,Offset((x+4)*step,(y+4)*step),Size(step,step))}
    }
}
