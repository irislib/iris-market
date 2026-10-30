import test from 'node:test';
import assert from 'node:assert/strict';
import {createVault} from '../src/messaging/vault.ts';
import {createTestMoney,TEST_MINT} from '../scripts/demo/test-money.ts';
import {createTestMint,TEST_MINT as FIXTURE_MINT} from './fixtures/cashu-mint.mjs';
const vault=async()=>{let row;const v=createVault({backend:{read:async()=>structuredClone(row),write:async r=>{row=structuredClone(r)}}});await v.create({identity:'preserved'});return v;};
test('demo credit is redeemed, bounded, replay protected and idempotent in an existing encrypted actor vault',async t=>{
 const mint=createTestMint({feePpk:1000}),previous=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.ok(url.startsWith(TEST_MINT+'/'));const response=await mint.fetch(url.replace(TEST_MINT,FIXTURE_MINT),options);mint.payInvoices();return response;};
 t.after(()=>{globalThis.fetch=previous;});
 const merchantVault=await vault(),merchant=await createTestMoney({vault:merchantVault}),courier=await createTestMoney({vault:await vault()});
 const grant=await merchant.grant('order-one');assert.equal(grant.amount,'128');assert.equal(grant.mint,TEST_MINT);
 const validationReads=mint.calls.reads;assert.doesNotThrow(()=>courier.validatePayment(grant.token,'128'));assert.throws(()=>courier.validatePayment(grant.token,'64'));assert.equal(mint.calls.reads,validationReads);
 const issued=mint.calls.mints;assert.equal((await merchant.grant('order-one')).token,grant.token);assert.equal(mint.calls.mints,issued);
 await assert.rejects(merchant.grant('order-one','64'));await assert.rejects(merchant.grant('too-big','1025'));
 await assert.rejects(courier.redeem('order-one',grant.token,'64'));
 const receipt=await courier.redeem('order-one',grant.token,'128');assert.equal(receipt.amount,'128');assert.equal(receipt.received,'127');
 const swaps=mint.calls.swaps;assert.equal((await courier.redeem('order-one',grant.token,'128')).receiptId,receipt.receiptId);assert.equal(mint.calls.swaps,swaps);
 await assert.rejects(courier.redeem('order-two',grant.token,'128'));await assert.rejects(courier.redeem('wrong-mint',mint.issueToken(128),'128'));
 assert.equal(await merchantVault.get('identity'),'preserved');await merchant.close();await courier.close();
 const restored=await createTestMoney({vault:merchantVault});assert.equal((await restored.grant('order-one')).token,grant.token);await restored.close();
});

test('local ClosedLoop funds only the configured mint and reuses durable funding on retries',async t=>{
 const {getDecodedToken,getEncodedToken}=await import('@cashu/cashu-ts');
 const local='http://127.0.0.1:3338',mint=createTestMint({feePpk:1000}),previous=globalThis.fetch;let funding;
 globalThis.fetch=(url,options)=>{assert.ok(url.startsWith(local+'/'));return mint.fetch(url.replace(local,FIXTURE_MINT),options);};t.after(()=>{globalThis.fetch=previous;});
 const keysets=await (await mint.fetch(FIXTURE_MINT+'/v1/keysets')).json(),ids=keysets.keysets.map(k=>k.id);
 const actorVault=await vault();const fund=async(orderId,amount)=>{assert.equal(orderId,'local-one');assert.equal(amount,'144');return funding??={token:getEncodedToken({mint:local,unit:'sat',proofs:[...getDecodedToken(mint.issueToken(128),ids).proofs,...getDecodedToken(mint.issueToken(16),ids).proofs]})};};
 const merchant=await createTestMoney({vault:actorVault,mintUrl:local,fund});const first=await merchant.grant('local-one');assert.equal(first.mint,local);await merchant.close();
 const restored=await createTestMoney({vault:actorVault,mintUrl:local,fund});assert.equal((await restored.grant('local-one')).token,first.token);
 const courier=await createTestMoney({vault:await vault(),mintUrl:local});assert.equal((await courier.redeem('local-one',first.token,'128')).received,'127');
 await restored.close();await courier.close();
 await assert.rejects(createTestMoney({vault:await vault(),mintUrl:'http://192.168.1.1:3338'}));
});
