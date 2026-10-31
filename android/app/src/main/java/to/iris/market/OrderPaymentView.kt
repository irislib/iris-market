package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Retrying an order payment reuses the wallet's durable token operation. */
@Composable fun OrderPaymentView(order:MarketOrder,state:MarketSnapshot,model:MarketModel,close:()->Unit) {
    val owner=state.publicKey
    val session=remember(owner,order.id){NativeWalletSession(model,owner)}
    val wallet by session.state.collectAsState()
    val payment=order.payment
    var confirming by remember {mutableStateOf(false)}
    DisposableEffect(session){onDispose{session.close()}}
    Column(Modifier.fillMaxWidth().padding(24.dp),verticalArrangement=Arrangement.spacedBy(16.dp)) {
        Text("Pay order",style=MaterialTheme.typography.headlineSmall)
        if(payment==null||payment.status!="requested"||order.buyer!=owner){Text("No payment awaiting confirmation.");TextButton(onClick=close){Text("Close")};return@Column}
        Text(displayWalletAmount(payment.amount,payment.mint,state))
        Text(mintLabel(payment.mint))
        if(isTestMint(payment.mint))Text("Test money · no bitcoin value")
        Text("The token goes privately to the seller. Payment is confirmed only after the seller redeems it.")
        if(wallet.busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        if(wallet.error.isNotBlank())Text(wallet.error,color=MaterialTheme.colorScheme.error)
        if(wallet.message.isNotBlank())Text(wallet.message)
        if(wallet.snapshot.optBoolean("review_required")){
            Text("Refresh this restored wallet before paying.")
            Button(enabled=!wallet.busy,onClick={session.run{refresh(true)}}){Text("Refresh")}
        }
        Button(enabled=!wallet.busy&&!wallet.snapshot.optBoolean("review_required"),onClick={
            val mint=payment.mint;val amount=payment.amount
            val digest=java.security.MessageDigest.getInstance("SHA-256").digest((order.id+"\n"+mint+"\n"+amount).toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it.toInt() and 255)}
            session.run{if(!this.state.value.ready)open();reviewSend(mint,amount.toULong(),"order-payment:$digest");confirming=true}
        }){Text(if(wallet.token!=null)"Retry payment" else "Review payment")}
        if(wallet.token!=null)Text("Your payment token is saved in wallet activity. Retry here to send the same token; do not create another payment.",style=MaterialTheme.typography.bodySmall)
        TextButton(onClick=close){Text("Done")}
    }
    val review=wallet.sendReview
    if(confirming&&review!=null){
        val current=payment!=null&&payment.status=="requested"&&payment.mint==review.optString("mint_url")&&payment.amount==review.optString("amount_sat")&&order.buyer==owner
        if(current)WalletFeeConfirmation(review,if(review.optBoolean("existing"))"Retry sending payment" else "Pay order",{confirming=false}){confirming=false;session.run{payOrder(review,order.id)}}
        else LaunchedEffect(Unit){confirming=false}
    }
}
