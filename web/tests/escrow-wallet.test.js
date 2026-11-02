import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getPubKeyFromPrivKey, schnorrSignDigest } from '@cashu/cashu-ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { createVault } from '../src/messaging/vault.ts';
import { createCashuWallet } from '../src/wallet/client.ts';
import { startLocalTestMint } from '../scripts/demo/local-mint.ts';

const context='iris-market/escrow-provider/cashu-2of3-v1\0';
function backend(){
  let row;
  return {read:async()=>structuredClone(row),write:async(next,expected)=>{
    assert.equal(row?.version||0,expected);
    row=structuredClone(next);
  }};
}
function openWallet(mint,db=backend()){
  return createCashuWallet({developerMint:mint,allowedMints:[mint],vault:createVault({backend:db})});
}
test('Iris wallets fund, co-sign, recover and spend a Cashu escrow payout or refund', {
  skip: !process.env.MARKET_DEMO_MINT_BINARY && 'requires the pinned local test mint',
},async()=>{
  const mint=await startLocalTestMint();
  const fetchLocal=globalThis.fetch;
  let loseResponse=false, disconnectBeforeSwap=false, swaps=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).origin,mint.url);
    if(String(url).endsWith('/v1/swap')){
      if(disconnectBeforeSwap){disconnectBeforeSwap=false;throw Error('Test offline before submitting escrow payment');}
      swaps++;
    }
    const response=await fetchLocal(url,options);
    if(loseResponse && String(url).endsWith('/v1/swap') && response.ok){
      loseResponse=false; await response.body?.cancel(); throw Error('Test lost the successful mint response');
    }
    return response;
  };
  try{
    const buyerStore=backend(), sellerStore=backend();
    let buyer=openWallet(mint.url,buyerStore), seller=openWallet(mint.url,sellerStore);
    const provider=openWallet(mint.url);
    for(const wallet of [buyer,seller,provider])await wallet.enable({mintUrl:mint.url});
    const invoice=await buyer.createInvoice(256);
    const until=Date.now()+10000;
    while(buyer.state().balance==='0'){
      assert.ok(Date.now()<until,'Local test top-up timed out');
      await new Promise(r=>setTimeout(r,100));
      await buyer.checkInvoice(invoice.id);
    }
    for(const direction of ['release','refund']){
      const trade_id=randomBytes(32).toString('hex'), key=w=>w.escrow({op:'key',trade_id}).then(r=>r.key);
      const buyer_key=await key(buyer), seller_key=await key(seller), providerKey=await key(provider);
      const identity=randomBytes(32);
      const profile=Buffer.from(getPubKeyFromPrivKey(identity)).toString('hex').slice(2);
      const signature=schnorrSignDigest(sha256(Buffer.concat([Buffer.from(context),Buffer.from(providerKey,'hex')])),identity);
      const terms={mint:mint.url,sats:31,buyer_key,seller_key,provider:{key:providerKey,profile,signature}};
      const act=async(wallet,op,more={})=>{try{return await wallet.escrow({op,trade_id,terms,direction,...more});}catch(error){error.message=op+' '+error.message;throw error;}};
      assert.deepEqual(await act(buyer,'recover_funding'),{token:null});
      const quote=await act(buyer,'preview_fund');
      const before=Number(buyer.state().balance);
      disconnectBeforeSwap=true;
      await assert.rejects(act(buyer,'fund',{max_fee:quote.fee}));
      const priorSwaps=swaps;
      assert.equal((await buyer.recover('escrow-fund-'+trade_id)).state,'pending');
      assert.deepEqual(await act(buyer,'recover_funding'),{token:null});
      assert.equal(swaps,priorSwaps);
      loseResponse=true;
      await assert.rejects(act(buyer,'fund',{max_fee:quote.fee}));
      await buyer.destroy(); buyer=openWallet(mint.url,buyerStore);await buyer.restore();
      const {token}=await act(buyer,'recover_funding');
      assert.equal(before-Number(buyer.state().balance),quote.max_total);
      assert.equal((await act(buyer,'fund',{max_fee:quote.fee})).token,token);
      const fundingId='escrow-fund-'+trade_id;
      assert.equal(buyer.state().history.find(row=>row.id===fundingId).escrow,'funding');
      assert.equal(buyer.state().history.find(row=>row.id===fundingId).canReclaim,false);
      assert.ok(!('token' in await buyer.recover(fundingId)));
      await assert.rejects(buyer.getToken(fundingId),/Open the trade/);
      await assert.rejects(buyer.previewReclaimToken(fundingId),/ordinary/);
      const {amount}=await act(seller,'check',{token});
      assert.ok(amount>=31);
      const recipient=direction==='release'?seller:buyer, signer=direction==='release'?buyer:provider;
      const recipient_key=await key(recipient);
      const prior=Number(recipient.state().balance);
      const {swap}=await act(recipient,'prepare',{token});
      assert.ok(!JSON.stringify(swap).includes('blinding'));
      assert.deepEqual((await act(recipient,'prepare',{token})).swap,swap);
      await assert.rejects(act(recipient,'complete',{token,swap}),/Two signatures/);
      const mutated=structuredClone(swap);mutated.outputs[0].B_=providerKey;
      await assert.rejects(act(signer,'cosign',{token,swap:mutated,recipient_key}));
      await assert.rejects(act(signer,'cosign',{token,swap,recipient_key:await key(signer)}));
      const signed=(await act(signer,'cosign',{token,swap,recipient_key})).swap;
      assert.deepEqual((await act(signer,'cosign',{token,swap,recipient_key})).swap,signed);
      loseResponse=true;
      await assert.rejects(act(recipient,'complete',{token,swap:signed}));
      await recipient.destroy();
      const reopened=openWallet(mint.url,direction==='release'?sellerStore:buyerStore);await reopened.restore();
      if(direction==='release')seller=reopened;else buyer=reopened;
      assert.equal((await act(reopened,'complete',{token,swap:signed})).received,amount);
      assert.equal((await act(reopened,'complete',{token,swap:signed})).received,amount);
      assert.equal(Number(reopened.state().balance),prior+amount);
      const payout=reopened.state().history.find(row=>row.id==='escrow-claim-'+trade_id);
      assert.equal(payout.escrow,direction==='refund'?'refund':'payout');
      await assert.rejects(act(reopened,'check',{token}),/already spent/);
      const payment=await reopened.previewSend(4), sent=await reopened.send({amount:4,maxFee:payment.fee});
      await provider.receive(sent.token);
    }
  } finally {globalThis.fetch=fetchLocal;await mint.close();}
});
