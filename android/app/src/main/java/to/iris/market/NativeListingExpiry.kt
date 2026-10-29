package to.iris.market

import kotlin.math.ceil

/** Durations resolve at publish; the protocol continues to carry an absolute Unix timestamp. */
enum class NativeListingExpiry(val label: String, private val days: Long?) {
    NEVER("Never", null), DAY("1 day", 1), WEEK("1 week", 7), MONTH("30 days", 30), QUARTER("90 days", 90), YEAR("1 year", 365);
    fun deadline(publishedAt: Long): Long? = days?.let { duration ->
        val seconds = duration * 86_400
        if(publishedAt > Long.MAX_VALUE - seconds) Long.MAX_VALUE else publishedAt + seconds
    }
    companion object {
        // An editor that has not changed its preset must retain the original signed deadline.
        fun resolve(preset: NativeListingExpiry?, existing: Long?, publishedAt: Long): Long? =
            if(preset == null) existing else preset.deadline(publishedAt)
        fun detail(deadline: Long?, now: Long): String {
            if(deadline == null) return "No expiry"
            if(deadline <= now) return "Expired"
            val seconds = deadline.toDouble() - now.toDouble()
            for((size,name) in listOf(31_536_000.0 to "year",2_592_000.0 to "month",604_800.0 to "week",86_400.0 to "day",3_600.0 to "hour",60.0 to "minute")) {
                if(seconds >= size) {
                    val count = ceil(seconds / size).toLong()
                    return "Expires in $count $name${if(count == 1L) "" else "s"}"
                }
            }
            return "Expires in less than a minute"
        }
    }
}
