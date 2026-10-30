package to.iris.market

/** One latest snapshot per account. Only explicit intent may change enabled. */
internal class NativePushRegistrationQueue {
    data class Work(val owner:String,val enabled:Boolean,val filters:String,val token:String,val revision:Long,val signature:String,val readyAt:Long)
    private data class Account(var enabled:Boolean=false,var filters:String="",var revision:Long=0,var completed:String?=null,var lastAttempt:Long?=null,var failures:Int=0,var retryAt:Long=0)
    private val accounts=linkedMapOf<String,Account>()
    private var token=""
    private var tokenRevision=0L
    @Synchronized fun setIntent(owner:String,enabled:Boolean) {
        val account=accounts.getOrPut(owner){Account()}
        if(account.enabled!=enabled){account.enabled=enabled;account.revision++;account.completed=null}
        account.failures=0;account.retryAt=0
    }
    @Synchronized fun publish(owner:String,filters:String,now:Long) {
        val account=accounts.getOrPut(owner){Account()}
        if(account.filters!=filters){account.filters=filters;if(account.enabled){account.revision++;account.completed=null};account.failures=0;account.retryAt=0}
        // Foreground refresh can retry a failed pass after a quiet minute. No UI
        // means no new pass: automatic background retries remain bounded to three.
        if(account.failures>=3&&now-(account.lastAttempt ?: now)>=60000){account.failures=0;account.retryAt=0}
    }
    @Synchronized fun recordToken(value:String) {
        if(token==value)return
        token=value;tokenRevision++
        accounts.values.filter {it.enabled}.forEach {it.revision++;it.completed=null;it.failures=0;it.retryAt=0}
    }
    @Synchronized fun tokenRevision():Long=tokenRevision
    @Synchronized fun recordFetchedToken(value:String,expectedRevision:Long):Boolean {
        if(tokenRevision!=expectedRevision)return false
        recordToken(value);return true
    }
    @Synchronized fun wantsToken():Boolean = token.isBlank()&&accounts.values.any {it.enabled&&it.filters.isNotBlank()}
    @Synchronized fun next():Work? = accounts.mapNotNull { (owner,account)->
        if(account.failures>=3||account.enabled&&(account.filters.isBlank()||token.isBlank()))return@mapNotNull null
        val signature=if(account.enabled) "on|${account.filters}|$token" else "off"
        if(account.completed==signature)return@mapNotNull null
        val ready=maxOf(account.retryAt,account.lastAttempt?.plus(10000) ?: 0L)
        Work(owner,account.enabled,account.filters,token,account.revision,signature,ready)
    }.minByOrNull {it.readyAt}
    @Synchronized fun isCurrent(work:Work):Boolean {
        val account=accounts[work.owner] ?: return false
        return account.revision==work.revision&&account.enabled==work.enabled&&(!work.enabled||token==work.token&&account.filters==work.filters)
    }
    @Synchronized fun begin(work:Work,now:Long):Boolean {
        if(!isCurrent(work)||now<work.readyAt)return false
        accounts.getValue(work.owner).lastAttempt=now;return true
    }
    @Synchronized fun finish(work:Work,success:Boolean,now:Long):Boolean {
        if(!isCurrent(work))return false
        val account=accounts.getValue(work.owner)
        if(success){account.completed=work.signature;account.failures=0;account.retryAt=0}
        else {account.failures++;account.retryAt=now+if(account.failures==1)10000 else 30000}
        return true
    }
}
