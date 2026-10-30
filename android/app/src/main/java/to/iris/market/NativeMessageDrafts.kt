package to.iris.market

/** Process-local drafts are isolated by account, peer and exact message context. */
class NativeMessageDrafts {
    data class Key(val account:String,val peer:String,val context:String)
    private val values=mutableMapOf<Key,String>()
    companion object {fun key(account:String,peer:String,context:String)=Key(account,peer,if(context=="*")"general" else context)}
    operator fun get(key:Key):String=values[key].orEmpty()
    operator fun set(key:Key,value:String) {
        if(key.account.isBlank())return
        if(value.isEmpty())values.remove(key) else values[key]=value
    }
    fun sent(text:String,key:Key,success:Boolean){if(success&&get(key)==text)values.remove(key)}
    fun snapshot():Map<Key,String> = values.toMap()
}
