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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun handoffQRValue(raw: String): String? = raw.takeIf {
    it.length in 16..220 && it.startsWith("iris-handoff:1:") && it.all { c -> c.code in 33..126 }
}

internal fun handoffQRModules(pass: String): List<List<Boolean>> {
    require(handoffQRValue(pass) != null)
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
        if (handoff.action == "show") HandoffCodeDialog(handoff, show) { active = null }
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

@Composable private fun HandoffCodeDialog(handoff: OrderHandoff, show: suspend (String) -> String, close: () -> Unit) {
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
            val grid = withContext(Dispatchers.Default) { handoffQRModules(show(handoff.kind)) }
            if (SystemClock.elapsedRealtime() < deadline) {
                modules = grid
                loading = false
                delay((deadline - SystemClock.elapsedRealtime()).coerceAtLeast(0))
            }
            modules = null
            message = "This code has expired."
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { message = "Couldn’t create the code. Try again." }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = close, properties = DialogProperties(securePolicy = SecureFlagPolicy.SecureOn),
        title = { Text("${handoff.label.replaceFirstChar(Char::uppercaseChar)} code") },
        text = {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (loading) CircularProgressIndicator()
                modules?.let {
                    MarketQr(it, "${handoff.label} handoff QR code")
                    Text("Show this code in person. It’s valid for two minutes and can be checked offline.")
                }
                if (message.isNotBlank()) Text(message)
            }
        },
        confirmButton = { TextButton(onClick = close) { Text("Done") } },
        dismissButton = { TextButton(enabled = !loading, onClick = { attempt++ }) { Text("Get a fresh code") } })
}
