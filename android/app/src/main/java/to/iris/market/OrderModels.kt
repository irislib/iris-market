package to.iris.market

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Projection of the shared, authenticated order model. Android never decides wire authorization. */
data class OrderItem(val id: String, val title: String, val price: String, val currency: String, val quantity: Int) {
    val displayPrice: String get() = when {
        price.isBlank() -> "Negotiable"
        price.toDoubleOrNull() == 0.0 -> "Free"
        currency == "EUR" -> "€$price"
        currency == "USD" -> "$$price"
        currency == "GBP" -> "£$price"
        currency in setOf("TESTSAT","TESTSATS") -> "$price test sats"
        currency == "SATS" -> "$price sats"
        else -> "$price $currency"
    }
}
data class DeliveryStop(val id: String, val label: String, val address: String, val coordinates: List<Double>?, val courierPubkey: String?, val status: String) {
    fun json(): JSONObject = JSONObject().put("id", id).put("label", label).put("address", address).put("status", status).apply {
        coordinates?.let { put("coordinates", JSONArray(it)) }
        courierPubkey?.takeIf(String::isNotBlank)?.let { put("courierPubkey", it) }
    }
}
data class DeliveryLocation(val coordinates: List<Double>, val at: Long)
data class Shipment(val stops: List<DeliveryStop>, val trackingUrl: String?, val eta: Long?, val location: DeliveryLocation?) {
    /** Only route presentation enters the app's map renderer, never owner/courier keys. */
    fun mapProjection(): JSONObject = JSONObject().put("stops", JSONArray().apply {
        stops.forEach { stop -> put(stop.json().apply { remove("courierPubkey") }) }
    }).apply { location?.takeIf { System.currentTimeMillis() / 1000 - it.at in 0L..119L }?.let { put("location", JSONObject().put("coordinates", JSONArray(it.coordinates)).put("at", it.at)) } }
}
data class OrderDeliveryPlace(val label:String,val address:String="",val coordinates:List<Double>?=null) {
    fun json():JSONObject { require(address.trim().isNotEmpty()&&address.length<=500&&label.length<=120){"Enter an address or meeting point."};return JSONObject().put("label",label).put("address",address.trim()).apply {coordinates?.let {require(it.size==2&&it.all(Double::isFinite)&&kotlin.math.abs(it[0])<=180&&kotlin.math.abs(it[1])<=90){"Choose a valid map point."};put("coordinates",JSONArray(it))}} }
    companion object {fun parse(value:JSONObject)=OrderDeliveryPlace(value.optString("label"),value.optString("address"),value.optJSONArray("coordinates")?.let {if(it.length()==2)listOf(it.optDouble(0),it.optDouble(1))else null})}
}
data class OrderDeliveryCollection(val merchant:String,val reference:String)
data class OrderDeliveryRequest(val pickup:OrderDeliveryPlace,val destination:OrderDeliveryPlace,val collection:OrderDeliveryCollection?=null) {
    fun json()=JSONObject().put("pickup",pickup.json()).put("destination",destination.json()).apply {collection?.let {put("collection",JSONObject().put("merchant",it.merchant).put("reference",it.reference))}}
    companion object {fun parse(value:JSONObject)=OrderDeliveryRequest(OrderDeliveryPlace.parse(value.getJSONObject("pickup")),OrderDeliveryPlace.parse(value.getJSONObject("destination")),value.optJSONObject("collection")?.let {OrderDeliveryCollection(it.getString("merchant"),it.getString("reference"))})}
}
data class OrderPayment(val mint:String,val amount:String,val unit:String,val status:String)
data class PickupAuthorization(val courierPubkey:String,val reference:String)
data class MarketOrder(
    val id: String, val buyer: String, val seller: String, val items: List<OrderItem>, val note: String,
    val status: String, val createdAt: Long, val updatedAt: Long, val shipment: Shipment,
    val archived: Boolean, val sync: String, val role: String?, val locationFresh: Boolean,
    val displayPrice:PriceDisplay?=null,val payment:OrderPayment?=null,val deliveryRequest:OrderDeliveryRequest?=null,val pickupAuthorization:PickupAuthorization?=null,val sourceOrderId:String?=null,val deliveryOrderId:String?=null
) {
    val formattedPrice:String get() {
        val display=displayPrice?:return items.firstOrNull()?.displayPrice?:"Negotiable"
        if(!display.amount.isFinite())return items.firstOrNull()?.displayPrice?:"Negotiable"
        val suffix=if(display.stale)" · older rate" else ""
        if(display.currency.uppercase() in setOf("SAT","SATS","BTC"))return java.text.NumberFormat.getNumberInstance().apply{maximumFractionDigits=if(display.currency.uppercase()=="BTC")8 else 0}.format(display.amount)+" "+(if(display.currency.uppercase()=="BTC")"BTC" else "sats")+suffix
        return runCatching {java.text.NumberFormat.getCurrencyInstance().apply{currency=java.util.Currency.getInstance(display.currency)}.format(display.amount)}.getOrDefault(items.firstOrNull()?.displayPrice?:"Negotiable")+suffix
    }
    val terminal: Boolean get() = status in listOf("delivered", "cancelled")
    val title: String get() = items.joinToString { it.title }.ifBlank { "Order" }
    val statusLabel: String get() = when(status) { "requested" -> "Requested"; "accepted" -> "Accepted"; "in-transit" -> "On the way"; "delivered" -> "Delivered"; "cancelled" -> "Cancelled"; else -> "Updating" }
    fun handlesDelivery(owner: String) = (seller==owner&&deliveryRequest!=null)||shipment.stops.any { it.courierPubkey == owner || seller == owner }
    companion object {
        fun parse(value: JSONObject): MarketOrder {
            val shipment = value.optJSONObject("shipment") ?: JSONObject()
            val stops = shipment.optJSONArray("stops") ?: JSONArray()
            val items = value.optJSONArray("items") ?: JSONArray()
            val location = shipment.optJSONObject("location")
            return MarketOrder(value.getString("id"), value.getString("buyer"), value.getString("seller"),
                (0 until items.length()).map { i -> items.getJSONObject(i).let { OrderItem(it.getString("id"), it.optString("title"), it.optString("price"), it.optString("currency", "EUR"), it.optInt("quantity", 1)) } },
                value.optString("note"), value.optString("status"), value.optLong("createdAt"), value.optLong("updatedAt"),
                Shipment((0 until stops.length()).map { i -> stops.getJSONObject(i).let { DeliveryStop(it.getString("id"), it.optString("label"), it.optString("address"), coordinates(it.optJSONArray("coordinates")), it.textOrNull("courierPubkey"), it.optString("status", "pending")) } },
                    shipment.textOrNull("trackingUrl"), shipment.optLong("eta").takeIf { it > 0 }, location?.let { coordinates(it.optJSONArray("coordinates"))?.let { point -> DeliveryLocation(point, location.optLong("at")) } }),
                value.optBoolean("archived"), value.optString("sync", "queued"), value.textOrNull("role"), value.optBoolean("locationFresh"),
                value.optJSONObject("display_price")?.let {PriceDisplay(it.optDouble("amount"),it.optString("currency"),it.optBoolean("approximate"),it.optBoolean("stale"))},
                value.optJSONObject("payment")?.let {OrderPayment(it.getString("mint"),it.getString("amount"),it.getString("unit"),it.getString("status"))},
                value.optJSONObject("deliveryRequest")?.let {OrderDeliveryRequest.parse(it)},
                value.optJSONObject("pickupAuthorization")?.let {PickupAuthorization(it.getString("courierPubkey"),it.getString("reference"))},value.textOrNull("sourceOrderId"),value.textOrNull("deliveryOrderId"))
        }
        private fun coordinates(value: JSONArray?): List<Double>? = value?.takeIf { it.length() == 2 }?.let { listOf(it.optDouble(0), it.optDouble(1)) }?.takeIf { it.all(Double::isFinite) && kotlin.math.abs(it[0]) <= 180 && kotlin.math.abs(it[1]) <= 90 }
    }
}
internal fun JSONObject.textOrNull(name: String): String? = if (isNull(name)) null else optString(name).takeIf(String::isNotBlank)
internal fun orderDate(seconds: Long): String = runCatching { DateTimeFormatter.ofPattern("d MMM, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(seconds)) }.getOrDefault("")
