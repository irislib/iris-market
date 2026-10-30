import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {startLocalTestMint} from '../scripts/demo/local-mint.ts';
import {createTestMoney} from '../scripts/demo/test-money.ts';
import {createVault} from '../src/messaging/vault.ts';

const configured=!!process.env.MARKET_DEMO_MINT_BINARY;
async function vault(){let row;const value=createVault({backend:{read:async()=>structuredClone(row),write:async next=>{row=structuredClone(next);}}});await value.create();return value;}
test('local mint requires an explicit executable and digest',async()=>{
  await assert.rejects(startLocalTestMint({binary:'relative',sha256:'0'.repeat(64)}),/require/);
});
test('genuine local CDK mint issues and redeems test Cashu and stops only its child',{skip:!configured,timeout:30000},async()=>{
  const mint=await startLocalTestMint();let sender,receiver;
  try{
    assert.match(mint.url,/^http:\/\/127\.0\.0\.1:\d+$/);
    sender=await createTestMoney({vault:await vault(),mintUrl:mint.url});receiver=await createTestMoney({vault:await vault(),mintUrl:mint.url});
    const grant=await sender.grant('local-cdk-order','128');assert.equal(grant.mint,mint.url);
    const receipt=await receiver.redeem('local-cdk-order',grant.token,'128');assert.equal(receipt.amount,'128');assert.equal(receipt.received,'127');
    await assert.rejects(receiver.redeem('local-cdk-other',grant.token,'128'),/already|replay|spent/i);
  }finally{await sender?.close();await receiver?.close();await mint.close();}
  await assert.rejects(fetch(mint.url+'/v1/info',{signal:AbortSignal.timeout(1000)}));
});
test('local mint refuses another process listener and a wrong binary digest',{skip:!configured},async()=>{
  await assert.rejects(startLocalTestMint({sha256:'0'.repeat(64)}),/digest/);
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(startLocalTestMint({port:listener.address().port}),{code:'EADDRINUSE'});assert.equal(listener.listening,true);}finally{await new Promise(resolve=>listener.close(resolve));}
});
