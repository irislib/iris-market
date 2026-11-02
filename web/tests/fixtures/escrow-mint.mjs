// Peer wallet for the Rust escrow test. All funds and keys are local fixtures.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {Mint, Wallet, SigAll, decodePaymentRequest, getEncodedToken} from '@cashu/cashu-ts';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {startLocalTestMint} from '../../scripts/demo/local-mint.ts';

const local = await startLocalTestMint();
const origin = 'https://mint.example';
const input = createInterface({input:process.stdin})[Symbol.asyncIterator]();
const keys = Array.from({length:3}, () => randomBytes(32));
const publicKeys = keys.map(key => Buffer.from(secp256k1.getPublicKey(key)).toString('hex'));
try {
  // Give the SDK the same agreed HTTPS identity as Rust. All requests go to this child mint.
  const fetchLocal = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url);
    assert.equal(u.origin, origin);
    return fetchLocal(local.url + u.pathname + u.search, init);
  };
  const wallet = new Wallet(new Mint(origin), {unit:'sat'});
  await wallet.loadMint();
  console.log(JSON.stringify({endpoint:local.url, publicKeys}));
  const request = decodePaymentRequest((await input.next()).value);
  const invoice = await wallet.createMintQuoteBolt11(256);
  const deadline = Date.now() + 20000;
  while ((await wallet.checkMintQuoteBolt11(invoice.quote)).state !== 'PAID') {
    assert.ok(Date.now() < deadline, 'Fixture mint did not pay its fake invoice');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const coins = await wallet.mintProofsBolt11(256, invoice);
  const {send} = await wallet.ops.sendToRequest(request, coins).run();
  console.log(JSON.stringify({token:getEncodedToken({mint:origin, unit:'sat', proofs:send})}));
  assert.equal((await input.next()).value, 'release');
  const payout = new Wallet(new Mint(origin), {unit:'sat'});
  await payout.loadMint();
  const tx = await payout.prepareSwapToReceive(send, {requireDleq:true});
  const sign = (pkg, n) => SigAll.signPackage(pkg, keys[n].toString('hex'));
  const one = sign(SigAll.extractSwapPackage(tx), 0);
  await assert.rejects(payout.completeSwap(SigAll.mergeSwapPackage(one, tx)));
  const two = sign(one, 1);
  const {keep} = await payout.completeSwap(SigAll.mergeSwapPackage(two, tx));
  console.log(JSON.stringify({received:keep.reduce((sum,p) => sum + p.amount.toNumber(),0)}));
  await input.next(); // Rust rechecks the spent inputs before closing stdin.
} finally { await local.close(); }
