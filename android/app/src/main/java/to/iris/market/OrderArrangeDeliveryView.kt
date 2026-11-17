package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable fun OrderArrangeDeliveryView(order: MarketOrder, state: MarketSnapshot, model: MarketModel, busy: Boolean,
    booked: (String) -> Unit, close: () -> Unit) {
    val merchantBooks = order.seller == state.publicKey
    val merchantStop = order.shipment.stops.firstOrNull()
    var pickup by remember(order.id) { mutableStateOf(OrderDeliveryPlace("Pickup")) }
    var destination by remember(order.id) { mutableStateOf(OrderDeliveryPlace("Destination")) }
    var selected by remember(order.id) { mutableStateOf<String?>(null) }
    var confirming by remember(order.id) { mutableStateOf(false) }
    var error by remember(order.id) { mutableStateOf<String?>(null) }
    val prior = remember { Triple(state.query, state.side, state.aiSearch) }
    val now = System.currentTimeMillis() / 1000
    val services = state.listings.filter { it.side == "offer" && it.status == "active" && it.author != order.seller && it.author != order.buyer &&
        (it.expiresAt == null || it.expiresAt > now) && NativeTransportType.PARCEL.includes(it.tags) }
    val service = services.firstOrNull { it.id == selected }
    LaunchedEffect(Unit) { model.filter("", "offer") }
    DisposableEffect(Unit) { onDispose { model.filter(prior.first, prior.second, prior.third) } }
    LaunchedEffect(service?.id) { if (service == null) confirming = false }

    if (confirming && service != null) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text("Send this delivery request?") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(service.title + " · " + service.displayPrice, style = MaterialTheme.typography.titleMedium)
            val courier = state.people[service.author] ?: PublicPerson.unnamed(service.author)
            Text("Courier · " + courier.displayName)
            Text("Pickup · " + if (merchantBooks) pickup.address else merchantStop?.address.orEmpty())
            Text("Destination · " + destination.address)
            Text("The courier receives these places, the merchant’s profile and a pickup reference. You pay the courier separately if the request is accepted.")
        } },
        confirmButton = { TextButton(enabled = !busy && order.canBookCourier(state.publicKey), onClick = {
            confirming = false
            error = null
            runCatching {
                val request = JSONObject().put("type", "request_delivery").put("source_order_id", order.id)
                    .put("listing_id", service.id).put("destination", destination.json())
                if (merchantBooks) request.put("pickup", pickup.json())
                model.orderCommand(request, onSuccess = {
                    model.state.value.orders.firstOrNull { it.id == order.id }?.deliveryOrderId?.let(booked) ?: close()
                }, onError = { error = it })
            }.onFailure { error = it.message ?: "Check the pickup and destination." }
        }) { Text("Request delivery") } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("Go back") } }
    )

    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Arrange delivery", style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = close) { Text("Cancel") }
        }
        if (merchantBooks) {
            Text("Agree on the destination with the buyer in your private order chat.")
            PrivateDeliveryPlaceField(pickup, { pickup = it })
        } else merchantStop?.let { stop ->
            Text("Pickup", style = MaterialTheme.typography.titleMedium)
            Text(stop.address)
            if (stop.coordinates != null) ShipmentMapView(Shipment(listOf(stop.copy(courierPubkey = null)), null, null, null), Modifier.fillMaxWidth().height(180.dp))
        }
        PrivateDeliveryPlaceField(destination, { destination = it })
        Text("Choose a delivery service", style = MaterialTheme.typography.titleMedium)
        if (services.isEmpty()) {
            Text("No parcel services available here yet.", style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { model.command(JSONObject().put("type", "refresh")) }) { Text("Refresh services") }
        }
        services.forEach { choice ->
            OutlinedButton(onClick = { selected = choice.id }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) { Text(choice.title); Text(choice.displayPrice, style = MaterialTheme.typography.bodySmall) }
                RadioButton(selected = choice.id == selected, onClick = null)
            }
        }
        if (!merchantBooks) Text("Only the delivery provider receives your destination. The merchant receives the courier’s identity and pickup reference.", style = MaterialTheme.typography.bodySmall, color = Muted)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy && service != null && destination.address.isNotBlank() && (!merchantBooks || pickup.address.isNotBlank()),
            onClick = { confirming = true }, modifier = Modifier.fillMaxWidth()) { Text("Review delivery request") }
    }
}
