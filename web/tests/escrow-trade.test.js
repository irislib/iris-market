import test from 'node:test';
import assert from 'node:assert/strict';
import '../../shared/escrow/trade.js';

const E=globalThis.IrisEscrow;
const buyer='1'.repeat(64),seller='2'.repeat(64),provider='3'.repeat(64),id='a'.repeat(64),revision='b'.repeat(64);
const listing={title:'Camera',id:seller+':camera',author:seller,event_id:revision,status:'active',side:'offer',escrow:{trade:'goods'}};
const mint='https://mint.example',key=(n)=>'02'+String(n).repeat(64);
const row=(p,action,params={})=>({peer:p===buyer?seller:p,mine:p===buyer,step:{v:1,trade_id:id,action,...params}});
const d=E.dealFromListing(listing,buyer,provider,mint,50),deal_hash=await E.hash(d);
const terms={mint,sats:50,buyer_key:key(4),seller_key:key(5),provider:{profile:provider,key:key(6),signature:'0'.repeat(128)}};
const terms_hash=await E.hash(terms);
const phases=[row(buyer,'invite',{deal:d}),row(buyer,'join',{deal_hash,key:terms.buyer_key}),row(seller,'join',{deal_hash,key:terms.seller_key}),row(provider,'join',{deal_hash,key:terms.provider.key,provider:terms.provider}),...[buyer,seller,provider].map(p=>row(p,'approve',{deal_hash,terms_hash}))];
const verified=await E.project(phases,id,buyer);
test('the policy pins all three participants and key bindings',()=>{
  assert.deepEqual(verified.terms,terms);
  assert.equal(verified.approved.size,3);
  assert.equal(verified.token,undefined);
});
test('bitcoin trades reverse who pays and bind the signed fiat quote and sats',async()=>{
  const bitcoin={...listing,price:'10.00',currency:'EUR',escrow:{trade:'bitcoin_fiat',sats:1000,method:'bank_transfer'}};
  const offer=E.dealFromListing(bitcoin,buyer,provider,mint,1000);
  assert.equal(offer.funder,seller);
  assert.deepEqual(offer.fiat,{price:'10.00',currency:'EUR',method:'bank_transfer'});
  await E.exactListing(async()=>bitcoin,offer);
  await assert.rejects(E.exactListing(async()=>bitcoin,{...offer,fiat:{...offer.fiat,currency:'USD'}}),/listing changed/);
  const {fiat,...legacy}=offer;
  await E.exactListing(async()=>bitcoin,legacy);
  assert.throws(()=>E.dealFromListing(bitcoin,buyer,provider,mint,100));
  assert.throws(()=>E.dealFromListing({...bitcoin,status:'closed'},buyer,provider,mint,1000));
});
test('borrowed trade IDs and counterparty assertions cannot fund another proposal',async()=>{
  const foreign='d'.repeat(64),injected=[row(foreign,'funded',{deal_hash,terms_hash,token:'stolen'}),row(seller,'funded',{deal_hash,terms_hash,token:'stolen'}),row(buyer,'funded',{deal_hash,terms_hash:'e'.repeat(64),token:'stolen'})];
  assert.equal((await E.project([...phases,...injected],id,buyer)).token,undefined);
  assert.equal((await E.project([...phases.slice(0,-1),row(buyer,'funded',{deal_hash,terms_hash,token:'locked'})],id,buyer)).token,undefined);
  await assert.rejects(E.project([...phases,row(seller,'join',{deal_hash,key:key(7)})],id,buyer),/Conflicting/);
});
test('release requires beneficiary package; provider needs a dispute; receipt must come from the recipient',async()=>{
  const base=[...phases,row(buyer,'funded',{deal_hash,terms_hash,token:'locked'})];
  const args={deal_hash,terms_hash,direction:'release',swap:{inputs:[{}],outputs:[{}]}};
  const forged=await E.project([...base,row(buyer,'payout',args)],id,buyer);assert.equal(forged.payouts.release,undefined);
  const offers=[...base,row(seller,'payout',args),row(provider,'cosign',args)];
  assert.equal((await E.project(offers,id,buyer)).cosigns.release.length,0);
  const disputed=[...offers,row(buyer,'dispute',{deal_hash,terms_hash})];
  assert.equal((await E.project(disputed,id,buyer)).cosigns.release.length,1);
  assert.equal((await E.project([...disputed,row(provider,'settled',args)],id,buyer)).settled.release,false);
  assert.equal((await E.project([...disputed,row(seller,'settled',args)],id,buyer)).settled.release,true);
});
test('starting or funding uses the verified current revision',async()=>{
  await assert.rejects(E.exactListing(async()=>({...listing,event_id:'e'.repeat(64)}),d),/listing changed/);
  await E.exactListing(async()=>listing,d);
});

test('provider search separates advertised services, mutual follows and ordinary contacts',()=>{
  const known=[{id:buyer,name:'Robin'},{id:seller,name:'Robin'}, {id:'c'.repeat(64),name:'Robin A',contact:true},
    {id:provider,name:'Robin B',advertised:true}, {id:'d'.repeat(64),name:'Robin C',mutual:true}];
  assert.deepEqual(E.candidates(known,buyer,seller,'  ROBIN ').map(p=>p.name),['Robin B','Robin C','Robin A']);
  assert.deepEqual(E.candidates(known,buyer,seller,'d'.repeat(12)).map(p=>p.name),['Robin C']);
  assert.deepEqual(E.candidates(known,buyer,seller,'unknown'),[]);
});

test('traders check the exact private order before joining, approving or funding',async()=>{
  const order_id=buyer+':00000000-0000-4000-8000-000000000001',linked={...d,order_id,quantity:2};
  const order={id:order_id,buyer,seller,listing_id:listing.id,provider,trade_id:id,quantity:2,status:'requested'};
  E.validateDeal(linked);
  await E.exactListing(async()=>listing,linked);
  await E.exactOrder(async()=>order,buyer,id,linked);
  for(const wrong of [{provider:seller},{seller:provider},{quantity:1},{trade_id:revision},{listing_id:'other'},{status:'cancelled'}])
    await assert.rejects(E.exactOrder(async()=>({...order,...wrong}),seller,id,linked));
  await E.exactOrder(()=>assert.fail('Provider must never fetch private order details'),provider,id,linked);
  await E.exactOrder(()=>assert.fail('Legacy agreements do not require an order'),seller,id,d);
});

test('only a participant can decline, and a late decline never strands an approved payment',async()=>{
  const rogue=row('c'.repeat(64),'decline',{deal_hash});
  const decline=row(provider,'decline',{deal_hash});
  const pending=phases.slice(0,3);
  assert.equal((await E.project([...pending,rogue],id,buyer)).declined,undefined);
  assert.equal((await E.project([...pending,decline],id,buyer)).declined,provider);
  const t=await E.project([...phases,decline,row(buyer,'funded',{deal_hash,terms_hash,token:'locked'})],id,buyer);
  assert.equal(t.declined,undefined);assert.equal(t.token,'locked');
});

test('the trade discussion deduplicates both local recipients and filters unrelated senders and deals',async()=>{
  const message={deal_hash,message_id:'9'.repeat(64),text:'Friday pickup?'};
  const own=row(buyer,'comment',message), outsider=row('8'.repeat(64),'comment',message);
  const other=row(provider,'comment',{...message,deal_hash:id,text:'Other trade'});
  const records=[...phases,own,own,outsider,other];
  assert.deepEqual((await E.project(records,id,buyer)).messages.map(m=>[m.author,m.text]),[[buyer,'Friday pickup?']]);
});

test('merchant consents to both the named provider and order before announcing a join',async()=>{
  const order_id=buyer+':10000000-0000-4000-8000-000000000001',linked={...d,order_id,quantity:1};
  const order={id:order_id,buyer,seller,listing_id:listing.id,provider,trade_id:id,quantity:1,status:'requested'};
  const actions=[];
  const api=async(method,args)=>{
    actions.push(method);
    if(method==='listing')return listing;
    if(method==='order')return order;
    if(method==='wallet')return {key:key(5)};
    if(method==='acceptOrder'){assert.deepEqual(args,{id:order_id,trade_id:id,provider});order.status='accepted';}
  };
  await assert.rejects(E.exactOrder(api,buyer,id,linked,true),/merchant/);
  await E.join(api,seller,{id,d:linked,dealHash:await E.hash(linked)});
  assert.equal(order.status,'accepted');
  assert.deepEqual(actions.slice(-2),['acceptOrder','send']);
  await E.exactOrder(api,buyer,id,linked,true);
  await E.join(api,seller,{id,d:linked,dealHash:await E.hash(linked)});
  assert.equal(actions.filter(a=>a==='acceptOrder').length,1);
});
