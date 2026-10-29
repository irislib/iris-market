import test from 'node:test'
import assert from 'node:assert/strict'
import {createSearchDiscovery} from '../src/search-discovery.ts'
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function fixture(){
  const calls=[],plans=[],pending=[]
  const client={tagCatalogue:{entries:()=>[{spellings:['laptop']}]},searchTags(...args){calls.push(args);return[]}}
  const ai={active:false,info:{loaded:true},enabled(){return this.active},planTags(query,tags,signal){const request=deferred();plans.push({query,tags,signal});pending.push(request);return request.promise}}
  let activeClient=client
  const discovery=createSearchDiscovery({getClient:()=>activeClient,getAI:()=>ai})
  return{client,ai,calls,plans,pending,discovery,setClient(value){activeClient=value}}
}
test('literal submitted retrieval never asks the model for tag expansion',async()=>{
  const f=fixture();f.discovery.update('electronics','literal');f.discovery.update('electronics','literal');await tick()
  assert.deepEqual(f.calls,[['electronics',undefined,'literal']]);assert.equal(f.plans.length,0);f.discovery.dispose()
})
test('same submitted query switches policy, aborts a stale AI plan and can expand again',async()=>{
  const f=fixture();f.discovery.update('electronics','literal');f.ai.active=true;f.discovery.update('electronics','expanded');await tick()
  assert.equal(f.plans.length,1);assert.deepEqual(f.plans[0].tags,['laptop'])
  f.ai.active=false;f.discovery.update('electronics','literal');assert.equal(f.plans[0].signal.aborted,true)
  f.pending[0].resolve(['laptop']);await tick();assert.equal(f.calls.length,3,'old AI tags cannot leak into normal mode')
  f.ai.active=true;f.discovery.update('electronics','expanded');await tick();f.pending[1].resolve(['laptop']);await tick()
  assert.deepEqual(f.calls.at(-1),['electronics',['laptop'],'expanded']);f.discovery.dispose()
})
test('failed optional tag planning leaves the loaded model and current retrieval intact',async()=>{
  const f=fixture(),loaded=f.ai.info;f.ai.active=true;f.discovery.update('electronics','expanded');await tick();f.pending[0].reject(Error('Source unavailable'));await tick()
  assert.equal(f.ai.info,loaded);assert.deepEqual(f.calls,[['electronics',undefined,'expanded']]);f.discovery.dispose()
})
test('replacing the source or disposing rejects late plans from the same query',async()=>{
  const f=fixture();f.ai.active=true;f.discovery.update('electronics','expanded');await tick()
  const nextCalls=[],next={...f.client,searchTags(...args){nextCalls.push(args);return[]}};f.setClient(next);f.discovery.update('electronics','expanded');await tick()
  assert.equal(f.plans[0].signal.aborted,true);f.pending[0].resolve(['old']);await tick();assert.equal(f.calls.length,1)
  f.discovery.dispose();assert.equal(f.plans[1].signal.aborted,true);f.pending[1].resolve(['late']);await tick();assert.deepEqual(nextCalls,[['electronics',undefined,'expanded']])
})
