package to.iris.market

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

private data class BasketEscrowReview(val line: BasketLine, val note: String, val fulfillment: OrderFulfillment)

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun OrdersView(state: MarketSnapshot, model:MarketModel, busy:Boolean, openOrder: (String) -> Unit) {
    // Open on the list holding the latest activity, so a new sale is not hidden behind an empty Purchases list.
    // A waiting basket keeps Purchases open.
    var tab by remember { mutableStateOf(if (state.basket.isNotEmpty()) "purchases" else state.orders.filter { !it.archived }.maxByOrNull { it.updatedAt }?.let { latest ->
        when { latest.buyer == state.publicKey -> "purchases"; latest.seller == state.publicKey -> "sales"; latest.handlesDelivery(state.publicKey) -> "deliveries"; else -> null }
    } ?: "purchases") }
    val escrowEnabled=JSONObject(state.settings).optBoolean("escrow_ui") && !state.demo
    val showJobs=escrowEnabled || (!state.demo && state.escrowInvites.any {it.joined && it.participants[2]==state.publicKey})
    var offerService by remember {mutableStateOf(false)}
    LaunchedEffect(showJobs){if(!showJobs && tab=="jobs")tab="purchases"}
    if(offerService && escrowEnabled){PostListing(state,model,busy,providerService=true){offerService=false};return}
    var period by remember { mutableStateOf(OrderPeriod.ALL) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val sectionOrders = state.orders.filter { order ->
        if (tab == "archived") order.archived else !order.archived && when(tab) {
            "sales" -> order.seller == state.publicKey
            "deliveries" -> order.handlesDelivery(state.publicKey)
            else -> order.buyer == state.publicKey
        }
    }.sortedByDescending { it.updatedAt }
    val historyTab = tab in setOf("purchases", "sales", "archived")
    val orders = if (historyTab) sectionOrders.filter { period.includes(it.createdAt) } else sectionOrders
    val basketShown = tab == "purchases" && state.basket.isNotEmpty()
    var checkoutSeller by remember { mutableStateOf<String?>(null) }
    var basketEscrow by remember { mutableStateOf<BasketEscrowReview?>(null) }
    val escrowReview = basketEscrow
    if (escrowReview != null) {
        // The core consumes the ordered basket line before the provider invitation is sent.
        // Keep the review alive until the escrow flow closes, even if the basket is now empty.
        ModalBottomSheet(onDismissRequest = { basketEscrow = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Cream) {
            OrderReview(escrowReview.line.listing, state, model, busy, escrowReview.line, escrowReview.note, escrowReview.fulfillment) { id ->
                basketEscrow = null
                if (id != null) { checkoutSeller = null; openOrder(id) }
            }
        }
    } else checkoutSeller?.let { seller ->
        val currentGroup = state.basket.firstOrNull { it.seller == seller }
        LaunchedEffect(seller, currentGroup == null) { if (currentGroup == null) checkoutSeller = null }
        currentGroup?.let { group ->
            BasketCheckout(group, state, model, busy, close = { checkoutSeller = null }, escrow = { basketEscrow = it }) { id ->
                checkoutSeller = null
                if (id != null) openOrder(id)
            }
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 22.dp)) {
        Text("Orders", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 15.dp, bottom = 10.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            (listOf("purchases" to "Purchases", "sales" to "Sales", "deliveries" to "Deliveries") + listOfNotNull(("jobs" to "Escrow jobs").takeIf {showJobs}, "archived" to "Archived")).forEach { (key, label) ->
                FilterChip(selected = tab == key, onClick = { tab = key }, label = { Text(label) }, shape = CircleShape)
            }
        }
        if (historyTab && sectionOrders.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(top = 10.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OrderPeriod.entries.forEach { value -> FilterChip(selected = period == value, onClick = { period = value }, label = { Text(value.label) }) }
                TextButton(enabled = orders.isNotEmpty(), onClick = {
                    val csv = OrderHistory.csv(orders, state.publicKey) { key -> state.people[key]?.name ?: "" }
                    context.startActivity(android.content.Intent.createChooser(android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/csv").putExtra(android.content.Intent.EXTRA_SUBJECT, "Iris Market $tab").putExtra(android.content.Intent.EXTRA_TEXT, csv), "Export CSV"))
                }) { Text("Export CSV") }
            }
            Text(OrderHistory.summary(orders), color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        if(tab=="jobs" && showJobs) {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(vertical=14.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                EscrowCardsView(state,model,jobsOnly=true)
                if(escrowEnabled) {
                    OutlinedButton(enabled=state.canSign && !busy,onClick={offerService=true}){Text("Offer escrow services")}
                    if(!state.canSign) Text("Use the device holding your profile key to offer escrow services.",style=MaterialTheme.typography.bodySmall,color=Muted)
                }
            }
        } else if (orders.isEmpty() && sectionOrders.isNotEmpty() && !basketShown) EmptyView("No orders in this period", "Choose another period to see earlier orders.", Icons.Filled.CalendarMonth)
        else if (orders.isEmpty() && !basketShown) EmptyView(when(tab) { "sales" -> "No sales yet"; "deliveries" -> "No deliveries yet"; "archived" -> "Nothing archived"; else -> "No purchases yet" },
            when(tab) { "sales" -> "Order requests for your listings appear here."; "deliveries" -> "Deliveries you handle appear here."; "archived" -> "Finished orders can be kept here."; else -> "Your orders appear here." }, Icons.Filled.ReceiptLong)
        else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp)) {
            if (basketShown) item(key = "basket") { BasketSection(state, model, busy) { checkoutSeller = it } }
            items(orders, key = { it.id }) { order ->
                Surface(color = White, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth().clickable { openOrder(order.id) }) {
                    Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            order.displayImage?.let { OrderThumb(it) }
                            Text(order.title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                            Text(order.formattedPrice, fontWeight = FontWeight.Medium)
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(orderDate(order.createdAt), color = Muted, style = MaterialTheme.typography.bodySmall)
                            Text(order.statusLabel, style = MaterialTheme.typography.labelMedium)
                        }
                        if (order.sync == "queued") Text("Waiting to send", color = Muted, style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

/** The basket on Purchases: one card per seller, each requested as one order. */
@Composable private fun BasketSection(state: MarketSnapshot, model: MarketModel, busy: Boolean, checkout: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Basket", style = MaterialTheme.typography.titleLarge)
        state.basket.forEach { group ->
            Surface(color = White, shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    UserRow(state.people[group.seller] ?: PublicPerson.unnamed(group.seller), "Seller")
                    group.items.forEach { line ->
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(Modifier.fillMaxWidth()) { Text(line.listing.title, Modifier.weight(1f), fontWeight = FontWeight.Medium, maxLines = 2); Text(line.formattedTotal) }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                val quantity = { value: Int -> model.command(JSONObject().put("type", "set_basket_quantity").put("id", line.listing.id).put("quantity", value.coerceIn(0, 999))) }
                                OutlinedIconButton(enabled = !busy, onClick = { quantity(line.quantity - 1) }) { Icon(if (line.quantity == 1) Icons.Filled.Delete else Icons.Filled.Remove, if (line.quantity == 1) "Remove ${line.listing.title}" else "One fewer ${line.listing.title}") }
                                Text("${line.quantity}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { contentDescription = "Quantity ${line.quantity}" })
                                OutlinedIconButton(enabled = !busy && line.quantity < 999, onClick = { quantity(line.quantity + 1) }) { Icon(Icons.Filled.Add, "One more ${line.listing.title}") }
                            }
                        }
                    }
                    if (group.items.size > 1) group.total?.let { total -> HorizontalDivider(color = Line); Row(Modifier.fillMaxWidth()) { Text("Total", Modifier.weight(1f), fontWeight = FontWeight.SemiBold); Text(total.formatted, fontWeight = FontWeight.SemiBold) } }
                    Button(enabled = !busy && !state.demo && state.canSign, onClick = { checkout(group.seller) }, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) { Text("Request order") }
                }
            }
        }
    }
}

/** Reviews one seller's basket before it becomes an order request. */
@Composable private fun BasketCheckout(group: BasketGroup, state: MarketSnapshot, model: MarketModel, busy: Boolean, close: () -> Unit, escrow: (BasketEscrowReview) -> Unit, done: (String?) -> Unit) {
    var note by remember(group.seller) { mutableStateOf("") }
    var error by remember(group.seller) { mutableStateOf<String?>(null) }
    var fulfillment by remember(group.seller) { mutableStateOf(OrderFulfillment.MERCHANT_DELIVERY) }
    val goodsOrder = group.items.all { it.listing.isGoodsOffer }
    AlertDialog(onDismissRequest = close, title = { Text(if (group.count == 1) "1 item" else "${group.count} items") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            UserRow(state.people[group.seller] ?: PublicPerson.unnamed(group.seller), "Seller")
            group.items.forEach { line -> Row(Modifier.fillMaxWidth()) { Text("${line.quantity} × ${line.listing.title}", Modifier.weight(1f)); Text(line.formattedTotal) } }
            group.total?.let { total -> Row(Modifier.fillMaxWidth()) { Text("Total", Modifier.weight(1f), fontWeight = FontWeight.SemiBold); Text(total.formatted, fontWeight = FontWeight.SemiBold) } }
            if (goodsOrder) FulfillmentChoice(fulfillment) { fulfillment = it }
            OutlinedTextField(note, { note = it.take(2000) }, label = { Text("Note · optional") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            val eligible = group.items.filter { it.listing.acceptsEscrowOrder }
            if (eligible.isNotEmpty() && group.items.size > 1) Text("Escrow orders cover one listing at a time. Other items stay in your basket.", style = MaterialTheme.typography.bodySmall)
            eligible.forEach { line ->
                TextButton(enabled = !busy && !state.demo, onClick = { escrow(BasketEscrowReview(line, note.trim(), fulfillment)) }) {
                    Text(if (group.items.size == 1) "Use escrow" else "Use escrow for ${line.listing.title}")
                }
            }
            Text("The seller will confirm your order. No payment is taken here.", color = Muted, style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {
        Button(enabled = !busy && !state.demo, onClick = {
            error = null
            val existing = state.orders.map { it.id }.toSet()
            val request = JSONObject().put("type", "request_basket_order").put("seller", group.seller).put("note", note.trim())
            if (goodsOrder) request.put("fulfillment", fulfillment.wire)
            model.orderCommand(request,
                onSuccess = { done(model.state.value.orders.firstOrNull { it.id !in existing && it.buyer == state.publicKey && it.seller == group.seller }?.id) },
                onError = { error = it })
        }) { Text("Request order") }
    }, dismissButton = { TextButton(onClick = close) { Text("Cancel") } })
}

@Composable private fun FulfillmentChoice(selected: OrderFulfillment, choose: (OrderFulfillment) -> Unit) {
    Column {
        Text("How would you like to receive it?", style = MaterialTheme.typography.titleMedium)
        OrderFulfillment.entries.forEach { choice ->
            Row(Modifier.fillMaxWidth().selectable(choice == selected, role = Role.RadioButton, onClick = { choose(choice) })
                .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = choice == selected, onClick = null)
                Spacer(Modifier.width(10.dp))
                Text(choice.label)
            }
        }
    }
}

@Composable fun OrderReview(listing: Listing, state: MarketSnapshot, model: MarketModel, busy: Boolean,
    basketLine: BasketLine? = null, initialNote: String = "", initialFulfillment: OrderFulfillment = OrderFulfillment.MERCHANT_DELIVERY,
    done: (String?) -> Unit) {
    val basketQuantity = basketLine?.quantity
    var quantity by remember(listing.id) { mutableStateOf((basketQuantity ?: 1).toString()) }
    var note by remember(listing.id) { mutableStateOf(initialNote) }
    var fulfillment by remember(listing.id) { mutableStateOf(initialFulfillment) }
    var pickup by remember(listing.id){mutableStateOf(OrderDeliveryPlace("Pickup"))}
    var destination by remember(listing.id){mutableStateOf(OrderDeliveryPlace("Destination"))}
    var error by remember { mutableStateOf<String?>(null) }
    val canUseEscrow = !state.demo && listing.acceptsEscrowOrder
    val escrowEnabled = JSONObject(state.settings).optBoolean("escrow_ui")
    var useEscrow by remember(listing.id) { mutableStateOf(basketQuantity != null) }
    var checkout by remember(listing.id) {mutableStateOf<EscrowCheckout?>(null)}
    var createdOrder by remember(listing.id) {mutableStateOf<String?>(null)}
    checkout?.let { selected ->
        EscrowDialog(model,listing.id,null,selected,orderCreated={createdOrder=it}) {
            checkout=null
            createdOrder?.let(done)
        }
    }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (basketQuantity != null) "Review escrow order" else "Review order", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = { done(null) }) { Text("Cancel") }
        }
        Text(listing.title, style = MaterialTheme.typography.headlineSmall)
        val count = quantity.toIntOrNull() ?: 0
        Text(if (count > 1) "${listing.displayPrice} each" else listing.displayPrice, style = MaterialTheme.typography.titleLarge)
        if (count > 1) {
            val unit = listing.priceDisplay ?: listing.price.toDoubleOrNull()?.let { PriceDisplay(it, listing.currency, false, false) }
            val total = basketLine?.total ?: unit?.copy(amount = unit.amount * count)
            if (total != null && total.amount.isFinite()) Text("Total · ${total.formatted}", style = MaterialTheme.typography.titleMedium)
        }
        UserRow(state.people[listing.author] ?: PublicPerson.unnamed(listing.author))
        if (basketQuantity == null) MarketField(quantity, { quantity = it.filter(Char::isDigit).take(3) }, "Quantity", keyboard = KeyboardType.Number)
        else Text("Quantity · $basketQuantity")
        if (listing.isGoodsOffer) FulfillmentChoice(fulfillment) { fulfillment = it }
        MarketField(note, { note = it.take(2000) }, "Note · optional", lines = 3)
        if(listing.isTransport){PrivateDeliveryPlaceField(pickup,{pickup=it});PrivateDeliveryPlaceField(destination,{destination=it})}
        if(canUseEscrow && basketQuantity == null) Row(Modifier.fillMaxWidth().toggleable(useEscrow, role = Role.Switch) { useEscrow = it }.padding(vertical = 8.dp),verticalAlignment=Alignment.CenterVertically){
            Text("Use escrow",Modifier.weight(1f))
            Switch(checked=useEscrow,onCheckedChange=null)
        }
        Text(if(canUseEscrow && useEscrow)"Choose a provider next. The seller and provider each review your request before anyone pays." else "The seller will confirm your order. No payment is taken here.", color = Muted, style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy && !state.demo && (quantity.toIntOrNull() ?: 0) in 1..999, onClick = {
            error = null
            runCatching {
                val request=JSONObject().put("type", "request_order").put("listing_id", listing.id).put("quantity", quantity.toInt()).put("note", note.trim())
                if (listing.isGoodsOffer) request.put("fulfillment", fulfillment.wire)
                val delivery=if(listing.isTransport)OrderDeliveryRequest(pickup,destination) else null
                delivery?.let {request.put("delivery_request",it.json())}
                if(canUseEscrow && useEscrow){
                    val selected = EscrowCheckout(quantity.toInt(), note.trim(), delivery, fulfillment = fulfillment.takeIf { listing.isGoodsOffer }, consumeBasket = basketQuantity != null)
                    if (escrowEnabled) checkout = selected
                    else model.orderCommand(JSONObject().put("type","set_settings").put("settings",JSONObject(state.settings).put("escrow_ui",true)),
                        onSuccess = { checkout = selected }, onError = { error = it })
                    return@runCatching
                }
                val existing = state.orders.mapTo(mutableSetOf()) { it.id }
                model.orderCommand(request,onSuccess = { done(model.state.value.orders.firstOrNull { order -> order.id !in existing && order.buyer == state.publicKey && order.items.any { it.id == listing.id } }?.id) },onError = { error = it })
            }.onFailure {error=it.message?:"Enter pickup and destination."}
        }, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(16.dp)) {
            Text(if (canUseEscrow && useEscrow) (if (escrowEnabled) "Choose escrow provider" else "Enable escrow and choose provider") else NativeTransportType.classify(listing.tags)?.requestLabel ?: "Request order")
        }
    }
}

@Composable fun OrderDetail(order: MarketOrder, state: MarketSnapshot, model: MarketModel, busy: Boolean, openProfile: (String) -> Unit, openOrder:(String)->Unit={}, close: () -> Unit) {
    var arrangingDelivery by remember(order.id){mutableStateOf(false)}
    var escrowOpen by remember(order.id){mutableStateOf(false)}
    var requestingPayment by remember(order.id){mutableStateOf(false)}
    var confirmingPayment by remember(order.id){mutableStateOf(false)}
    var showingChat by remember(order.id){mutableStateOf(false)}
    var paying by remember(order.id){mutableStateOf(false)}
    var editRoute by remember(order.id) { mutableStateOf(false) }
    var error by remember(order.id) { mutableStateOf<String?>(null) }
    val uri = LocalUriHandler.current
    val seller = order.seller == state.publicKey
    val participant = seller || order.buyer == state.publicKey
    fun update(patch: JSONObject) {
        error = null
        model.orderCommand(JSONObject().put("type", "update_order").put("order_id", order.id).put("patch", patch), onError = { error = it })
    }
    val escrowCard=state.escrowInvites.firstOrNull {it.matches(order)}
    if(escrowOpen && order.escrowTradeId!=null) {
        val item=order.items.first()
        val resume=if(escrowCard==null && order.buyer==state.publicKey)EscrowCheckout(item.quantity,order.note,order.deliveryRequest,order) else null
        EscrowDialog(model,item.id,order.escrowTradeId,resume){escrowOpen=false}
    }
    if(showingChat){val other=if(seller)order.buyer else order.seller;val c=state.conversations.firstOrNull {it.id==other}?:Conversation(other,"Conversation",emptyList());ConversationView(c.copy(messages=c.messages.filter {it.threadKey=="order:"+order.id}),state.people[other]?:PublicPerson.unnamed(other),model,busy,openOrder,context=MessageContext.order(order.id),accountID=state.publicKey,threadKey="order:"+order.id,back={showingChat=false});return}
    if(requestingPayment){OrderPaymentRequestView(order,model,busy){requestingPayment=false};return}
    if(confirmingPayment)AlertDialog(onDismissRequest={confirmingPayment=false},title={Text("Confirm payment received?")},text={Text("Confirm after checking your wallet. This records your confirmation for the buyer.")},confirmButton={TextButton(onClick={confirmingPayment=false;order.payment?.let {update(JSONObject().put("payment",JSONObject().put("mint",it.mint).put("amount",it.amount).put("unit",it.unit).put("status","received")))}}){Text("Confirm received")}},dismissButton={TextButton(onClick={confirmingPayment=false}){Text("Cancel")}})
    if(arrangingDelivery){OrderArrangeDeliveryView(order,state,model,busy,booked={arrangingDelivery=false;openOrder(it)},close={arrangingDelivery=false});return}
    if(paying){OrderPaymentView(order,state,model,close={paying=false});return}
    if (editRoute) { RouteEditor(order, state, model, busy) { editRoute = false }; return }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 30.dp), verticalArrangement = Arrangement.spacedBy(17.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Order", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = close) { Text("Done") }
        }
        Text(order.title, style = MaterialTheme.typography.headlineSmall)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(order.statusLabel, fontWeight = FontWeight.SemiBold)
            Text(orderDate(order.createdAt), color = Muted, style = MaterialTheme.typography.bodySmall)
        }
        // Quantity, unit price and total must stay distinguishable on a single-listing order.
        if (order.items.size == 1) {
            val item = order.items.single()
            if (item.quantity > 1) Text("${item.quantity} × ${item.displayPrice}", style = MaterialTheme.typography.bodyMedium)
            Text(if (item.quantity > 1) "Total · ${order.formattedPrice}" else order.formattedPrice, style = MaterialTheme.typography.titleMedium)
            if (item.quantity == 1 && order.displayPrice != null) Text(item.displayPrice, style = MaterialTheme.typography.bodySmall, color = Muted)
        }
        else {
            order.items.forEach { item -> Row(Modifier.fillMaxWidth()) { Text("${item.quantity} × ${item.title}", Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge); Text(item.lineDisplayPrice, style = MaterialTheme.typography.bodyMedium) } }
            Row(Modifier.fillMaxWidth()) {
                Text("Total", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                Column(horizontalAlignment = Alignment.End) {
                    Text(order.itemsTotal ?: order.formattedPrice, style = MaterialTheme.typography.titleMedium)
                    if (order.itemsTotal != null && order.displayPrice != null && order.itemsTotal != order.formattedPrice) Text("≈ ${order.formattedPrice}", color = Muted, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        val other = if (seller) order.buyer else order.seller
        Row(Modifier.fillMaxWidth().clickable { openProfile(other) }.padding(vertical = 4.dp)) {
            UserRow(state.people[other] ?: PublicPerson.unnamed(other), if (seller) "Buyer" else "Seller")
        }
        if (order.note.isNotBlank()) Text(order.note)
        order.deliveryRequest?.let {request->Text("Requested route",style=MaterialTheme.typography.titleMedium);Text("Pickup · "+request.pickup.address);Text("Destination · "+request.destination.address);request.collection?.let {Text("Pickup reference · "+it.reference,style=MaterialTheme.typography.bodySmall,color=Muted)}}
        order.pickupAuthorization?.let {authorization->Text("Authorized collection",style=MaterialTheme.typography.titleMedium);UserRow(state.people[authorization.courierPubkey]?:PublicPerson.unnamed(authorization.courierPubkey),"Courier");Text("Pickup reference · "+authorization.reference,style=MaterialTheme.typography.bodySmall,color=Muted)}
        if(order.escrowTradeId!=null) {
            if(participant && order.escrowProvider!=null && (JSONObject(state.settings).optBoolean("escrow_ui") || escrowCard?.joined==true)) {
                Text("Escrow provider · "+(state.people[order.escrowProvider]?.name ?: PublicPerson.unnamed(order.escrowProvider).name))
                if(escrowCard!=null) OutlinedButton(onClick={escrowOpen=true}){Text("Open escrow")}
                else if(!seller && !order.terminal) OutlinedButton(onClick={escrowOpen=true}){Text("Finish escrow invitation")}
                else Text(if(order.terminal)"No escrow invitation received." else "Waiting for the buyer’s escrow invitation.",style=MaterialTheme.typography.bodySmall,color=Muted)
            } else if(seller && order.status=="requested") {
                Text("Enable escrow in Settings to review this order’s provider.",style=MaterialTheme.typography.bodySmall,color=Muted)
            }
        } else {
        order.payment?.let {payment->
            Text(if(payment.status=="received")"Payment received" else "Payment requested",style=MaterialTheme.typography.titleMedium)
            val test=payment.mint.trimEnd('/') in setOf("https://testnut.cashu.space","https://nofees.testnut.cashu.space")
            Text(displayWalletAmount(payment.amount,payment.mint,state,testOnly=test),style=MaterialTheme.typography.headlineSmall)
            Text(payment.amount+" "+(if(test)"test sats" else "sats")+" · "+runCatching {java.net.URI(payment.mint).host}.getOrDefault("Mint"),style=MaterialTheme.typography.bodySmall,color=Muted)
            if(test)Text("Test money · no bitcoin value",style=MaterialTheme.typography.bodySmall,color=Muted)
            if(payment.status=="received")Text("Confirmed by seller",style=MaterialTheme.typography.bodySmall,color=Muted)
            else if(order.buyer==state.publicKey&&!order.terminal)Button(enabled=!busy,onClick={paying=true},modifier=Modifier.fillMaxWidth()){Text("Pay order")}
        }
        if(seller&&!order.terminal&&order.payment==null)TextButton(onClick={requestingPayment=true}){Text("Request payment")}
        if(seller&&order.payment?.status=="requested")TextButton(onClick={confirmingPayment=true}){Text("Confirm payment received")}
        }
        if(participant)TextButton(onClick={model.command(JSONObject().put("type","contact").put("author",if(seller)order.buyer else order.seller)){showingChat=true}}){Text("Message")}
        order.deliveryOrderId?.let {TextButton(onClick={openOrder(it)}){Text("Open delivery order")}}
        order.sourceOrderId?.let {TextButton(onClick={openOrder(it)}){Text("Open product order")}}
        val pickup = order.fulfillment == OrderFulfillment.PICKUP.wire
        OrderFulfillment.entries.firstOrNull { it.wire == order.fulfillment }?.let { Text(it.label, style = MaterialTheme.typography.titleMedium) }
        if (order.canBookCourier(state.publicKey)) Button(enabled = !busy, onClick = { arrangingDelivery = true }, modifier = Modifier.fillMaxWidth()) {
            Text(if (seller) "Book a courier" else "Arrange delivery")
        }

        if (order.sync == "queued") Text("Waiting to send", color = Muted, style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (!order.terminal) {
            if (seller && order.status == "requested" && order.escrowTradeId == null) Button(enabled = !busy, onClick = { update(JSONObject().put("status", "accepted")) }, modifier = Modifier.fillMaxWidth()) { Text("Accept order") }
            if (seller && order.status == "accepted" && !pickup) Button(enabled = !busy, onClick = { update(JSONObject().put("status", "in-transit")) }, modifier = Modifier.fillMaxWidth()) { Text("Mark on the way") }
            if (participant && order.status in listOf("accepted", "in-transit")) OutlinedButton(enabled = !busy, onClick = { update(JSONObject().put("status", "delivered")) }, modifier = Modifier.fillMaxWidth()) { Text(if (pickup) "Mark collected" else "Mark delivered") }
        }
        HorizontalDivider(color = Line)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(if (pickup) "Pickup details" else "Delivery", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            if (seller && !order.terminal && order.status != "requested") TextButton(onClick = { editRoute = true }) { Text("Edit route") }
        }
        ArrivalEstimate(order.shipment.eta, order.status)
        if (order.shipment.stops.any { it.coordinates != null }) {
            ShipmentMapView(order.shipment, Modifier.fillMaxWidth().height(240.dp))
            Text("Stops joined directly; not driving directions.", color = Muted, style = MaterialTheme.typography.labelSmall)
        }
        if (order.shipment.stops.isEmpty() && !order.terminal) Text(when {
            pickup -> "Agree on a time and place in your private order chat."
            order.fulfillment == OrderFulfillment.MERCHANT_DELIVERY.wire && !seller -> "The seller will arrange delivery. Share the destination in your private order chat."
            seller && order.status == "requested" -> "Add delivery details after accepting the order."
            seller -> "Add stops or tracking details in Edit route."
            else -> "Delivery details will appear here."
        }, color = Muted)
        order.shipment.stops.forEachIndexed { index, stop ->
            Surface(color = White, shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(if (stop.status == "completed") Icons.Filled.CheckCircle else Icons.Filled.Place, null, tint = Muted)
                        Column(Modifier.weight(1f)) {
                            Text(stop.label.ifBlank { "Stop ${index + 1}" }, fontWeight = FontWeight.SemiBold)
                            if (stop.address.isNotBlank()) Text(stop.address, color = Muted)
                        }
                        Text(when(stop.status) { "completed" -> "Completed"; "arrived" -> "Arrived"; else -> "Upcoming" }, style = MaterialTheme.typography.labelSmall)
                    }
                    stop.courierPubkey?.let { courier -> Row(Modifier.clickable { openProfile(courier) }) { UserRow(state.people[courier] ?: PublicPerson.unnamed(courier), "Courier", 30.dp) } }
                    if (!order.terminal && order.status != "requested" && (seller || stop.courierPubkey == state.publicKey)) {
                        if (stop.status != "completed") {
                            val destination = stop.coordinates?.let { "${it[1]},${it[0]}" } ?: stop.address.trim()
                            if (destination.isNotBlank()) TextButton(onClick = { runCatching { uri.openUri("https://www.google.com/maps/dir/?api=1&destination=${android.net.Uri.encode(destination)}&travelmode=driving") } }) {
                                Icon(Icons.Filled.Directions, null); Spacer(Modifier.width(8.dp)); Text("Navigate to stop")
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (stop.status == "pending") OutlinedButton(enabled = !busy, onClick = { update(JSONObject().put("stopId", stop.id).put("status", "arrived")) }) { Text("Mark arrived") }
                            if (stop.status != "completed") TextButton(enabled = !busy, onClick = { update(JSONObject().put("stopId", stop.id).put("status", "completed")) }) { Text("Complete stop") }
                        }
                    }
                }
            }
        }
        order.shipment.trackingUrl?.takeIf { it.startsWith("https://") }?.let { tracking -> OutlinedButton(onClick = { runCatching { uri.openUri(tracking) } }) { Icon(Icons.Filled.OpenInNew, null); Spacer(Modifier.width(8.dp)); Text("Track delivery") } }
        if (!order.terminal && order.status != "requested" && order.handlesDelivery(state.publicKey)) DeliveryLocationSharing(order, state.publicKey, model, state.liveLocationSupported && !confirmingPayment)
        if (!order.terminal && participant) TextButton(enabled = !busy, onClick = { update(JSONObject().put("status", "cancelled")) }) { Text("Cancel order") }
        if (order.terminal) TextButton(enabled = !busy, onClick = {
            model.orderCommand(JSONObject().put("type", "archive_order").put("order_id", order.id).put("archived", !order.archived), onSuccess = close, onError = { error = it })
        }) { Text(if (order.archived) "Restore order" else "Archive order") }
    }
}

private data class StopDraft(val id: String = UUID.randomUUID().toString(), val label: String = "", val address: String = "", val latitude: String = "", val longitude: String = "", val courier: String = "", val status: String = "pending")
@Composable private fun RouteEditor(order: MarketOrder, state: MarketSnapshot, model: MarketModel, busy: Boolean, done: () -> Unit) {
    var stops by remember(order.id) { mutableStateOf(order.shipment.stops.map { StopDraft(it.id, it.label, it.address, it.coordinates?.get(1)?.toString() ?: "", it.coordinates?.get(0)?.toString() ?: "", it.courierPubkey ?: "", it.status) }) }
    var tracking by remember(order.id) { mutableStateOf(order.shipment.trackingUrl ?: "") }
    val dateFormat = remember { DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm") }
    var eta by remember(order.id) { mutableStateOf(order.shipment.eta?.let { dateFormat.format(LocalDateTime.ofInstant(java.time.Instant.ofEpochSecond(it), ZoneId.systemDefault())) } ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    fun replace(index: Int, value: StopDraft) { stops = stops.toMutableList().also { it[index] = value } }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Delivery route", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = done) { Text("Cancel") }
        }
        stops.forEachIndexed { index, stop -> key(stop.id) {
            Surface(color = White, shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) { Text("Stop ${index + 1}", Modifier.weight(1f), fontWeight = FontWeight.Medium); IconButton(onClick = { stops = stops.filterNot { it.id == stop.id } }) { Icon(Icons.Filled.Close, "Remove stop ${index + 1}") } }
                    MarketField(stop.label, { replace(index, stop.copy(label = it.take(120))) }, "Stop name")
                    MarketField(stop.address, { replace(index, stop.copy(address = it.take(500))) }, "Address", lines = 2)
                    var mapPosition by remember { mutableStateOf(stop.latitude.isNotBlank() || stop.longitude.isNotBlank()) }
                    TextButton(onClick = { mapPosition = !mapPosition }) { Text(if (mapPosition) "Hide map position" else "Add map position") }
                    if (mapPosition) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.weight(1f)) { MarketField(stop.latitude, { replace(index, stop.copy(latitude = it)) }, "Latitude", keyboard = KeyboardType.Decimal) }
                        Box(Modifier.weight(1f)) { MarketField(stop.longitude, { replace(index, stop.copy(longitude = it)) }, "Longitude", keyboard = KeyboardType.Decimal) }
                    }
                    var choose by remember { mutableStateOf(false) }
                    val person = state.people[stop.courier]
                    if (person != null) {
                        UserRow(person, "Courier", 32.dp)
                        TextButton(onClick = { replace(index, stop.copy(courier = "")) }) { Text("Change courier") }
                    } else MarketField(stop.courier, { replace(index, stop.copy(courier = it.trim())) }, "Courier profile · optional", hint = "Paste a public profile")
                    Box {
                        TextButton(onClick = { choose = true }) { Text("Choose a person") }
                        DropdownMenu(expanded = choose, onDismissRequest = { choose = false }) {
                            DropdownMenuItem(text = { Text("I'll handle this stop") }, onClick = { replace(index, stop.copy(courier = state.publicKey)); choose = false })
                            state.people.values.filter { it.author != state.publicKey }.take(80).forEach { candidate -> DropdownMenuItem(text = { UserRow(candidate, size = 28.dp) }, onClick = { replace(index, stop.copy(courier = candidate.author)); choose = false }) }
                        }
                    }
                }
            }
        } }
        if (stops.size < 12) OutlinedButton(onClick = { stops = stops + StopDraft() }) { Icon(Icons.Filled.Add, null); Spacer(Modifier.width(7.dp)); Text("Add stop") }
        MarketField(tracking, { tracking = it }, "Tracking link · optional", keyboard = KeyboardType.Uri)
        MarketField(eta, { eta = it }, "Expected arrival · optional", hint = "YYYY-MM-DD HH:mm")
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy, modifier = Modifier.fillMaxWidth(), onClick = {
            try {
                val route = JSONObject().put("stops", JSONArray().apply { stops.forEach { stop ->
                    val point = if (stop.latitude.isBlank() && stop.longitude.isBlank()) null else {
                        val lat = stop.latitude.toDoubleOrNull(); val lon = stop.longitude.toDoubleOrNull()
                        require(lat != null && lon != null && lat.isFinite() && lon.isFinite() && lat in -90.0..90.0 && lon in -180.0..180.0) { "Enter a valid latitude and longitude for each mapped stop." }
                        listOf(lon, lat)
                    }
                    put(DeliveryStop(stop.id, stop.label.trim(), stop.address.trim(), point, stop.courier.trim().ifBlank { null }, stop.status).json())
                } })
                if (tracking.isNotBlank()) {
                    val address = java.net.URI(tracking.trim())
                    require(address.scheme == "https" && address.host != null && address.userInfo == null) { "Use a secure tracking link." }
                    route.put("trackingUrl", address.toString())
                }
                if (eta.isNotBlank()) route.put("eta", LocalDateTime.parse(eta.trim(), dateFormat).atZone(ZoneId.systemDefault()).toEpochSecond())
                error = null
                model.orderCommand(JSONObject().put("type", "update_order").put("order_id", order.id).put("patch", JSONObject().put("shipment", route)), onSuccess = done, onError = { error = it })
            } catch (e: IllegalArgumentException) { error = e.message ?: "Check the delivery details." }
            catch (_: Exception) { error = "Check the delivery details and use YYYY-MM-DD HH:mm for arrival." }
        }) { Text("Save route") }
    }
}

/** No background service: samples exist only while this visible order explicitly shares them. */
@Composable private fun DeliveryLocationSharing(order: MarketOrder, owner: String, model: MarketModel, supported: Boolean) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val eligible = order.shipment.stops.filter { it.status != "completed" && (order.seller == owner || it.courierPubkey == owner) }
    var stopId by remember(order.id) { mutableStateOf(eligible.firstOrNull()?.id ?: "") }
    var sharing by remember(order.id) { mutableStateOf(false) }
    var error by remember(order.id) { mutableStateOf<String?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { permissions ->
        sharing = supported && permissions.values.any { it } && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        if (!sharing) error = "Location permission is needed to share your delivery position."
    }
    LaunchedEffect(supported) { if (!supported) sharing = false }
    LaunchedEffect(eligible.map { it.id }) { if (eligible.none { it.id == stopId }) { sharing = false; stopId = eligible.firstOrNull()?.id ?: "" } }
    LaunchedEffect(sharing) { if (sharing) { delay(60 * 60 * 1000L); sharing = false } }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) sharing = false }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
    }
    DisposableEffect(sharing, stopId, order.id, owner) {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val started = sharing && eligible.any { it.id == stopId }
        var closed = false
        var last = 0L
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                val elapsed = android.os.SystemClock.elapsedRealtime()
                if (closed || !sharing || last > 0 && elapsed - last < 15_000 || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
                val sampleAge=android.os.SystemClock.elapsedRealtimeNanos()-location.elapsedRealtimeNanos
                if(sampleAge<0||sampleAge>=120_000_000_000L)return
                if (!location.latitude.isFinite() || !location.longitude.isFinite() || kotlin.math.abs(location.latitude)>90 || kotlin.math.abs(location.longitude)>180) return
                last = elapsed
                val point = JSONObject().put("coordinates", JSONArray(listOf(location.longitude, location.latitude))).put("stopId", stopId)
                model.orderCommand(JSONObject().put("type", "update_order").put("order_id", order.id).put("patch", JSONObject().put("location", point)), onError = { error = it; sharing = false })
            }
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) {}
            @Deprecated("Deprecated in Android") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        }
        if (started) {
            try {
                val precise = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                val providers = (if (precise) listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER) else listOf(LocationManager.NETWORK_PROVIDER)).filter { manager.isProviderEnabled(it) }
                if (providers.isEmpty()) { sharing = false; error = "Turn on location services to share your delivery position." }
                else providers.forEach { manager.requestLocationUpdates(it, 15_000L, 10f, listener, Looper.getMainLooper()) }
            } catch (_: SecurityException) { sharing = false; error = "Location permission is needed." }
        }
        onDispose {
            closed = true
            runCatching { manager.removeUpdates(listener) }
            if (started) model.orderCommand(JSONObject().put("type", "update_order").put("order_id", order.id).put("patch", JSONObject().put("location", JSONObject.NULL)), onError = {})
        }
    }
    if (eligible.isEmpty() || !supported && !sharing) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (eligible.size > 1) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            eligible.forEachIndexed { index, stop -> FilterChip(selected = stopId == stop.id, onClick = { sharing = false; stopId = stop.id }, enabled = !sharing, label = { Text(stop.label.ifBlank { "Stop ${index + 1}" }) }) }
        }
        OutlinedButton(onClick = {
            error = null
            if (sharing) sharing = false
            else if (!supported) return@OutlinedButton
            else if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) sharing = true
            else permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }) { Icon(if (sharing) Icons.Filled.LocationOff else Icons.Filled.MyLocation, null); Spacer(Modifier.width(8.dp)); Text(if (sharing) "Stop sharing location" else "Share live location") }
        Text(if (sharing) "Shared privately while this order stays open. Stops after one hour." else "Share your current position with this order's participants while this view is open.", color = Muted, style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}


@Composable private fun ArrivalEstimate(eta: Long?, status: String) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(lifecycle, eta, status) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { now = System.currentTimeMillis() / 1000; delay(15_000) }
        }
    }
    marketArrivalEstimate(eta, status, now)?.let { estimate ->
        Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text("Estimated arrival", style = MaterialTheme.typography.labelSmall, color = Muted)
            Text(estimate, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
            Text(orderDate(eta!!), style = MaterialTheme.typography.bodySmall, color = Muted)
        }
    }
}


/** The ordered item's photo, loaded like listing photos. */
@Composable private fun OrderThumb(url: String) {
    val photo by produceState<android.graphics.Bitmap?>(null, url) { value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { loadPhoto(url) } }
    Box(Modifier.size(56.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerLow)) {
        photo?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = androidx.compose.ui.layout.ContentScale.Crop) }
    }
}
