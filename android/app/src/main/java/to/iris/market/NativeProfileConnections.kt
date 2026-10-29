package to.iris.market

object NativeProfileConnections {
    fun ordered(known: List<String>, followers: List<String>): List<String> = (known + followers).distinct()
    fun remaining(total: Int, displayed: Int): Int = (total - displayed).coerceAtLeast(0)
}
