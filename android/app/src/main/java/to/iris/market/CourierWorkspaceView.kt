package to.iris.market

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable fun CourierWorkspaceView(state: MarketSnapshot, model: MarketModel, openListing: (Listing) -> Unit, openOrder: (String) -> Unit, announce: (NativeTransportType, String, String?) -> Unit, close: () -> Unit) {
    var section by remember { mutableStateOf("work") }
    var type by remember { mutableStateOf(NativeTransportType.PARCEL) }
    var area by remember { mutableStateOf("") }
    var serviceAreas by remember { mutableStateOf<String?>(null) }
    var chooseServiceAreas by remember { mutableStateOf(false) }
    var appliedArea by remember { mutableStateOf("") }
    val previousFilter = remember { Triple(state.query, state.side, state.aiSearch) }
    LaunchedEffect(section) { if (section != "jobs") model.filter("", if (section == "service") "offer" else "request") }
    DisposableEffect(Unit) { onDispose { model.filter(previousFilter.first, previousFilter.second, previousFilter.third) } }
    val jobs = state.orders.filter { !it.archived && it.handlesDelivery(state.publicKey) }.sortedWith(compareBy<MarketOrder> { it.terminal }.thenByDescending { it.updatedAt })
    val listings = state.listings.filter { listing ->
        listing.status == "active" && (listing.expiresAt == null || listing.expiresAt > System.currentTimeMillis()/1000) && type.includes(listing.tags) &&
            (if (section == "service") listing.side == "offer" && listing.author == state.publicKey else listing.side == "request" && listing.author != state.publicKey) &&
            (appliedArea.isBlank() || listing.location.contains(appliedArea, ignoreCase = true))
    }
    if (chooseServiceAreas) ServiceAreaEditor(serviceAreas, { serviceAreas = it }, { chooseServiceAreas = false })
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Transport", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = close) { Text("Done") }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("work" to "Find work", "jobs" to "My jobs", "service" to "My service").forEach { (value, label) ->
                FilterChip(section == value, { section = value }, label = { Text(label) }, shape = CircleShape, modifier = Modifier.testTag("transport-$value"))
            }
        }
        if (section == "jobs") {
            Text("${jobs.count { !it.terminal }} active · ${jobs.count { it.status == "delivered" }} completed", color = Muted)
            if (jobs.isEmpty()) Text("No jobs yet. Agree on work through a private enquiry. Assigned delivery stops appear here.", color = Muted)
            jobs.forEach { job ->
                Surface(color = White, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth().clickable { openOrder(job.id) }) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(job.title, fontWeight = FontWeight.SemiBold)
                        Text(job.statusLabel, style = MaterialTheme.typography.labelMedium, color = Forest)
                        if (!job.terminal) job.shipment.stops.firstOrNull { it.status != "completed" && (job.seller == state.publicKey || it.courierPubkey == state.publicKey) }?.let { next ->
                            Text(next.label.ifBlank { "Next stop" }, fontWeight = FontWeight.Medium)
                            if (next.address.isNotBlank()) Text(next.address, color = Muted)
                            job.shipment.eta?.let { Text("Expected ${orderDate(it)}", color = Muted, style = MaterialTheme.typography.bodySmall) }
                        }
                        if (job.sync == "queued") Text("Waiting to send", color = Muted)
                        Text("Open job", color = Forest, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { NativeTransportType.entries.forEach { choice -> FilterChip(type == choice, { type = choice }, label = { Text(choice.label) }, shape = CircleShape) } }
            MarketField(area, { area = it.take(160) }, "City or area")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { appliedArea = area.trim() }) { Text("Apply") }
                TextButton(onClick = { model.command(org.json.JSONObject().put("type", "refresh")) }) { Text("Refresh") }
            }
            if (section == "service") {
                OutlinedButton(onClick = { chooseServiceAreas = true }, enabled = !state.demo, modifier = Modifier.fillMaxWidth().testTag("chooseTransportServiceAreas")) { Icon(Icons.Filled.Map, null); Spacer(Modifier.width(8.dp)); Text(if(serviceAreas == null) "Choose service areas" else "Edit service areas") }
                Button(onClick = { announce(type, area.trim(), serviceAreas) }, modifier = Modifier.fillMaxWidth().testTag("announceTransport")) { Icon(Icons.Filled.Add, null); Spacer(Modifier.width(8.dp)); Text("Announce your service") }
                Text("Create a public listing with your service area, rates and availability. Exact routes stay in private orders.", color = Muted, style = MaterialTheme.typography.bodySmall)
            } else Text("Public requests · agree on the route and price privately before taking a job.", color = Muted, style = MaterialTheme.typography.bodySmall)
            if (listings.isEmpty()) Text(if (section == "service") "No service listings. Tell people where and when you can help." else "No matching requests. Try another area or service type.", color = Muted)
            listings.forEach { listing ->
                Surface(color = White, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth().clickable { openListing(listing) }) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(listing.title, fontWeight = FontWeight.SemiBold)
                        Text(listing.location.ifBlank { "Area not specified" }, color = Muted)
                        Text(listing.displayPrice, style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
        }
        if (state.demo) Text("Preview stays offline. Sample jobs are not real work.", color = Muted, style = MaterialTheme.typography.bodySmall)
    }
}
