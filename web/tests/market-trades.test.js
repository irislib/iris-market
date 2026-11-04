import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventHash} from 'nostr-tools';
import {createMarketTrades, TRADE_TAG} from '../src/messaging/market-trades.ts';

const id = n => n.toString(16).padStart(64, '0');
const buyer=id(1), seller=id(2), provider=id(3), outsider=id(4), localDevice=id(5);
const trade=id(9), deposit='locked-private-token';
const deal={buyer,seller,provider,maker:seller,taker:buyer,funder:buyer,beneficiary:seller,
  revision:id(7),listing_id:seller+':quote',title:'Coffee',mint:'https://mint.example',sats:10};
const dealHash=await globalThis.IrisEscrow.hash(deal);
let nextId=1000;
const step=(action,more={})=>({v:1,trade_id:trade,action,...more});
const invite=step('invite',{deal}), join=step('join',{deal_hash:dealHash,key:'02'+id(6)});
const funded=step('funded',{deal_hash:dealHash,terms_hash:id(12),token:deposit});
function message(step,sender=buyer,operation=id(nextId++),recipient=seller,options={}) {
  const rumor={kind:14,pubkey:sender,created_at:1700000000,content:'Private escrow update',
    tags:[['p',recipient],[TRADE_TAG,'1',operation,JSON.stringify(step)]],...options};
  return {...rumor,id:getEventHash(rumor)};
}
function wallet() {
  const records=new Map();
  return {records,writes:0,fail:false,
    get:async key=>structuredClone(records.get(key)),
    async putMany(entries){if(this.fail)throw Error('Disk full');this.writes++;for(const [key,value] of entries)records.set(key,structuredClone(value));},
    async put(key,value){if(this.fail)throw Error('Disk full');this.writes++;records.set(key,structuredClone(value));}
  };
}
const open=(vault,owner=seller)=>createMarketTrades(vault,owner,localDevice,()=>{});
const receive=(book,s,sender=buyer,op)=>book.receive(message(s,sender,op),sender,sender);

test('local join pins the canonical invitation, known sender roles and pre-join message size', async()=>{
  const db=wallet(), book=open(db);
  await book.load();
  // NDR may deliver the provider's key before the taker's invitation.
  await receive(book,join,provider);
  await receive(book,funded);
  await receive(book,step('join',{key:'a'.repeat(4096)}),provider);
  await receive(book,step('invite',{deal:{...deal,provider:seller}}));
  await receive(book,step('invite',{deal:{...deal,buyer:outsider,taker:outsider,funder:outsider}}));
  await receive(book,step('invite',{deal:{...deal,buyer,seller:outsider,maker:outsider,beneficiary:outsider}}));
  assert.equal(book.rows(true).length,1);
  await receive(book,invite);
  await receive(book,funded);
  assert.equal(book.rows(true).length,2);
  const op=id(nextId++);
  await book.send([buyer,provider],join,op);
  await receive(book,funded,outsider);
  await receive(book,funded,provider);
  await receive(book,{...funded,deal_hash:id(77)});
  await receive(book,step('invite',{deal:{...deal,taker:provider}}),provider);
  assert.equal(book.rows(true).length,4);
  const op2=id(nextId++);
  await receive(book,funded,buyer,op2);
  const writes=db.writes;
  await receive(book,{...invite,trade_id:id(911)},buyer,op2);
  await receive(book,{...funded,other:1},buyer,op2);
  await receive(book,{token:deposit,terms_hash:id(12),deal_hash:dealHash,action:'funded',trade_id:trade,v:1},buyer);
  assert.equal(book.rows(true).length,5);
  assert.equal(db.writes,writes);
  assert.ok(book.rows(true).some(r=>r.step.token===deposit));
  assert.ok(!JSON.stringify(book.rows(false)).includes(deposit));
  const reloaded=open(db);
  await reloaded.load();
  assert.deepEqual(reloaded.rows(true),book.rows(true));
  await reloaded.send([provider,buyer],join,op);
  assert.equal(reloaded.jobs().length,2);
  await assert.rejects(reloaded.send([buyer],join,op),/already belongs/);
  const another=open(db,outsider);await another.load();
  assert.deepEqual(another.rows(true),[]);
});

test('unsolicited offers have bounded storage, oldest local arrival eviction and two variation buckets',async()=>{
  const db=wallet(),book=open(db);
  await receive(book,invite);await book.send([buyer,provider],join,id(nextId++));
  for(let i=0;i<131;i++){
    const s={...join,trade_id:id(i+100)};
    await receive(book,s,outsider);
  }
  assert.equal(book.rows(true).length,128+3);
  assert.ok(!book.rows(true).some(r=>r.step.trade_id===id(100)));
  assert.ok(book.rows(true).some(r=>r.step.action==='invite'&&r.step.trade_id===trade));
  for(const [i,dir] of ['release','random','random2','refund','refund','refund'].entries()) {
    await receive(book,step('cosign',{direction:dir,deal_hash:dealHash,swap:{version:i}}),provider);
  }
  assert.deepEqual(book.rows(true).filter(r=>r.step.action==='cosign').map(r=>r.step.direction),['release','random','refund','refund']);
});

test('invalid envelopes and over-size actions do not modify the journal; failed persistence leaves no partial fanout',async()=>{
  const db=wallet(),book=open(db);
  for(const rumor of [
    {...message(invite),id:id(66)},message(invite,buyer,id(31),outsider),
    message(invite,buyer,id(32),seller,{created_at:-7}),
    message(invite,buyer,id(33),seller,{created_at:Math.floor(Date.now()/1000)+500}),
    message(invite,buyer,id(34),seller,{tags:[['p',seller],['p',outsider],[TRADE_TAG,'1',id(30),JSON.stringify(invite)]]}),
    message(invite,buyer,id(35),seller,{tags:[['p',seller],[TRADE_TAG,'1',id(30),'{']]})
  ]) assert.equal(await book.receive(rumor,buyer,buyer),true);
  assert.equal(await book.receive(message(invite),buyer,provider),true); // Owner signature is allowed for its authorized device.
  assert.equal(book.rows(true).length,1);
  await book.receive(message(invite),outsider,outsider);
  await assert.rejects(book.send([provider],{...join,content:'z'.repeat(65536)},id(nextId++)),/Invalid escrow/);
  await assert.rejects(book.send([provider,provider],join,id(nextId++)),/Invalid escrow/);
  assert.equal(book.jobs().length,0);
  db.fail=true;const op=id(nextId++);
  await assert.rejects(book.send([buyer,provider],join,op),/Disk full/);
  assert.equal(book.jobs().length,0);assert.equal(book.rows(true).length,1);
  db.fail=false;await book.send([buyer,provider],join,op);
  await book.handed(book.jobs()[0].rumor.id);assert.equal(book.jobs().length,1);
  db.fail=true;
  await assert.rejects(receive(book,funded),/Disk full/);
  assert.equal(book.rows(true).length,3);
});

test('safe settings projection copies only bounded strings and positive integer sats from legacy invitations',async()=>{
  const db=wallet(),book=open(db),legacy='market/private-trade-tools/v1';
  const damaged={...deal,maker:42,price:{secret:'secret-token'},title:'é'.repeat(1025),listing_id:[],sats:'10',token:deposit};
  db.records.set('market/account',{owner:seller});
  const row=(step,i)=>({id:id(i+41),operation_id:id(i+51),mine:false,peer:buyer,created_at:1,step});
  const rows=[row(step('invite',{deal:damaged}),0),row(step('invite',{deal:{...damaged,sats:10}}),1),row(step('invite',{deal:{...damaged,sats:1.2}}),2)];
  const otherJob={peer:buyer,rumor:message(invite,buyer,id(852),seller,{tags:[['p',seller],['another-private-operation','1']]})};
  const separate={allowed:[buyer],jobs:[otherJob]};
  db.records.set(legacy,{v:1,rows,...separate});
  await book.load();
  const projected=book.rows(false);
  assert.equal(projected[1].step.deal.sats,10);
  assert.equal(projected[0].step.deal.sats,undefined);
  assert.equal(projected[2].step.deal.sats,undefined);
  for(const row of projected)for(const field of ['token','price','maker','title','listing_id'])assert.equal(row.step.deal[field],undefined);
  db.records.set(legacy,{v:1,rows:null,jobs:[]});
  await assert.rejects(book.load(),/invalid/);
  assert.deepEqual(book.rows(false),projected);
  db.records.set(legacy,{v:1,rows,...separate});
  db.fail=true;await assert.rejects(book.send([buyer],join,id(nextId++)),/Disk full/);
  assert.equal(db.records.get(legacy).rows.length,3);
  db.fail=false;await book.send([buyer],join,id(nextId++));
  assert.deepEqual(db.records.get(legacy),{v:1,rows:[],...separate});
  assert.equal(book.jobs().length,1);
  const again=open(db);await again.load();assert.equal(again.rows(true).length,4);
});

test('inbox receipt hints require the intended recipient and an independent authorized signature',async()=>{
  const book=open(wallet());await book.load();await receive(book,invite);
  const send=s=>book.send([buyer,provider],s,id(nextId++));
  await send(join);
  const terms={deal_hash:dealHash,terms_hash:funded.terms_hash};
  await send(step('approve',terms));await receive(book,funded);
  const refund={...terms,direction:'refund'};
  await receive(book,step('payout',refund));
  await receive(book,step('settled',refund),provider);
  const card=()=>globalThis.IrisEscrow.list(book.rows(false),seller)[0];
  assert.equal(card().status,'In progress');
  await receive(book,step('cosign',refund),provider);
  assert.equal(card().status,'In progress');
  await send(step('dispute',terms));
  assert.equal(card().status,'Help requested');
  await receive(book,step('settled',refund));
  assert.equal(card().status,'Refund receipt');
  assert.equal(card().deal.sats,10);
});

test('room messages require all three joined profiles, use the two exact private recipients and stay out of inbox summaries',async()=>{
  const book=open(wallet());await book.load();await receive(book,invite);
  await book.send([buyer,provider],join,id(nextId++));
  const comment=step('comment',{deal_hash:dealHash,message_id:id(16),text:'Meet by the entrance.'});
  await assert.rejects(book.send([buyer,provider],comment,id(nextId++)),/discussion/);
  await receive(book,join,buyer);await receive(book,join,provider);
  await assert.rejects(book.send([buyer,outsider],comment,id(nextId++)),/discussion/);
  await book.send([provider,buyer],comment,id(nextId++));
  for(let n=0;n<4;n++)await receive(book,{...comment,message_id:id(160+n),text:'Reply '+n},provider);
  await receive(book,comment,outsider);
  const messages=book.rows(true).filter(r=>r.step.action==='comment');
  assert.equal(messages.length,6);assert.ok(!messages.some(m=>m.peer===outsider));
  assert.ok(!JSON.stringify(book.rows(false)).includes('entrance'));
});

test('declines bind the invited role and exact agreement even before the recipient joins',async()=>{
  const book=open(wallet());await book.load();await receive(book,invite);
  const action=step('decline',{deal_hash:dealHash});
  await receive(book,action,outsider);await receive(book,{...action,deal_hash:id(12)},provider);
  const card=()=>globalThis.IrisEscrow.list(book.rows(false),seller)[0];
  assert.equal(card().status,'Invitation');
  await receive(book,action,provider);assert.equal(card().status,'Declined');
});
