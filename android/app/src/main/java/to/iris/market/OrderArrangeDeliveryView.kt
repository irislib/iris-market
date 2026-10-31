package to.iris.market

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable fun OrderArrangeDeliveryView(order:MarketOrder,state:MarketSnapshot,model:MarketModel,busy:Boolean,booked:(String)->Unit,close:()->Unit) {
    var destination by remember(order.id){mutableStateOf(OrderDeliveryPlace("Destination"))}
    var selected by remember(order.id){mutableStateOf<String?>(null)}
    var error by remember{mutableStateOf<String?>(null)}
    val prior=remember{Triple(state.query,state.side,state.aiSearch)}
    val services=state.listings.filter {it.side=="offer"&&it.status=="active"&&it.author!=order.seller&&it.author!=state.publicKey&&(it.expiresAt==null||it.expiresAt>System.currentTimeMillis()/1000)&&NativeTransportType.PARCEL.includes(it.tags)}
    LaunchedEffect(Unit){model.filter("","offer")}
    DisposableEffect(Unit){onDispose{model.filter(prior.first,prior.second,prior.third)}}
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(24.dp),verticalArrangement=Arrangement.spacedBy(18.dp)) {
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text("Arrange delivery",style=MaterialTheme.typography.titleLarge);TextButton(onClick=close){Text("Cancel")}}
        order.shipment.stops.firstOrNull()?.let {pickup->Text("Pickup",style=MaterialTheme.typography.titleMedium);Text(pickup.address);if(pickup.coordinates!=null)ShipmentMapView(Shipment(listOf(pickup.copy(courierPubkey=null)),null,null,null),Modifier.fillMaxWidth().height(180.dp))}
        PrivateDeliveryPlaceField(destination,{destination=it})
        Text("Choose a delivery service",style=MaterialTheme.typography.titleMedium)
        if(services.isEmpty()){Text("Looking for delivery services…",style=MaterialTheme.typography.bodySmall);TextButton(onClick={model.command(JSONObject().put("type","refresh"))}){Text("Refresh services")}}
        services.forEach {service->OutlinedButton(onClick={selected=service.id},modifier=Modifier.fillMaxWidth()) {Column(Modifier.weight(1f)){Text(service.title);Text(service.displayPrice,style=MaterialTheme.typography.bodySmall)};RadioButton(selected==service.id,onClick={selected=service.id})}}
        Text("Only the delivery provider receives your destination. The merchant receives the courier’s identity and pickup reference.",style=MaterialTheme.typography.bodySmall,color=Muted)
        error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
        Button(enabled=!busy&&services.any {it.id==selected}&&destination.address.isNotBlank(),onClick={
            val service=services.firstOrNull {it.id==selected}?:return@Button
            runCatching {
                val existing=state.orders.map {it.id}.toSet()
                val request=JSONObject().put("type","request_delivery").put("source_order_id",order.id).put("listing_id",service.id).put("destination",destination.json())
                model.orderCommand(request,onSuccess={model.state.value.orders.firstOrNull {it.id !in existing&&it.buyer==state.publicKey}?.id?.let(booked)?:close()},onError={error=it})
            }.onFailure {error=it.message?:"Enter a destination."}
        },modifier=Modifier.fillMaxWidth()){Text("Request delivery")}
    }
}
