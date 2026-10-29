import test from 'node:test'
import assert from 'node:assert/strict'
import {createSocialRootController} from '../src/social-root.ts'
import {GRAPH_BOOTSTRAP} from '../src/graph-bootstrap.ts'

const alice='a'.repeat(64),bob='b'.repeat(64),custom='c'.repeat(64)
const turn=()=>new Promise(resolve=>setTimeout(resolve,0))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const context=(owner,count,{at=10,id='1'.repeat(64),verified=true}={})=>({contextPubkey:owner,coverage:{rootLoaded:verified,directFollows:count},lists:new Map([[owner,{event:{id,created_at:at},follows:count===null?null:Array.from({length:count},()=>custom)}]])})

test('new identities get the default synchronously while their follow lookup stays unresolved',async()=>{
  const pending=deferred(),states=[],controller=createSocialRootController({loadContext:()=>pending.promise,onChange:state=>states.push(state)})
  controller.setIdentity(alice)
  assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);assert.equal(controller.state().pending,true)
  await turn();assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root)
  pending.resolve(context(alice,2));await turn()
  assert.equal(controller.state().root,alice);assert.equal(controller.state().source,'identity');assert.equal(controller.state().pending,false)
  assert.equal(controller.state().context.coverage.directFollows,2);assert(states.length>=2);controller.dispose()
})

test('confirmed empty and absent lists keep useful default discovery; a snapshot count is not evidence',async()=>{
  for(const result of [context(alice,0),context(alice,null,{verified:false}),context(alice,20,{verified:false})]){
    const controller=createSocialRootController({loadContext:async()=>result});controller.setIdentity(alice);await turn()
    assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);assert.equal(controller.state().context,null);controller.dispose()
  }
})

test('temporary failure keeps a known nonempty graph, while a newer signed empty list switches to default',async()=>{
  let result=context(alice,3),failure=false
  const controller=createSocialRootController({loadContext:async()=>{if(failure)throw new Error('offline');return result}})
  controller.setIdentity(alice);await turn();failure=true;controller.refresh()
  assert.equal(controller.state().root,alice);await turn();assert.equal(controller.state().root,alice)
  failure=false;result=context(alice,null,{verified:false});controller.refresh();await turn();assert.equal(controller.state().root,alice);assert.equal(controller.state().context.coverage.rootLoaded,false)
  result=context(alice,0,{at:11});controller.refresh();await turn();assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);controller.dispose()
})

test('signout and profile switching ignore late results even when a loader ignores cancellation',async()=>{
  const a=deferred(),b=deferred(),signals=[]
  const controller=createSocialRootController({loadContext:(owner,{signal})=>{signals.push(signal);return owner===alice?a.promise:b.promise}})
  controller.setIdentity(alice);await turn();controller.setIdentity(bob,alice);await turn();assert.equal(signals[0].aborted,true)
  a.resolve(context(alice,2));await turn();assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);assert.equal(controller.state().identity,bob)
  controller.setIdentity(null,bob);b.resolve(context(bob,5));await turn();assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);assert.equal(controller.state().identity,null);controller.dispose()
})

test('manual context wins over an in-flight identity lookup and survives signout',async()=>{
  const pending=deferred(),controller=createSocialRootController({loadContext:()=>pending.promise})
  controller.setIdentity(alice);await turn();controller.selectContext(custom);pending.resolve(context(alice,4));await turn()
  assert.equal(controller.state().root,custom);assert.equal(controller.state().source,'override')
  controller.setIdentity(null,alice);assert.equal(controller.state().root,custom);controller.dispose()
})

test('persisted unrelated contexts survive; stored current or previous identities revert to automatic selection',async()=>{
  const customController=createSocialRootController({initialContext:custom,loadContext:async()=>{throw Error('must not query')}})
  customController.setIdentity(alice);assert.equal(customController.state().root,custom);customController.dispose()
  for(const persisted of [alice,bob]){
    const controller=createSocialRootController({initialContext:persisted,loadContext:async()=>context(alice,0)})
    controller.setIdentity(alice,bob);assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);await turn();controller.dispose()
  }
})

test('explicit default remains selected and selecting own profile returns to automatic behavior',async()=>{
  const controller=createSocialRootController({loadContext:async()=>context(alice,3)})
  controller.setIdentity(alice);await turn();controller.selectContext(GRAPH_BOOTSTRAP.root)
  assert.equal(controller.state().root,GRAPH_BOOTSTRAP.root);assert.equal(controller.state().source,'override')
  controller.selectContext(alice);assert.equal(controller.state().root,alice);await turn();controller.dispose()
})

test('already loaded observations reuse verified context and ignore older revisions or wrong owners',async()=>{
  const pending=deferred(),controller=createSocialRootController({loadContext:()=>pending.promise})
  controller.setIdentity(alice);controller.observe(context(alice,2,{at:20}));assert.equal(controller.state().root,alice)
  controller.observe(context(alice,0,{at:19}));assert.equal(controller.state().root,alice)
  controller.observe(context(bob,0,{at:21}));assert.equal(controller.state().root,alice)
  pending.resolve(context(alice,0,{at:18}));await turn();assert.equal(controller.state().root,alice);controller.dispose()
})

test('dispose aborts work and cannot emit or select another context afterward',async()=>{
  const pending=deferred(),changes=[],controller=createSocialRootController({loadContext:()=>pending.promise,onChange:state=>changes.push(state)})
  controller.setIdentity(alice);await turn();controller.dispose();const count=changes.length
  pending.resolve(context(alice,3));controller.observe(context(alice,3));controller.setIdentity(bob);controller.selectContext(custom);await turn();assert.equal(changes.length,count)
})

test('the corrected company default preserves an explicitly selected personal context', async () => {
  assert.equal(GRAPH_BOOTSTRAP.root, '336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b')
  const controller = createSocialRootController({ initialContext: '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0', loadContext: async () => context(alice, 0) })
  controller.setIdentity(alice); await turn()
  assert.equal(controller.state().root, '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0'); assert.equal(controller.state().source, 'override'); controller.dispose()
})
