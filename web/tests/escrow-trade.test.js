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
