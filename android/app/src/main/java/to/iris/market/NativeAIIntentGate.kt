package to.iris.market

/** Short preference commits are serialized independently of network inference. */
class NativeAIIntentGate {
    private val lock=Any()
    private var value=0L
    val current: Long get()=synchronized(lock){value}
    fun advance(): Long=synchronized(lock){value+=1;value}
    fun <T> perform(epoch: Long,operation:()->T): T?=synchronized(lock){if(epoch!=value) null else operation()}
}
