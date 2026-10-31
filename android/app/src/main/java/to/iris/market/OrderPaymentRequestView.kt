package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable fun OrderPaymentRequestView(order:MarketOrder,model:MarketModel,busy:Boolean,close:()->Unit) {
    var amount by remember {mutableStateOf("")};var mint by remember {mutableStateOf("https://mint.coinos.io")};var error by remember {mutableStateOf<String?>(null)}
    val value=amount.toULongOrNull()?.takeIf {it in 1uL..1_000_000_000_000uL}
    Column(Modifier.fillMaxWidth().imePadding().padding(24.dp),verticalArrangement=Arrangement.spacedBy(18.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Request payment",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("Cancel")}}
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){FilterChip(mint=="https://mint.coinos.io",{mint="https://mint.coinos.io"},label={Text("Coinos")});FilterChip(mint=="https://testnut.cashu.space",{mint="https://testnut.cashu.space"},label={Text("Testnut · test money")})}
        OutlinedTextField(amount,{amount=it.filter(Char::isDigit).take(13)},label={Text(if(mint.contains("testnut"))"Amount in test sats" else "Amount in sats")},singleLine=true,modifier=Modifier.fillMaxWidth())
        Text("The buyer reviews the mint, amount and wallet fee before paying.",style=MaterialTheme.typography.bodySmall,color=Muted)
        if(mint.contains("testnut"))Text("Test money · no bitcoin value",style=MaterialTheme.typography.bodySmall,color=Muted)
        error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
        Button(enabled=!busy&&value!=null,onClick={if(value!=null)model.orderCommand(JSONObject().put("type","update_order").put("order_id",order.id).put("patch",JSONObject().put("payment",JSONObject().put("mint",mint).put("amount",value.toString()).put("unit","sat").put("status","requested"))),onSuccess=close,onError={error=it})},modifier=Modifier.fillMaxWidth()){Text("Request payment")}
    }
}
