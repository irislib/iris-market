import test from 'node:test'
import assert from 'node:assert/strict'
import {createMatchBook,matchCandidates} from '../src/private-matches.ts'

const alice='a'.repeat(64),bob='b'.repeat(64),helper='c'.repeat(64)
function mailbox(owner,clock){
  let saved
  const vault={get:async()=>structuredClone(saved),put:async(_,v)=>{saved=structuredClone(v)}}
  const open=async()=>{
    const book=createMatchBook(vault,owner,owner,()=>{},()=>{},()=>clock.at)
    await book.load()
    return book
  }
  return {open}
}

test('pending offers survive restart and introductions require both private approvals',async()=>{
  const clock={at:1000},storage=mailbox(helper,clock)
  const a=await mailbox(alice,clock).open(),b=await mailbox(bob,clock).open()
  let h=await storage.open()
  const participants={[alice]:a,[bob]:b,[helper]:h}
  async function deliver(from){
    const sender=participants[from]
    for(const job of sender.jobs()){
      await participants[job.peer].receive(job.rumor,from,from)
      await sender.handed(job.rumor.id)
    }
  }
  for(const book of Object.values(participants))await book.action({op:'enable',enabled:true})
  await a.action({op:'share',helper,side:'request',summary:'Looking for a cargo bike'})
  await b.action({op:'share',helper,side:'offer',summary:'Used cargo bike'})
  await deliver(alice);await deliver(bob)
  h=participants[helper]=await storage.open()
  const [left,right]=Object.keys(h.view().received)
  const listing={id:'30402:'+bob+':bike',author:bob,title:'Cargo bike',side:'offer'}
  assert.deepEqual(matchCandidates(h.view(),left,[listing],clock.at).map(r=>r.id).sort(),[right,listing.id].sort())
  await h.action({op:'suggest',left,right})
  for(const job of h.jobs()){
    const wire=JSON.parse(job.rumor.tags.find(t=>t[0]==='iris-market/private-match')[2])
    assert.equal(wire.op,'suggest')
    assert.ok(!JSON.stringify(wire).includes(job.peer===alice?bob:alice))
  }
  await deliver(helper)
  const [proposal]=Object.keys(a.view().interests)
  await a.action({op:'vote',proposal,accept:true});await deliver(alice)
  await assert.rejects(h.action({op:'introduce',proposal}))
  assert.equal(a.view().interests[proposal].contact,null)
  await b.action({op:'vote',proposal,accept:true});await deliver(bob)
  await h.action({op:'introduce',proposal});await deliver(helper)
  assert.equal(a.view().interests[proposal].contact,bob)
  assert.equal(b.view().interests[proposal].contact,alice)
  clock.at+=7*86400
  assert.deepEqual((await storage.open()).view().received,{})
})

test('withdrawal survives restart and prevents a delayed share from resurfacing',async()=>{
  const clock={at:1000},storage=mailbox(helper,clock),a=await mailbox(alice,clock).open()
  let h=await storage.open()
  for(const book of [a,h])await book.action({op:'enable',enabled:true})
  await a.action({op:'share',helper,side:'offer',summary:'Cargo bike'})
  const share=a.jobs()[0].rumor
  await a.handed(share.id)
  await a.action({op:'withdraw',entry:Object.keys(a.view().sent)[0]})
  await h.receive(a.jobs()[0].rumor,alice,alice)
  h=await storage.open()
  await h.receive(share,alice,alice)
  assert.deepEqual(h.view().received,{})
})

test('an unsent summary is recalled on withdrawal and pending entries stay with the account',async()=>{
  const saved=new Map()
  const vault={get:async key=>structuredClone(saved.get(key)),put:async(key,value)=>saved.set(key,structuredClone(value))}
  const open=async owner=>{
    const book=createMatchBook(vault,owner,owner,()=>{},()=>{},()=>1000)
    await book.load()
    return book
  }
  const a=await open(alice)
  await a.action({op:'enable',enabled:true})
  await a.action({op:'share',side:'request',helper,summary:'Private bike request'})
  assert.equal((await open(bob)).view(),null)
  await a.action({op:'withdraw',entry:Object.keys(a.view().sent)[0]})
  const restored=await open(alice)
  assert.deepEqual(restored.view().sent,{})
  assert.deepEqual(restored.jobs().map(j=>JSON.parse(j.rumor.tags.at(-1)[2]).op),['withdraw'])
})

test('introductions connect per-match aliases, never the accounts',async()=>{
  const {generateSecretKey,getPublicKey,matchFilters}=await import('nostr-tools')
  const {HELLO}=await import('../src/private-match/aliases.ts')
  const people=['seeker','offerer','helper'].map(()=>{const secret=generateSecretKey();return {secret,owner:getPublicKey(secret)}})
  const books=[],stores=[]
  for(const {secret,owner} of people){
    const store={saved:undefined};stores.push(store)
    const vault={get:async()=>structuredClone(store.saved),put:async(_,v)=>{store.saved=structuredClone(v)}}
    const book=createMatchBook(vault,owner,owner,()=>{},()=>{},undefined,()=>Uint8Array.from(secret))
    await book.load();books.push(book)
  }
  const [a,b,h]=books,[seeker,offerer,helperKey]=people.map(p=>p.owner)
  const byOwner=new Map(people.map((p,i)=>[p.owner,books[i]])),wires=[],published=[]
  async function deliver(book,from){
    for(const job of book.jobs()){
      wires.push(JSON.parse(job.rumor.tags.find(t=>t[0]==='iris-market/private-match')[2]))
      await byOwner.get(job.peer).receive(job.rumor,from,from);await book.handed(job.rumor.id)
    }
  }
  // Like relays: keep events and replay them to each matching subscription.
  async function relay(){
    for(let round=0;round<20;round++){
      let fresh=0
      for(const book of books)for(const job of book.aliasJobs()){published.push(job.event);await book.aliasPublished(job.event.id);fresh++}
      const before=JSON.stringify(books.map(x=>x.aliasChats()))
      for(const event of published)for(const book of books)if(book.aliasFilters().some(s=>matchFilters([s.filter],event)))await book.aliasReceive(event)
      if(!fresh&&before===JSON.stringify(books.map(x=>x.aliasChats())))return
    }
    throw Error('relay did not settle')
  }
  for(const book of books)await book.action({op:'enable',enabled:true})
  await a.action({op:'share',helper:helperKey,side:'request',summary:'Looking for a cargo bike'})
  await b.action({op:'share',helper:helperKey,side:'offer',summary:'Offering a two-seat cargo bike'})
  await deliver(a,seeker);await deliver(b,offerer)
  const [left,right]=Object.keys(h.view().received)
  await h.action({op:'suggest',left,right});await deliver(h,helperKey)
  const [proposal]=Object.keys(a.view().interests),chat='match:'+proposal
  await a.action({op:'vote',proposal,accept:true});await deliver(a,seeker)
  await b.action({op:'vote',proposal,accept:true});await deliver(b,offerer)
  assert.ok(!JSON.stringify(h.view()).includes('invite'),'helper view exposes no invitations')
  await h.action({op:'introduce',proposal});await deliver(h,helperKey)
  await relay()
  for(const book of [a,b]){
    const interest=book.view().interests[proposal]
    assert.equal(interest.chat,chat);assert.equal(interest.contact,null)
    const [thread]=book.aliasChats()
    assert.equal(thread.id,chat);assert.equal(thread.connected,true)
    assert.equal(thread.messages[0].text,HELLO)
  }
  await b.aliasSend(chat,'It is still available');await a.aliasSend(chat,'Great, thanks')
  await relay()
  for(const book of [a,b]){
    const texts=book.aliasChats()[0].messages.map(m=>m.text)
    assert.ok(texts.includes('It is still available')&&texts.includes('Great, thanks'),texts.join('|'))
    assert.ok(book.aliasChats()[0].messages.every(m=>!m.mine||m.delivery==='sent'))
  }
  for(const [book,other] of [[a,offerer],[b,seeker]])
    assert.ok(!JSON.stringify({view:book.view(),chats:book.aliasChats()}).includes(other),'no account is revealed')
  for(const w of wires.filter(w=>w.op==='introduce'))assert.ok(![seeker,offerer].includes(w.contact))
  for(const event of published)for(const owner of [seeker,offerer,helperKey]){
    assert.notEqual(event.pubkey,owner);assert.ok(!JSON.stringify(event).includes(owner))
  }
  // Nobody keeps an invitation after using or forwarding it.
  for(const store of stores)assert.ok(!JSON.stringify(store.saved.interests).includes('invite#')&&!JSON.stringify(store.saved.pairs).includes('invite#'))
  assert.equal(a.view().interests[proposal].connected,true)

  // Showing a profile is explicit, signed by the profile key and bound to this chat.
  const {finalizeEvent}=await import('nostr-tools')
  const forged=finalizeEvent({...a.revealDraft(proposal),tags:[['alias',getPublicKey(generateSecretKey())],['p',getPublicKey(generateSecretKey())]]},people[0].secret)
  await assert.rejects(a.aliasReveal(proposal,forged),/not for this chat/)
  await a.aliasReveal(proposal,finalizeEvent(a.revealDraft(proposal),people[0].secret))
  await relay()
  assert.equal(b.view().interests[proposal].revealed,seeker)
  assert.equal(b.view().interests[proposal].shared_profile,false)
  assert.equal(a.view().interests[proposal].shared_profile,true)
  assert.equal(a.view().interests[proposal].revealed,null)
  assert.equal(b.aliasChats()[0].messages.at(-1).text,'Shared their profile')
  assert.equal(a.aliasChats()[0].messages.at(-1).text,'You shared your profile')
  assert.throws(()=>a.revealDraft(proposal),/ended/)
  for(const event of published)assert.ok(!JSON.stringify(event).includes(seeker))
})

test('a reveal names an account only when bound to both aliases of the chat',async()=>{
  const {generateSecretKey,getPublicKey,finalizeEvent}=await import('nostr-tools')
  const {revealOwner,REVEAL_KIND}=await import('../src/private-match/aliases.ts')
  const owner=generateSecretKey(),from=getPublicKey(generateSecretKey()),to=getPublicKey(generateSecretKey()),other=getPublicKey(generateSecretKey())
  const at=Math.floor(Date.now()/1000)
  const sign=(tags,kind=REVEAL_KIND,key=owner)=>finalizeEvent({kind,created_at:at,content:'',tags},key)
  assert.equal(revealOwner(sign([['alias',from],['p',to]]),from,to),getPublicKey(owner))
  assert.equal(revealOwner(JSON.stringify(sign([['p',to],['alias',from]])),from,to),getPublicKey(owner))
  assert.equal(revealOwner(sign([['alias',from],['p',to]]),to,from),null)
  assert.equal(revealOwner(sign([['alias',from],['p',other]]),from,to),null)
  assert.equal(revealOwner(sign([['alias',from],['p',to]]),undefined,to),null)
  assert.equal(revealOwner(sign([['alias',from],['p',to]],1),from,to),null)
  assert.equal(revealOwner(sign([['alias',from],['p',to],['x','y']]),from,to),null)
  assert.equal(revealOwner({...sign([['alias',from],['p',to]]),pubkey:other},from,to),null)
})

test('helpers refuse to introduce an alias to an account',async()=>{
  const {generateSecretKey,getPublicKey}=await import('nostr-tools')
  const secret=generateSecretKey(),me=getPublicKey(secret)
  let saved
  const vault={get:async()=>structuredClone(saved),put:async(_,v)=>{saved=structuredClone(v)}}
  const withAlias=createMatchBook(vault,me,me,()=>{},()=>{},undefined,()=>Uint8Array.from(secret))
  await withAlias.load()
  const h=await mailbox(helper,{at:Math.floor(Date.now()/1000)}).open()
  const legacy=createMatchBook({get:async()=>undefined,put:async()=>{}},bob,bob,()=>{},()=>{})
  await legacy.load()
  const byKey={[me]:withAlias,[bob]:legacy,[helper]:h}
  const deliver=async(book,from)=>{for(const job of book.jobs()){await byKey[job.peer].receive(job.rumor,from,from);await book.handed(job.rumor.id)}}
  for(const book of [withAlias,legacy,h])await book.action({op:'enable',enabled:true})
  await withAlias.action({op:'share',helper,side:'request',summary:'Looking for a cargo bike'})
  await legacy.action({op:'share',helper,side:'offer',summary:'Cargo bike'})
  await deliver(withAlias,me);await deliver(legacy,bob)
  const [left,right]=Object.keys(h.view().received)
  await h.action({op:'suggest',left,right});await deliver(h,helper)
  const [proposal]=Object.keys(withAlias.view().interests)
  await withAlias.action({op:'vote',proposal,accept:true});await deliver(withAlias,me)
  await legacy.action({op:'vote',proposal,accept:true});await deliver(legacy,bob)
  await assert.rejects(h.action({op:'introduce',proposal}),/update Iris Market/)
})
