package to.iris.market

/** Shipment ETA estimates destination arrival, never pickup or completion status. */
fun marketArrivalEstimate(eta: Long?, status: String, now: Long): String? {
    if (now < 0 || now > 8_640_000_000_000L || status !in listOf("accepted", "in-transit") || eta == null || eta <= 0 || eta > 8_640_000_000_000L) return null
    if (eta <= now) return "Taking longer than expected"
    val seconds = eta - now
    if (seconds < 60) return "Less than a minute"
    val minutes = seconds / 60 + if (seconds % 60 == 0L) 0 else 1
    if (minutes < 60) return "About $minutes min"
    if (minutes < 1440) {
        val remainder = minutes % 60
        return "About ${minutes / 60} hr" + if (remainder == 0L) "" else " $remainder min"
    }
    val days = minutes / 1440 + if (minutes % 1440 == 0L) 0 else 1
    return "About $days ${if (days == 1L) "day" else "days"}"
}
