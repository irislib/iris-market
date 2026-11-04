import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools';
import {buildCollectionDraft,cachedCollections,loadCollections,parseCollection,rememberCollection} from '../src/collections.ts';
import {createMessaging} from '../src/messaging/client.ts';
import {createVault} from '../src/messaging/vault.ts';
import {RemoteSigner} from '../src/messaging/remote-signer.ts';

const now=()=>Math.floor(Date.now()/1000);
const product=()=>`30402:${getPublicKey(generateSecretKey())}:blue:cup`;
function fixture() {
  const secret=generateSecretKey(), author=getPublicKey(secret), members=[product(),`30402:${author}:lamp`];
  const draft=buildCollectionDraft({author,title:'My favorite products',members});
  return {secret,author,members,draft,signed:finalizeEvent(draft,secret)};
}
const results=(...events)=>async filters=>({complete:true,events:events.filter(e=>filters.some(f=>f.kinds.includes(e.kind)))});

test('curators and merchants share ordered product references and edit the same signed address',()=>{
  const {secret,author,members,draft}=fixture();
  const extra=[['shipping_option',`30406:${author}:delivery`],['a',`30405:${author}:related`],['t','ceramics']];
  const original=finalizeEvent({...draft,content:'Kiln favorites',tags:[...draft.tags.slice(0,2),[...draft.tags[2],'wss://example.test'],draft.tags[3],...extra]},secret);
  const previous=rememberCollection(original);
  const edited=buildCollectionDraft({author,title:'Studio favorites',members:[...members].reverse(),previous});
  assert.deepEqual(edited.tags.slice(0,2),[['d',previous.identifier],['title','Studio favorites']]);
  assert.deepEqual(edited.tags.slice(2),[['a',members[1]],['a',members[0],'wss://example.test'],...extra]);
  assert.equal(edited.content,'Kiln favorites');assert.equal(edited.created_at,original.created_at+1);
  assert.throws(()=>buildCollectionDraft({author:getPublicKey(generateSecretKey()),members,title:'Foreign edit',previous}),/signature/);
  const latest=rememberCollection(finalizeEvent(edited,secret));
  assert.equal(cachedCollections(author)[0].event.id,latest.event.id);
  assert.throws(()=>buildCollectionDraft({author,title:'stale',members,previous}),/changed/);
});
test('rejects invalid bounds, duplicates, non-product members and mutated signed input',()=>{
  const {author,members,draft,signed}=fixture();
  assert.throws(()=>buildCollectionDraft({author,title:'   ',members}),/name/);
  assert.throws(()=>buildCollectionDraft({author,title:'x'.repeat(161),members}),/name/);
  for(const list of [[],[members[0],members[0]],[members[0].replace('30402','38383')],['30402:broken'],Array.from({length:65},(_,i)=>members[1]+i)]){
    assert.throws(()=>buildCollectionDraft({author,title:'Favorites',members:list}));
  }
  const copy=structuredClone(signed);
  parseCollection(copy);copy.tags[1][1]='Forged';
  assert.throws(()=>parseCollection(copy),/signature/);
  assert.equal(draft.tags.some(tag=>tag[0]==='p'),false);
});
test('author-scoped queries reject replay behind invalid/expired winners and signed deletions',async()=>{
  for(const mode of ['malformed','expired','address','id']){
    const {secret,author,draft}=fixture(), at=now()-50;
    const old=finalizeEvent({...draft,created_at:at},secret), id=draft.tags[0][1], address=`30405:${author}:${id}`;
    let change;
    if(mode==='malformed')change=finalizeEvent({...draft,created_at:at+1,tags:draft.tags.filter(tag=>tag[0]!=='title')},secret);
    if(mode==='expired')change=finalizeEvent({...draft,created_at:at+1,tags:[...draft.tags,['expiration',String(at+10)]]},secret);
    if(['address','id'].includes(mode))change=finalizeEvent({kind:5,created_at:at+1,tags:[mode==='address'?['a',address]:['e',old.id]],content:''},secret);
    const calls=[];
    const query=async (...args)=>{calls.push(args[0]);return results(change,old)(...args)};
    const report=await loadCollections(author,{query});
    assert.equal(report.collections.length,0,mode);
    assert.equal(calls[0][0].authors[0],author);assert.equal(calls[0][0].kinds[0],30405);
    assert.deepEqual(calls[1][0]['#a'],[address]);assert.equal(calls[1][1]['#e'].length,1);
    assert.equal((await loadCollections(author,{query:results(old)})).collections.length,0,mode);
    const newer=finalizeEvent({...draft,created_at:at+2},secret);
    assert.equal((await loadCollections(author,{query:results(newer,change)})).collections[0].event.id,newer.id);
  }
});
test('winner is deterministic on ties, other authors cannot delete or supply collections for a profile',async()=>{
  const {secret,author,draft,signed}=fixture(), rival=finalizeEvent({...draft,content:'another interpretation'},secret);
  const expected=[signed,rival].sort((a,b)=>a.id.localeCompare(b.id))[0], stranger=fixture();
  const wrong=finalizeEvent({kind:5,created_at:now()+1,tags:[['e',expected.id],['a',`30405:${author}:${draft.tags[0][1]}`]],content:''},stranger.secret);
  const {collections}=await loadCollections(author,{query:results(rival,stranger.signed,signed,wrong)});
  assert.equal(collections.length,1);assert.equal(collections[0].event.id,expected.id);
});
test('signed collection queues offline, survives lock, and becomes public on acknowledgement',async t=>{
  let row,acknowledge=false;
  const backend={read:async()=>structuredClone(row),write:async(value,expected)=>{if(expected!==undefined && (row?.version??0)!==expected)throw Error('Concurrent writer');row=structuredClone(value);}};
  const vault=createVault({backend});
  const app=createMessaging({vault,getRelays:()=>['wss://silent.invalid'],transportFactory:()=>({
    query:async()=>({events:[],complete:true}),subscribe:()=>({close(){}}),
    publish:async()=>({remoteAccepted:acknowledge}),close(){},
  })});
  t.after(()=>app.destroy());
  const {ownerPubkey:author}=await app.createAccount(), members=[product(),`30402:${author}:own`];
  const draft=buildCollectionDraft({author,title:'Gift ideas',members});
  await assert.rejects(app.signEvent({...draft,tags:draft.tags.filter(tag=>tag[0]!=='a')}),/Choose between/);
  const receipt=await app.publishEvent(draft);
  assert.equal(receipt.delivery,'queued');assert.deepEqual(receipt.accepted,[]);
  rememberCollection(receipt.event,receipt.delivery);
  assert.deepEqual(app.state().pendingListings,[]);assert.deepEqual(app.state().pendingReviews,[]);
  assert.equal(cachedCollections(author,app.state().pendingCollections)[0].delivery,'queued');
  assert.equal(cachedCollections(author).length,0);
  assert.equal((await vault.get('market/public/'+receipt.event.id)).id,receipt.event.id);
  await app.lock();await app.restore();
  assert.equal(app.state().pendingCollections[0].id,receipt.event.id);
  await app.lock();acknowledge=true;await app.restore();
  const deadline=Date.now()+1500;
  while(app.state().pendingCollections.length){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}
  assert.equal(cachedCollections(author)[0].event.id,receipt.event.id);
  assert.equal(cachedCollections(author)[0].delivery,'published');
});

test('signed winners and deletion tombstones survive a fresh browser session and a stale relay',async()=>{
  const initial=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}});
  try{
    const {author,draft,signed,secret}=fixture();
    const deletion=finalizeEvent({kind:5,created_at:now(),content:'',tags:[['a',`30405:${author}:${draft.tags[0][1]}`]]},secret);
    await loadCollections(author,{query:results(signed,deletion)});
    assert.ok(values.size);
    const restarted=await import('../src/collections.ts?fresh-session');
    assert.equal(restarted.cachedCollections(author).length,0);
    assert.equal((await restarted.loadCollections(author,{query:results(signed)})).collections.length,0);
    const republished=finalizeEvent({...draft,created_at:deletion.created_at+1},secret);
    assert.equal((await restarted.loadCollections(author,{query:results(republished)})).collections[0].event.id,republished.id);
  }finally{
    if(initial)Object.defineProperty(globalThis,'localStorage',initial);else delete globalThis.localStorage;
  }
});
test('owner deletion hides a queued revision even before it is observed on a relay',async()=>{
  const {author,draft,signed,secret}=fixture();
  const deletion=finalizeEvent({kind:5,created_at:now()+1,tags:[['e',signed.id]],content:''},secret);
  const pending=[signed];
  assert.equal(cachedCollections(author,pending)[0].delivery,'queued');
  const {collections}=await loadCollections(author,{query:results(deletion),pending});
  assert.equal(collections.length,0);
  assert.equal(cachedCollections(author).length,0);
  assert.equal(cachedCollections(author,pending).length,0);
  assert.equal((await loadCollections(author,{query:results(signed)})).collections.length,0);
  const newer=finalizeEvent({...draft,created_at:now()+2},secret);
  assert.equal((await loadCollections(author,{query:results(newer)})).collections[0].event.id,newer.id);
});


test('only an explicitly scoped posting signer may sign a valid collection',async t=>{
  const {author,secret,draft}=fixture(),options={signal:new AbortController().signal,relays:[]};
  const enrollment=new RemoteSigner(options),posting=new RemoteSigner({...options,permissions:['sign_event:30405']});
  t.after(()=>{enrollment.close();posting.close()});
  let calls=0;
  posting.request=async(method,params)=>{assert.equal(method,'sign_event');calls++;return JSON.stringify(finalizeEvent(JSON.parse(params[0]),secret));};
  const unsigned={...draft,pubkey:author};
  await assert.rejects(enrollment.signEvent(unsigned),/cannot approve/);
  await assert.rejects(posting.signEvent({...unsigned,tags:unsigned.tags.filter(tag=>tag[0]!=='a')}),/Choose between/);
  assert.equal(calls,0);
  const event=await posting.signEvent(unsigned);
  assert.equal(parseCollection(event).author,author);
  assert.equal(calls,1);
});
test('interoperable imports deduplicate product refs in place and reject control characters',()=>{
  const {author,secret,draft,members}=fixture();
  const event=finalizeEvent({...draft,tags:[...draft.tags,['a',members[0],'wss://other.test']]},secret);
  const imported=parseCollection(event);
  assert.deepEqual(imported.members,members);
  const edited=buildCollectionDraft({author,members,title:'Shelf',previous:imported});
  assert.deepEqual(edited.tags.filter(tag=>tag[0]==='a'),draft.tags.filter(tag=>tag[0]==='a'));
  assert.throws(()=>buildCollectionDraft({author,members,title:'A\u0085B'}),/name/);
  assert.throws(()=>buildCollectionDraft({author,members:[members[0]+'\u0080'],title:'Shelf'}));
});
test('stale approvals cannot replace another local collection revision',async t=>{
  let row;
  const vault=createVault({backend:{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}});
  const app=createMessaging({vault,getRelays:()=>['wss://silent.invalid'],transportFactory:()=>({query:async()=>({events:[],complete:true}),subscribe:()=>({close(){}}),publish:async()=>({remoteAccepted:false}),close(){}})});
  t.after(()=>app.destroy());
  const {ownerPubkey:author}=await app.createAccount(), members=[product()];
  const draft=buildCollectionDraft({author,title:'Original',members});
  const {event}=await app.publishEvent(draft,null);
  const previous=rememberCollection(event,'queued');
  const edit=buildCollectionDraft({author,title:'Mine',members,previous});
  await app.publishEvent(edit,event.id);
  await assert.rejects(app.publishEvent(buildCollectionDraft({author,title:'Stale',members,previous}),event.id),/changed/);
  assert.equal(cachedCollections(author,app.state().pendingCollections)[0].title,'Mine');
});
test('eviction of a signed tombstone cannot revive an older collection or suppress an unrelated profile',async()=>{
  const restart=await import('../src/collections.ts?eviction');
  const {author,secret,draft}=fixture(), at=now()-600;
  const older=finalizeEvent({...draft,created_at:at},secret);
  const hidden=finalizeEvent({...draft,created_at:at+1,tags:[...draft.tags,['visibility','hidden']]},secret);
  await restart.loadCollections(author,{query:results(older,hidden)});
  // More than 1 MiB of valid signed heads exercises the byte budget before the count limit.
  for(let i=0;i<48;i++){
    const extra=finalizeEvent({...draft,content:'x'.repeat(31_000),created_at:at+i+2,tags:[['d','additional-'+i],...draft.tags.slice(1)]},secret);
    restart.rememberCollection(extra);
  }
  const checked=await restart.loadCollections(author,{query:results(older)});
  assert.equal(checked.incomplete,true);
  assert.equal(checked.collections.some(item=>item.identifier===draft.tags[0][1]),false);
  const other=fixture(), eligible=finalizeEvent({...other.draft,created_at:at},other.secret);
  assert.equal((await restart.loadCollections(other.author,{query:results(eligible)})).collections[0].event.id,eligible.id);
});
