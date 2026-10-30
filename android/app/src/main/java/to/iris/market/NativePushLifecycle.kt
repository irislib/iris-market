package to.iris.market

import java.lang.ref.WeakReference

/** Explicit lifecycle removal must not depend on the timing of garbage collection. */
internal class NativePushLifecycle<T:Any> {
    private var current=WeakReference<T>(null)
    private val cleared=java.util.WeakHashMap<T,Boolean>()
    @Synchronized fun attach(value:T){if(!cleared.containsKey(value))current=WeakReference(value)}
    @Synchronized fun detach(value:T){cleared[value]=true;if(current.get()===value)current.clear()}
    @Synchronized fun current():T?=current.get()
    @Synchronized fun withCurrent(value:T,action:()->Unit):Boolean {
        if(current.get()!==value||cleared.containsKey(value))return false
        action();return true
    }
}
