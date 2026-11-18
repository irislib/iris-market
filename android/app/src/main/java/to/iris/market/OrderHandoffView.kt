package to.iris.market

import android.os.SystemClock
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import org.json.JSONObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun handoffQRValue(raw: String): String? = raw.takeIf {
    it.length in 16..220 && (it.startsWith("iris-handoff:1:") || it.startsWith("iris-handoff:2:pickup:")) && it.all { c -> c.code in 33..126 }
}

internal fun receiptQRValue(raw: String): String? = raw.takeIf {
    it.length <= 384 && it.startsWith("iris-pickup-receipt:1:") && it.all { c -> c.code in 33..126 }
}

internal fun handoffQRModules(pass: String): List<List<Boolean>> {
    require(handoffQRValue(pass) != null || receiptQRValue(pass) != null)
    val qr = QRCodeWriter().encode(pass, BarcodeFormat.QR_CODE, 1, 1, mapOf(EncodeHintType.MARGIN to 0))
    return List(qr.height) { y -> List(qr.width) { x -> qr[x, y] } }
}

@Composable internal fun OrderHandoffActions(handoffs: List<OrderHandoff>, busy: Boolean,
    show: suspend (String) -> String, verify: suspend (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    var active by remember { mutableStateOf<OrderHandoff?>(null) }
    var checking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(handoffs) { if (active !in handoffs) active = null }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        handoffs.forEach { handoff ->
            if (handoff.action == "checked") {
                Text("${handoff.label.replaceFirstChar(Char::uppercaseChar)} code checked on this device.", style = MaterialTheme.typography.bodyMedium)
            } else {
                OutlinedButton(enabled = !busy && !checking, onClick = { error = null; active = handoff }) {
                    Text(if (handoff.action == "show") "Show ${handoff.label} code" else "Scan ${handoff.label} code")
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
    active?.takeIf { it in handoffs }?.let { handoff ->
        if (handoff.action == "show") HandoffCodeDialog("${handoff.label.replaceFirstChar(Char::uppercaseChar)} code", "${handoff.label} handoff QR code", show = { show(handoff.kind) }) { active = null }
        else LocalQRScannerDialog("Scan ${handoff.label} code", "Scan a handoff code for this order.",
            "Allow camera access to scan the code.", ::handoffQRValue, { pass ->
                checking = true
                scope.launch {
                    try { verify(handoff.kind, pass) }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) { error = "Couldn’t verify this ${handoff.label} code. Ask for a fresh code and scan again." }
                    finally { checking = false }
                }
            }, { active = null })
    }
}

@Composable private fun HandoffCodeDialog(title: String, imageLabel: String, permanent: Boolean = false, show: suspend () -> String, close: () -> Unit) {
    var attempt by remember { mutableIntStateOf(0) }
    var modules by remember { mutableStateOf<List<List<Boolean>>?>(null) }
    var message by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val dismiss by rememberUpdatedState(close)
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) dismiss() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(attempt) {
        val deadline = SystemClock.elapsedRealtime() + 120_000
        loading = true
        modules = null
        message = ""
        try {
            val grid = withContext(Dispatchers.Default) { handoffQRModules(show()) }
            if (permanent || SystemClock.elapsedRealtime() < deadline) {
                modules = grid
                loading = false
                if (permanent) return@LaunchedEffect
                delay((deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0))
            }
            modules = null
            message = "This code has expired."
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { message = "Couldn’t create the code. Try again." }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = close, properties = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn),
        title = { Text(title) },
        text = {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (loading) CircularProgressIndicator()
                modules?.let {
                    MarketQr(it, imageLabel)
                    Text(if (permanent) "Share this receipt only with someone involved in this pickup." else "Show this code in person. It’s valid for two minutes and can be checked offline.")
                }
                if (message.isNotBlank()) Text(message)
            }
        },
        confirmButton = { TextButton(onClick = close) { Text("Done") } },
        dismissButton = { if (!permanent || modules == null) TextButton(enabled = !loading, onClick = { attempt++ }) { Text(if (permanent) "Try again" else "Get a fresh code") } })
}

private enum class PickupDialog {
    Acknowledge, Confirm, Authorization, Acknowledgment, ScanPickup, Receipt, ScanReceipt
}

@Composable internal fun PickupReceiptSection(order: MarketOrder, busy: Boolean, execute: suspend (JSONObject) -> String?) {
    val role = order.pickupReceiptRole
    val receipt = order.pickupReceipt
    val active = order.status == "accepted" || order.status == "in-transit"
    val scope = rememberCoroutineScope()
    var dialog by remember(role, active) { mutableStateOf<PickupDialog?>(null) }
    var working by remember { mutableStateOf(false) }
    var receiveOffline by remember(role) { mutableStateOf(false) }
    val signedAt = receipt?.collectedAt
    val fresh by produceState(true, signedAt, receipt?.state) {
        value = true
        if (signedAt != null && receipt.state != "confirmed") {
            val remaining = (signedAt + 121) * 1000 - System.currentTimeMillis()
            if (remaining > 0) delay(remaining)
            value = false
        }
    }
    var error by remember { mutableStateOf<String?>(null) }
    val enabled = !busy && !working
    fun open(next: PickupDialog) { error = null; dialog = next }
    fun submit(request: JSONObject, fallback: String) {
        if (working) return
        working = true
        scope.launch {
            try { execute(request) }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.localizedMessage?.takeIf { it.isNotBlank() } ?: fallback }
            finally { working = false }
        }
    }
    LaunchedEffect(role, receipt?.state) {
        if (receipt?.state == "confirmed" && dialog != PickupDialog.Receipt) dialog = null
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Pickup receipt", style = MaterialTheme.typography.titleMedium)
        receipt?.let {
            Text("Collector acknowledged · ${orderDate(it.collectedAt)}")
            if (it.state == "confirmed") {
                it.confirmedAt?.let { time -> Text("Merchant confirmed · ${orderDate(time)}") }
                OutlinedButton(enabled = enabled, onClick = { open(PickupDialog.Receipt) }) { Text("Show receipt QR") }
            } else if (fresh && role != "merchant") {
                Text("Waiting for merchant confirmation.", color = Muted)
            }
        }
        if (receipt?.state != "confirmed") {
            when {
                role == "collector" && active && (receipt == null || !fresh) -> {
                    if (!fresh) Text("The acknowledgment expired before confirmation.", color = Muted)
                    Button(enabled = enabled, onClick = { open(PickupDialog.Acknowledge) }) { Text(if (receipt == null) "Acknowledge collection" else "Renew acknowledgment") }
                }
                role == "collector" && active && receipt?.state == "acknowledged" -> {
                    OutlinedButton(enabled = enabled, onClick = { open(PickupDialog.Acknowledgment) }) { Text("Show acknowledgment QR") }
                }
                role == "merchant" && active -> {
                    if (receipt?.state == "awaiting-confirmation") {
                        if (fresh) {
                            Button(enabled = enabled, onClick = { open(PickupDialog.Confirm) }) { Text("Confirm handover") }
                        } else {
                            Text("Ask the collector to show a fresh acknowledgment QR.", color = Muted)
                        }
                    } else if (receipt == null) {
                        if (OrderHandoff("pickup", "checked") in order.handoffs) Text("Pickup authorization checked on this device.")
                        Text("Scan the collector’s code or wait for their private acknowledgment.", color = Muted)
                    }
                    OutlinedButton(enabled = enabled, onClick = { open(PickupDialog.ScanPickup) }) { Text("Scan pickup code") }
                }
                receipt == null -> Text(if (active) "The signed receipt will appear here after pickup." else "No pickup receipt recorded.", color = Muted)
            }
            if (role == "collector" || role == "observer") {
                if (receipt == null) {
                    TextButton(onClick = { receiveOffline = !receiveOffline }) { Text(if (role == "collector" && active) "Offline pickup options" else "Receive receipt offline") }
                    if (receiveOffline && role == "collector" && active && OrderHandoff("pickup", "show") in order.handoffs) {
                        OutlinedButton(enabled = enabled, onClick = { open(PickupDialog.Authorization) }) { Text("Show authorization code") }
                    }
                }
                if (receipt != null || receiveOffline) {
                    OutlinedButton(enabled = enabled, onClick = { open(PickupDialog.ScanReceipt) }) { Text("Scan returned receipt") }
                }
            }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }

    when (dialog) {
        PickupDialog.Acknowledge, PickupDialog.Confirm -> {
            val collecting = dialog == PickupDialog.Acknowledge
            AlertDialog(onDismissRequest = { dialog = null },
                title = { Text(if (collecting) "Have you collected the item?" else "Have you handed over the item?") },
                text = { Text(if (collecting) "Your acknowledgment will be shared privately with the merchant when connected." else "Both acknowledgments will be saved on the pickup receipt and shared privately when connected.") },
                confirmButton = {
                    TextButton(enabled = enabled, onClick = {
                        dialog = null
                        submit(JSONObject().put("type", if (collecting) "acknowledge_order_pickup" else "confirm_order_pickup"), "Couldn’t save the pickup receipt.")
                    }) { Text(if (collecting) "I collected the item" else "I handed it over") }
                }, dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        }
        PickupDialog.Receipt, PickupDialog.Acknowledgment, PickupDialog.Authorization -> {
            val completed = dialog == PickupDialog.Receipt
            val authorization = dialog == PickupDialog.Authorization
            val title = when {
                completed -> "Pickup receipt"
                authorization -> "Pickup authorization"
                else -> "Pickup acknowledgment"
            }
            HandoffCodeDialog(title, "$title QR code", permanent = completed, show = {
                val request = when {
                    completed -> JSONObject().put("type", "show_pickup_receipt")
                    authorization -> JSONObject().put("type", "show_order_handoff").put("kind", "pickup")
                    else -> JSONObject().put("type", "acknowledge_order_pickup")
                }
                requireNotNull(execute(request))
            }) { dialog = null }
        }
        PickupDialog.ScanPickup, PickupDialog.ScanReceipt -> {
            val completed = dialog == PickupDialog.ScanReceipt
            LocalQRScannerDialog(if (completed) "Scan returned receipt" else "Scan pickup code",
                if (completed) "Scan the completed pickup receipt." else "Scan a pickup code for this order.",
                "Allow camera access to scan the code.", if (completed) ::receiptQRValue else ::handoffQRValue, { code ->
                    val request = if (completed) JSONObject().put("type", "verify_pickup_receipt").put("receipt", code)
                        else JSONObject().put("type", "verify_order_handoff").put("kind", "pickup").put("pass", code)
                    submit(request, "Couldn’t verify the code for this order.")
                }, { dialog = null })
        }
        null -> Unit
    }
}

@Composable internal fun PreviousPickupReceipts(receipts: List<PreviousPickupReceipt>, busy: Boolean, show: suspend (String) -> String) {
    var expanded by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<PreviousPickupReceipt?>(null) }
    TextButton(onClick = { expanded = !expanded }) { Text("Earlier pickup receipts") }
    if (expanded) receipts.forEach { earlier ->
        Text("Collector acknowledged · ${orderDate(earlier.collectedAt)}")
        Text("Merchant confirmed · ${orderDate(earlier.confirmedAt)}")
        OutlinedButton(enabled = !busy, onClick = { selected = earlier }) { Text("Show earlier receipt QR") }
    }
    selected?.takeIf { it in receipts }?.let { earlier ->
        HandoffCodeDialog("Earlier pickup receipt", "Earlier pickup receipt QR code", permanent = true, show = { show(earlier.reference) }) { selected = null }
    }
}
