@main struct NativePushRuntimeChecks {
    typealias Queue = NativePushCoalescer
    static func on(_ owner:String="a",_ body:String="token-and-scopes") -> Queue.Snapshot { .init(owner:owner,enabled:true,delivery:body) }
    static func off(_ owner:String="a") -> Queue.Snapshot { .init(owner:owner,enabled:false,delivery:nil) }
    static func main() {
        var checks=0
        func check(_ name:String,_ body:()->Void){body();checks+=1;print("PASS \(name)")}
        check("late token consumes no invalid-input throttle") {
            var q=Queue();q.enqueue(.init(owner:"a",enabled:true,delivery:nil),sequence:1,now:0)
            precondition(q.next()==nil)
            q.enqueue(on(),sequence:2,now:0.1)
            let work=q.next()!;precondition(work.readyAt==0 && q.begin(work,now:0.1))
        }
        check("latest snapshot survives an active request and deferred throttle") {
            var q=Queue();q.enqueue(on(),sequence:1,now:0);let old=q.next()!;precondition(q.begin(old,now:0))
            q.enqueue(on("a","new-token-and-scopes"),sequence:2,now:1);q.finish(old,success:true,now:1)
            let latest=q.next()!;precondition(latest.snapshot.delivery=="new-token-and-scopes" && latest.readyAt==10)
            precondition(!q.begin(latest,now:9) && q.begin(latest,now:10));q.finish(latest,success:true,now:11)
            precondition(q.next()==nil)
        }
        check("disabled cleanup survives active pass and another account") {
            var q=Queue();q.enqueue(on(),sequence:1,now:0);let active=q.next()!;precondition(q.begin(active,now:0))
            q.enqueue(off(),sequence:2,now:1);q.enqueue(on("b"),sequence:3,now:1);q.finish(active,success:true,now:2)
            let cleanup=q.next()!;precondition(!cleanup.snapshot.enabled && cleanup.snapshot.owner=="a")
            precondition(q.begin(cleanup,now:2));q.finish(cleanup,success:true,now:2)
            precondition(q.next()?.snapshot.owner=="b")
        }
        check("old queued preference cannot revive a disabled account") {
            var q=Queue();q.enqueue(on(),sequence:1,now:0);q.enqueue(off(),sequence:3,now:1)
            q.enqueue(on("a","stale-token"),sequence:2,now:2)
            precondition(q.next()?.snapshot.enabled==false)
        }
        check("disable round-trip still cleans an obsolete create") {
            var q=Queue();q.enqueue(off(),sequence:1,now:0);let initial=q.next()!;precondition(q.begin(initial,now:0));q.finish(initial,success:true,now:0)
            q.enqueue(on(),sequence:2,now:1);let create=q.next()!;precondition(q.begin(create,now:1))
            q.enqueue(off(),sequence:3,now:2);q.finish(create,success:true,now:3)
            precondition(q.next()?.snapshot.enabled==false)
        }
        check("identical successful snapshot stays quiet") {
            var q=Queue();q.enqueue(on(),sequence:1,now:0);let work=q.next()!;precondition(q.begin(work,now:0));q.finish(work,success:true,now:1)
            q.enqueue(on(),sequence:2,now:2);precondition(q.next()==nil)
        }
        check("three automatic failures stop until later foreground evidence") {
            var q=Queue();q.enqueue(on(),sequence:1,now:0)
            for now in [0.0,10.0,40.0] { let work=q.next()!;precondition(q.begin(work,now:now));q.finish(work,success:false,now:now) }
            precondition(q.next()==nil)
            q.enqueue(on(),sequence:2,now:99);precondition(q.next()==nil)
            q.enqueue(on(),sequence:3,now:100);precondition(q.next() != nil)
        }
        check("finished disabled entries can retire without dropping pending cleanup") {
            var q=Queue()
            for value in 0..<80 {
                let owner="owner-\(value)";q.enqueue(off(owner),sequence:UInt64(value+1),now:0)
                let work=q.next()!;precondition(q.begin(work,now:0));q.finish(work,success:true,now:0)
            }
            q.enqueue(on(),sequence:100,now:0);precondition(q.next()?.snapshot.owner=="a")
        }
        print("Native push coalescer: \(checks) focused checks passed")
    }
}
