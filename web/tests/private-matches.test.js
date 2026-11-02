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
