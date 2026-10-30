package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

/** A bearer payment is never redeemed or placed on the clipboard without an explicit action. */
data class CashuPayment(val token: String, val amount: String, val mint: String, val unit: String, val status: String, val testOnly:Boolean=false) {
    val displayAmount: String get() = "$amount ${if (testOnly || mint.trimEnd('/') == "https://testnut.cashu.space") "test sats" else if (unit.lowercase() in listOf("sat", "sats")) "sats" else unit.uppercase()}"
    val mintLabel: String get() = runCatching { java.net.URI(mint).host }.getOrNull() ?: "Mint"
    companion object {
        fun parse(value: JSONObject): CashuPayment = CashuPayment(value.getString("token"), value.getString("amount"), value.getString("mint"), value.getString("unit"), value.optString("status", "unverified"),value.optBoolean("test_only"))
    }
}

@Composable fun PaymentMessage(payment: CashuPayment, mine: Boolean) {
    val openWallet = LocalWalletOpener.current
    val formatAmount = LocalWalletAmountFormatter.current
    val displayAmount = if(payment.unit.lowercase() in listOf("sat","sats")) formatAmount(payment.amount,payment.mint,payment.testOnly||payment.mint.trimEnd('/')=="https://testnut.cashu.space") else payment.displayAmount
    val clipboard = LocalClipboardManager.current
    var copied by remember(payment.token) { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(2500); copied = false } }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Filled.AccountBalanceWallet, "Payment", Modifier.size(25.dp))
        Text(displayAmount, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        if(displayAmount!=payment.displayAmount)Text(payment.displayAmount,style=MaterialTheme.typography.bodySmall)
        Text(payment.mintLabel, style = MaterialTheme.typography.bodySmall)
        Text("Verify and redeem in your wallet.", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick={openWallet(payment.token)}) { Text("Open in wallet") }
        TextButton(onClick = { clipboard.setText(AnnotatedString(payment.token)); copied = true }, colors = ButtonDefaults.textButtonColors(contentColor = if (mine) OnInk else Ink)) {
            Icon(Icons.Filled.ContentCopy, null, Modifier.size(16.dp)); Spacer(Modifier.width(7.dp)); Text(if (copied) "Copied" else "Copy token")
        }
    }
}
