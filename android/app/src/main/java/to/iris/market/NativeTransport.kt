package to.iris.market

import java.text.Normalizer
import java.util.Locale

enum class NativeTransportType(val label: String) {
    PARCEL("Deliveries"), PASSENGER("Rides"), BOTH("Both");
    val requestLabel: String get() = when (this) { PARCEL -> "Request delivery"; PASSENGER -> "Request ride"; BOTH -> "Request transport" }
    val serviceTitle: String get() = if (this == BOTH) "Deliveries and rides" else label
    val tags: List<String> get() = listOf("courier") + (if (this == PASSENGER) emptyList() else listOf("parcel")) + (if (this == PARCEL) emptyList() else listOf("passenger"))
    fun includes(tags: List<String>): Boolean = classify(tags)?.let { this == BOTH || it == BOTH || this == it } ?: false
    companion object {
        fun classify(values: List<String>): NativeTransportType? {
            val tags = values.take(64).map { Normalizer.normalize(it, Normalizer.Form.NFKC).trim().lowercase(Locale.ROOT) }.toSet()
            val passenger = tags.any { it in setOf("passenger", "passengers", "ride", "rides") }
            val parcel = tags.any { it in setOf("parcel", "parcels", "delivery", "deliveries") } || !passenger && "courier" in tags
            return when { passenger && parcel -> BOTH; passenger -> PASSENGER; parcel -> PARCEL; else -> null }
        }
    }
}
