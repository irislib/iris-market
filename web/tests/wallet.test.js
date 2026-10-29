import test from 'node:test';
import assert from 'node:assert/strict';
import { Amount, OutputData, getEncodedToken, getDecodedToken, deserializeProofs } from '@cashu/cashu-ts';
import { createVault } from '../src/messaging/vault.ts';
import { createCashuWallet, DEFAULT_MINT, normalizeMint } from '../src/wallet/client.ts';
import { encryptBackup, decryptBackup } from '../src/wallet/backup.ts';
import { packPreview, unpackPreview } from '../src/wallet/sdk.ts';

const KEYSET = '009a1f293253e41e';
const POINT = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const keys = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [(2n ** BigInt(i)).toString(), POINT]));
const keyset = { id: KEYSET, keys, unit: 'sat', active: true, isActive: true };
const total = proofs => proofs.reduce((a, p) => a + BigInt(p.amount.toString()), 0n);
const proof = (amount, secret = crypto.randomUUID()) => ({ id: KEYSET, amount: Amount.from(amount), secret, C: POINT });
const token = (amount, mint = DEFAULT_MINT) => getEncodedToken({ mint, unit: 'sat', proofs: [proof(amount)] });
function memoryBackend() { let row; return { read: async () => structuredClone(row), write: async (next, expected) => { if ((row?.version || 0) !== expected) throw new Error('Data changed in another tab.'); row = structuredClone(next); } }; }
function mintService() {
  const signatures = new Map(), states = new Map(), mintQuotes = new Map(), meltQuotes = new Map();
  let interruptSwap = false, interruptMint = false, interruptMelt = false, failLoad = false, rejectMelt = false, meltWinsRace = false;
  const calls = { loads: 0, swaps: 0, mints: 0, melts: 0, reserves: 0, quotes: 0, restores: 0 };
  const factory = (mintUrl, { seed, counterSource }) => {
    const outputs = async amount => {
      const denominations = []; for (let n = BigInt(amount.toString()), i = 0n; n; n >>= 1n, i++) if (n & 1n) denominations.push(2n ** i);
      const range = await counterSource.reserve(KEYSET, denominations.length); calls.reserves++;
      return OutputData.createDeterministicData(amount, seed, range.start, keyset, denominations);
    };
    const sign = output => { const signature = { amount: output.blindedMessage.amount, id: KEYSET, C_: output.blindedMessage.B_ }; signatures.set(output.blindedMessage.B_, signature); return output.toProof(signature, keyset); };
    const select = (proofs, amount) => {
      const send = [], keep = []; let balance = 0n;
      for (const input of proofs) if (balance < BigInt(amount.toString())) { send.push(input); balance += BigInt(input.amount.toString()); } else keep.push(input);
      return { send: balance >= BigInt(amount.toString()) ? send : [], keep };
    };
    const checkInputs = inputs => { for (const input of inputs) { if (states.get(input.secret) === 'SPENT') throw new Error('Already spent'); } for (const input of inputs) states.set(input.secret, 'SPENT'); };
    return {
      async loadMint() { calls.loads++; if (failLoad) throw new Error('Offline'); },
      getFeesForProofs: () => Amount.from(0), getFeesToInclude: () => Amount.from(0),
      getKeyset: () => keyset, ensureOperableKeysets: async () => {},
      decodeToken: input => getDecodedToken(input, [KEYSET]),
      selectProofsToSend: select,
      async prepareSwapToReceive(input) { const amount = total(input.proofs); return { inputs: input.proofs, amount: Amount.from(amount), fees: Amount.from(0), keysetId: KEYSET, keepOutputs: await outputs(amount) }; },
      async prepareSwapToSend(amount, proofs) { const { send } = select(proofs, amount); if (!send.length) throw new Error('Insufficient'); return { inputs: send, amount: Amount.from(amount), fees: Amount.from(0), keysetId: KEYSET, sendOutputs: await outputs(amount), keepOutputs: await outputs(total(send) - BigInt(amount.toString())) }; },
      async completeSwap(preview) { calls.swaps++; if (meltWinsRace) { meltWinsRace = false; for(const quote of meltQuotes.values()) if(quote.state === 'UNPAID') quote.state='PAID'; checkInputs(preview.inputs); } checkInputs(preview.inputs); const result = { keep: (preview.keepOutputs || []).map(sign), send: (preview.sendOutputs || []).map(sign) }; if (interruptSwap) { interruptSwap = false; throw new Error('Response interrupted'); } return result; },
      async checkProofsStates(proofs) { return proofs.map(input => ({ state: states.get(input.secret) || 'UNSPENT' })); },
      mint: { async restore({ outputs }) { calls.restores++; const found = outputs.filter(output => signatures.has(output.B_)); return { outputs: found, signatures: found.map(output => signatures.get(output.B_)) }; } },
      async createMintQuoteBolt11(amount) { calls.quotes++; const quote = { quote: crypto.randomUUID(), amount: Amount.from(amount), request: 'lnbc1testinvoice', unit: 'sat', state: 'UNPAID', expiry: Math.floor(Date.now() / 1000) + 3600 }; mintQuotes.set(quote.quote, quote); return quote; },
      async checkMintQuoteBolt11(id) { return mintQuotes.get(id); },
      async prepareMint(method, amount, quote) { return { method, quote, keysetId: KEYSET, outputData: await outputs(amount), payload: { quote: quote.quote } }; },
      async completeMint(preview) { calls.mints++; const quote = mintQuotes.get(preview.quote.quote); if (quote.state !== 'PAID') throw new Error('Not paid'); const result = preview.outputData.map(sign); quote.state = 'ISSUED'; if (interruptMint) { interruptMint = false; throw new Error('Response interrupted'); } return result; },
      async createMeltQuoteBolt11(request) { calls.quotes++; const quote = { quote: crypto.randomUUID(), request, amount: Amount.from(8), fee_reserve: Amount.from(2), unit: 'sat', state: 'UNPAID', expiry: Math.floor(Date.now() / 1000) + 3600 }; meltQuotes.set(quote.quote, quote); return quote; },
      async prepareMelt(method, quote, inputs) { const range = await counterSource.reserve(KEYSET, 1); calls.reserves++; return { method, quote, inputs, keysetId: KEYSET, outputData: [OutputData.createSingleDeterministicData(0, seed, range.start, KEYSET)] }; },
      async completeMelt(preview) { calls.melts++; if(rejectMelt) throw new Error('Expired unpaid payment'); checkInputs(preview.inputs); const quote = meltQuotes.get(preview.quote.quote); quote.state = 'PAID'; quote.change = []; const result = { quote, change: [] }; if (interruptMelt) { interruptMelt = false; throw new Error('Response interrupted'); } return result; },
      async checkMeltQuoteBolt11(id) { return meltQuotes.get(id); },
      createMeltChangeProofs: () => [],
    };
  };
  return { factory, calls, states, mintQuotes, meltQuotes, interruptSwap: () => { interruptSwap = true; }, interruptMint: () => { interruptMint = true; }, interruptMelt: () => { interruptMelt = true; }, failLoad: () => { failLoad = true; }, rejectMelt: () => { rejectMelt = true; }, meltWinsRace: () => { meltWinsRace = true; } };
}
const make = (service = mintService(), backend = memoryBackend()) => { const vault = createVault({ backend }); return { wallet: createCashuWallet({ vault, sdkFactory: service.factory }), service, backend, vault }; };

// All proofs, seeds and invoices in this suite are generated test data. No network or live money.
test('wallet stays offline until explicit enable and stores secrets only inside a separate encrypted snapshot', async () => {
  const { wallet, service, backend } = make();
  await wallet.restore(); assert.equal(wallet.state().status, 'disabled'); assert.equal(service.calls.loads, 0);
  await wallet.enable(); assert.equal(wallet.state().status, 'ready'); assert.equal(service.calls.loads, 1);
  assert.equal((await backend.read()).key.extractable, false);
  assert.equal(JSON.stringify(wallet.state()).includes('seed'), false);
  await wallet.lock(); assert.equal(wallet.state().status, 'locked'); await wallet.unlock(); assert.equal(wallet.state().status, 'ready');
});

test('mint URL validation rejects credentials and non-HTTPS; unknown token preview never contacts its mint', async () => {
  for (const url of ['http://mint.example', 'https://name:secret@mint.example', 'https://mint.example/?secret=1', 'https://mint.example/#x']) assert.throws(() => normalizeMint(url));
  assert.equal(normalizeMint('https://mint.example/'), 'https://mint.example');
  const { wallet, service } = make(); await wallet.enable(); const loads = service.calls.loads;
  const preview = await wallet.previewReceive(token(16, 'https://other.example')); assert.equal(preview.unknownMint, true); assert.equal(service.calls.loads, loads);
  await assert.rejects(wallet.receive(token(16, 'https://other.example')), /Add and select/); assert.equal(service.calls.loads, loads);
});

test('receive, fee preview, send and restart preserve balances and explicit bearer-token access', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(32)); assert.equal(app.wallet.state().balance, '32');
  const reservations = app.service.calls.reserves, preview = await app.wallet.previewSend('12'); assert.equal(preview.maxTotal, '12'); assert.equal(app.service.calls.reserves, reservations);
  const sent = await app.wallet.send({ amount: '12', maxFee: preview.fee }); assert.ok(sent.token.startsWith('cashuB')); assert.equal(app.wallet.state().balance, '20');
  assert.equal(JSON.stringify(app.wallet.state()).includes(sent.token), false); assert.equal(await app.wallet.getToken(sent.id), sent.token);
  await app.wallet.lock(); const restarted = make(app.service, app.backend); await restarted.wallet.restore(); assert.equal(restarted.wallet.state().balance, '20'); assert.equal(await restarted.wallet.getToken(sent.id), sent.token);
});

test('lost swap response reserves inputs and recovers exact outputs after restart without spending twice', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(32)); app.service.interruptSwap();
  await assert.rejects(app.wallet.send({ amount: 12, maxFee: 0 })); const pending = app.wallet.state().pending[0]; assert.ok(pending); assert.equal(app.wallet.state().balance, '0'); assert.equal(app.wallet.state().mints[0].reserved, '32');
  const calls = { ...app.service.calls }; await app.wallet.lock(); const restarted = make(app.service, app.backend); await restarted.wallet.restore();
  const result = await restarted.wallet.recover(pending.id); assert.ok(result.token); assert.equal(restarted.wallet.state().balance, '20'); assert.equal(app.service.calls.swaps, calls.swaps); assert.equal(app.service.calls.reserves, calls.reserves); assert.equal(restarted.wallet.state().pending.length, 0);
});

test('concurrent spends serialize and cannot use reserved or already spent proofs', async () => {
  const { wallet, service } = make(); await wallet.enable(); await wallet.receive(token(16)); service.interruptSwap();
  const result = await Promise.allSettled([wallet.send({ amount: 12, maxFee: 0 }), wallet.send({ amount: 12, maxFee: 0 })]);
  assert.ok(result.every(item => item.status === 'rejected')); assert.equal(wallet.state().pending.length, 1); assert.equal(service.calls.swaps, 2);
});

test('two tabs cannot both commit an operation from the same encrypted snapshot', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(16)); const second = make(app.service, app.backend); await second.wallet.restore();
  await app.wallet.send({ amount: 8, maxFee: 0 }); const swaps = app.service.calls.swaps;
  await assert.rejects(second.wallet.send({ amount: 8, maxFee: 0 }), /another tab/); assert.equal(app.service.calls.swaps, swaps);
});

test('paid invoices claim once and recover an issued invoice after a lost mint response', async () => {
  const app = make(); await app.wallet.enable(); const invoice = await app.wallet.createInvoice(32);
  assert.equal((await app.wallet.checkInvoice(invoice.id)).state, 'UNPAID'); const remote = [...app.service.mintQuotes.values()][0]; remote.state = 'PAID'; app.service.interruptMint();
  await assert.rejects(app.wallet.checkInvoice(invoice.id)); assert.equal(app.wallet.state().balance, '0'); const pending = app.wallet.state().pending[0]; assert.ok(pending);
  await app.wallet.lock(); const restarted = make(app.service, app.backend); await restarted.wallet.restore(); await restarted.wallet.recover(pending.id); assert.equal(restarted.wallet.state().balance, '32');
  await restarted.wallet.checkInvoice(invoice.id); assert.equal(restarted.wallet.state().balance, '32'); assert.equal(app.service.calls.mints, 1);
});

test('Lightning preview never reserves funds; confirmed payment splits exactly and recovers lost response', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(64)); const before = { ...app.service.calls };
  const preview = await app.wallet.previewLightning('lnbc1testinvoice'); assert.equal(preview.amount, '8'); assert.equal(preview.fee, '2'); assert.equal(app.service.calls.reserves, before.reserves); assert.equal(app.wallet.state().balance, '64');
  app.service.interruptMelt(); await assert.rejects(app.wallet.payLightning({ quoteId: preview.quoteId, maxFee: preview.fee }));
  assert.equal(app.wallet.state().balance, '54'); assert.equal(app.wallet.state().mints[0].reserved, '10'); const pending = app.wallet.state().pending[0];
  const recovered = await app.wallet.recover(pending.id); assert.equal(recovered.state, 'complete'); assert.equal(recovered.fee, '2'); assert.equal(app.service.calls.melts, 1); assert.equal(app.wallet.state().balance, '54');
});

test('Lightning fee limit rejects before mutation and prevents reusing a paid quote', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(32)); const preview = await app.wallet.previewLightning('lnbc1testinvoice'); const swaps = app.service.calls.swaps;
  await assert.rejects(app.wallet.payLightning({ quoteId: preview.quoteId, maxFee: 0 }), /fee changed/); assert.equal(app.service.calls.swaps, swaps); assert.equal(app.wallet.state().balance, '32');
  await app.wallet.payLightning({ quoteId: preview.quoteId, maxFee: 2 }); await assert.rejects(app.wallet.payLightning({ quoteId: preview.quoteId, maxFee: 2 }), /already has a payment/);
});

test('backup is encrypted and authenticated, bounded, never overwrites a wallet and rotates future output seed on restore', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(32)); const original = await app.vault.get('wallet');
  const backup = await app.wallet.exportEncryptedBackup('twelve words are not required'); assert.equal(backup.includes(original.seed), false);
  await assert.rejects(app.wallet.importEncryptedBackup(backup, 'twelve words are not required'), /Existing funds/);
  const restored = make(app.service); await assert.rejects(restored.wallet.importEncryptedBackup(backup, 'incorrect passphrase'), /Check the file and passphrase/);
  await restored.wallet.importEncryptedBackup(backup, 'twelve words are not required'); assert.equal(restored.wallet.state().reviewRequired, true); assert.notEqual((await restored.vault.get('wallet')).seed, original.seed);
  await assert.rejects(restored.wallet.previewSend(1), /Refresh/); await restored.wallet.refresh(); assert.equal(restored.wallet.state().balance, '32');
  const tampered = JSON.parse(backup); tampered.ciphertext = `A${tampered.ciphertext.slice(1)}`; await assert.rejects(decryptBackup(JSON.stringify(tampered), 'twelve words are not required'));
  await assert.rejects(decryptBackup('x'.repeat(12 * 1024 * 1024), 'twelve words are not required'), /too large/);
});

test('restored backup checks spent proofs and does not revive value transferred since the snapshot', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(16)); const backup = await app.wallet.exportEncryptedBackup('correct backup password'); await app.wallet.send({ amount: 16, maxFee: 0 });
  const restored = make(app.service); await restored.wallet.importEncryptedBackup(backup, 'correct backup password'); await restored.wallet.refresh(); assert.equal(restored.wallet.state().balance, '0');
});

test('duplicate receive and oversized/non-sat tokens are rejected without extra mint mutations', async () => {
  const app = make(); await app.wallet.enable(); const incoming = token(8); await app.wallet.receive(incoming); const swaps = app.service.calls.swaps;
  await assert.rejects(app.wallet.receive(incoming), /already been received/); await assert.rejects(app.wallet.previewReceive('cashuB' + 'x'.repeat(256 * 1024)), /256 KiB/);
  const unsupported = getEncodedToken({ mint: DEFAULT_MINT, unit: 'usd', proofs: [proof(8)] }); await assert.rejects(app.wallet.previewReceive(unsupported), /Only Cashu tokens in sats/); assert.equal(app.service.calls.swaps, swaps);
});

test('offline enable preserves the generated wallet instead of replacing its seed on retry', async () => {
  const app = make(); app.service.failLoad(); await assert.rejects(app.wallet.enable()); const seed = (await app.vault.get('wallet')).seed;
  await assert.rejects(app.wallet.enable(), /already exists/); assert.equal((await app.vault.get('wallet')).seed, seed); assert.equal(app.wallet.state().status, 'ready');
});

test('SDK preview serialization preserves blinding factors, amounts and quote fields exactly', async () => {
  const data = OutputData.createSingleDeterministicData(0, new Uint8Array(64).fill(5), 10, KEYSET);
  const preview = { method: 'bolt11', keysetId: KEYSET, quote: { quote: 'local-test', amount: Amount.from(8), fee_reserve: Amount.from(2) }, inputs: [proof(16)], outputData: [data] };
  const restored = unpackPreview(JSON.parse(JSON.stringify(packPreview(preview))));
  assert.equal(restored.outputData[0].blindingFactor, data.blindingFactor); assert.deepEqual(restored.outputData[0].secret, data.secret); assert.equal(restored.quote.amount.toString(), '8'); assert.equal(restored.inputs[0].amount.toString(), '16');
});

test('restored snapshot creates different future outputs from the original wallet at the same counter', async () => {
  const app = make(); await app.wallet.enable(); const backup = await app.wallet.exportEncryptedBackup('separate future outputs');
  const restored = make(app.service); await restored.wallet.importEncryptedBackup(backup, 'separate future outputs'); await restored.wallet.refresh();
  await app.wallet.receive(token(16)); await restored.wallet.receive(token(16));
  const first = await app.vault.get('wallet'), second = await restored.vault.get('wallet');
  assert.equal(first.mints[0].counters[KEYSET], second.mints[0].counters[KEYSET]);
  assert.notEqual(first.mints[0].proofs[0].proof.secret, second.mints[0].proofs[0].proof.secret);
  assert.notEqual(first.ops[0].swap.keepOutputs[0].blindedMessage.B_, second.ops[0].swap.keepOutputs[0].blindedMessage.B_);
});

test('imported backup retains and recovers exact pending outputs created under the old seed', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(32)); app.service.interruptSwap(); await assert.rejects(app.wallet.send({ amount: 12, maxFee: 0 }));
  const pending = app.wallet.state().pending[0], original = await app.vault.get('wallet'), backup = await app.wallet.exportEncryptedBackup('preserve pending recovery');
  const restored = make(app.service); await restored.wallet.importEncryptedBackup(backup, 'preserve pending recovery'); const imported = await restored.vault.get('wallet');
  assert.notEqual(imported.seed, original.seed); assert.deepEqual(imported.ops.at(-1).swap, original.ops.at(-1).swap);
  const swaps = app.service.calls.swaps, reserves = app.service.calls.reserves;
  const result = await restored.wallet.recover(pending.id); assert.ok(result.token); assert.equal(restored.wallet.state().balance, '20'); assert.equal(app.service.calls.swaps, swaps); assert.equal(app.service.calls.reserves, reserves);
});

test('failure to save the operation journal prevents every mint mutation', async () => {
  const service = mintService(), backend = memoryBackend(), originalWrite = backend.write;
  let saving = false;
  backend.write = async (...args) => { if (saving) throw new Error('Disk unavailable'); return originalWrite(...args); };
  const app = make(service, backend); await app.wallet.enable(); await app.wallet.receive(token(32)); const swaps = service.calls.swaps;
  // Counter reservation is also a required durable precondition.
  saving = true; await assert.rejects(app.wallet.send({ amount: 8, maxFee: 0 })); assert.equal(service.calls.swaps, swaps); assert.equal(app.wallet.state().balance, '32');
});

test('lock clears every seed buffer passed to SDK instances and removes private state', async () => {
  const service = mintService(), seeds = [], backend = memoryBackend();
  const wallet = createCashuWallet({ vault: createVault({ backend }), sdkFactory: (url, options) => { seeds.push(options.seed); return service.factory(url, options); } });
  await wallet.enable(); assert.ok(seeds[0].some(byte => byte !== 0)); await wallet.lock(); assert.ok(seeds.every(seed => seed.every(byte => byte === 0))); assert.deepEqual(wallet.state().history, []); assert.deepEqual(wallet.state().mints, []);
});

test('actual Cashu SDK + HTTP adapter signs, spends and recovers synthetic mint proofs including input fees', async t => {
  const { createTestMint, TEST_MINT } = await import('./fixtures/cashu-mint.mjs');
  const mint = createTestMint({ feePpk: 1000 }), previousFetch = globalThis.fetch;
  globalThis.fetch = mint.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const backend = memoryBackend(), wallet = createCashuWallet({ vault: createVault({ backend }) });
  await wallet.enable({ mintUrl: TEST_MINT }); await wallet.receive(mint.issueToken(128)); assert.equal(wallet.state().balance, '127');
  const preview = await wallet.previewSend(12); assert.ok(BigInt(preview.fee) > 0n); mint.interruptNext('swap');
  await assert.rejects(wallet.send({ amount: 12, maxFee: preview.fee })); const pending = wallet.state().pending[0], swaps = mint.calls.swaps;
  const result = await wallet.recover(pending.id); assert.ok(result.token); assert.equal(result.fee, preview.fee); assert.equal(mint.calls.swaps, swaps); assert.equal(wallet.state().balance, (127n - 12n - BigInt(preview.fee)).toString());
  const invoice = await wallet.createInvoice(32); mint.payInvoices(); await wallet.checkInvoice(invoice.id); assert.equal(wallet.state().invoices[0].state, 'ISSUED');
  const lightning = await wallet.previewLightning(mint.invoice(8)); await wallet.payLightning({ quoteId: lightning.quoteId, maxFee: lightning.fee }); assert.equal(wallet.state().pending.length, 0);
});

test('configured mint allowlist rejects connections before enabling/adding and preserves unsupported imported records', async () => {
  const service = mintService(), vault = createVault({ backend: memoryBackend() }), wallet = createCashuWallet({ vault, sdkFactory: service.factory, allowedMints: [DEFAULT_MINT] });
  await assert.rejects(wallet.enable({ mintUrl: 'https://unavailable.example' }), /not supported/); assert.equal(service.calls.loads, 0); assert.equal(wallet.state().status, 'disabled');
  await wallet.enable(); const loads = service.calls.loads; await assert.rejects(wallet.addMint('https://unavailable.example'), /not supported/); assert.equal(service.calls.loads, loads);
  const preview = await wallet.previewReceive(token(8, 'https://unavailable.example')); assert.equal(preview.supported, false); assert.equal(service.calls.loads, loads);
  const unrestricted = make(service); await unrestricted.wallet.enable({ mintUrl: 'https://unavailable.example' }); await unrestricted.wallet.receive(token(8, 'https://unavailable.example')); const backup = await unrestricted.wallet.exportEncryptedBackup('preserve unsupported funds');
  const restored = createCashuWallet({ vault: createVault({ backend: memoryBackend() }), sdkFactory: service.factory, allowedMints: [DEFAULT_MINT] });
  await restored.importEncryptedBackup(backup, 'preserve unsupported funds'); assert.equal(restored.state().balance, '8'); assert.equal(restored.state().mints[0].supported, false); const afterImport = service.calls.loads;
  await assert.rejects(restored.refresh(), /not supported/); assert.equal(service.calls.loads, afterImport); assert.equal(restored.state().balance, '8'); assert.ok(await restored.exportEncryptedBackup('preserve unsupported funds'));
});

test('same Lightning invoice cannot be paid twice using different quote identifiers', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(32)); const first = await app.wallet.previewLightning('lnbc1testinvoice'); await app.wallet.payLightning({ quoteId: first.quoteId, maxFee: first.fee });
  const second = await app.wallet.previewLightning('lnbc1testinvoice'); const melts = app.service.calls.melts;
  await assert.rejects(app.wallet.payLightning({ quoteId: second.quoteId, maxFee: second.fee }), /already has a payment/); assert.equal(app.service.calls.melts, melts);
});

test('duplicate token proofs are rejected before preparing or spending any output', async () => {
  const app = make(); await app.wallet.enable(); const repeated = proof(8), input = getEncodedToken({ mint: DEFAULT_MINT, unit: 'sat', proofs: [repeated, repeated] });
  await assert.rejects(app.wallet.receive(input), /repeated proofs/); assert.equal(app.service.calls.reserves, 0); assert.equal(app.service.calls.swaps, 0);
});

test('an expired or failed unpaid Lightning payment reclaims reserved funds through a durable fresh swap', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(64)); const preview = await app.wallet.previewLightning('lnbc1testinvoice'); app.service.rejectMelt();
  await assert.rejects(app.wallet.payLightning({quoteId:preview.quoteId,maxFee:preview.fee})); const pending = app.wallet.state().pending[0]; assert.equal(pending.canReclaim,true); assert.equal(app.wallet.state().balance,'54');
  const result = await app.wallet.cancelPayment(pending.id); assert.equal(result.state,'cancelled'); assert.equal(app.wallet.state().balance,'64'); assert.equal(app.wallet.state().pending.length,0); assert.equal(app.wallet.state().history[0].state,'cancelled');
});

test('lost reclaim response survives restart and restores exact outputs without making original proofs spendable', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(64)); const preview = await app.wallet.previewLightning('lnbc1testinvoice'); app.service.rejectMelt(); await assert.rejects(app.wallet.payLightning({quoteId:preview.quoteId,maxFee:preview.fee})); const pending = app.wallet.state().pending[0];
  app.service.interruptSwap(); await assert.rejects(app.wallet.cancelPayment(pending.id)); assert.equal(app.wallet.state().balance,'54'); assert.equal(app.wallet.state().mints[0].reserved,'10');
  await app.wallet.lock(); const restored = make(app.service,app.backend); await restored.wallet.restore(); const swaps=app.service.calls.swaps; await restored.wallet.recover(pending.id); assert.equal(restored.wallet.state().balance,'64'); assert.equal(app.service.calls.swaps,swaps); assert.equal(restored.wallet.state().pending.length,0);
});

test('if an in-flight Lightning payment wins the race, reclaim never revives its consumed proofs', async () => {
  const app = make(); await app.wallet.enable(); await app.wallet.receive(token(64)); const preview = await app.wallet.previewLightning('lnbc1testinvoice'); app.service.rejectMelt(); await assert.rejects(app.wallet.payLightning({quoteId:preview.quoteId,maxFee:preview.fee})); const pending=app.wallet.state().pending[0];
  app.service.meltWinsRace(); await assert.rejects(app.wallet.cancelPayment(pending.id)); await app.wallet.recover(pending.id); assert.equal(app.wallet.state().balance,'54'); assert.equal(app.wallet.state().mints[0].reserved,'0'); assert.equal(app.wallet.state().pending.length,0); assert.equal(app.wallet.state().history[0].state,'complete');
});

test('spent proof compaction prevents the reproduced 8192-row completion deadlock', async () => {
  const app=make(); await app.wallet.enable(); const stored=await app.vault.get('wallet'); stored.mints[0].proofs=Array.from({length:8192},(_,index)=>({proof:{...proof(1,`spent-${index}`),amount:'1'},state:'spent'})); await app.vault.put('wallet',stored); await app.wallet.lock(); await app.wallet.unlock();
  await app.wallet.receive(token(2)); assert.equal(app.wallet.state().balance,'2'); assert.equal(app.wallet.state().pending.length,0); assert.equal((await app.vault.get('wallet')).mints[0].proofs.length,1);
});

test('near-full snapshots reject new transfers before remote spending and retain existing funds', async () => {
  const app=make(); await app.wallet.enable(); const stored=await app.vault.get('wallet'); stored.padding='x'.repeat(8*1024*1024-8192); await app.vault.put('wallet',stored); await app.wallet.lock(); await app.wallet.unlock();
  await assert.rejects(app.wallet.receive(token(2)),/storage is nearly full/); assert.equal(app.service.calls.swaps,0); assert.equal(app.wallet.state().pending.length,0);
});


test('actual SDK reclaims unpaid Lightning with exact fees after a lost reclaim response and restart', async t => {
  const { createTestMint, TEST_MINT } = await import('./fixtures/cashu-mint.mjs');
  const mint = createTestMint({ feePpk: 1000 }), previousFetch = globalThis.fetch;
  globalThis.fetch = mint.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const backend = memoryBackend(), vault = createVault({ backend }), wallet = createCashuWallet({ vault });
  await wallet.enable({ mintUrl: TEST_MINT }); await wallet.receive(mint.issueToken(128));
  const before = BigInt(wallet.state().balance), quote = await wallet.previewLightning(mint.invoice(8));
  mint.rejectNextMelt();
  await assert.rejects(wallet.payLightning({ quoteId: quote.quoteId, maxFee: quote.fee }));
  const pending = wallet.state().pending[0]; assert.equal(pending.canReclaim, true);
  const frozenBalance = wallet.state().balance;
  mint.interruptNext('swap'); await assert.rejects(wallet.cancelPayment(pending.id));
  assert.equal(wallet.state().balance, frozenBalance);
  const mutations = mint.calls.swaps; await wallet.lock();
  const restored = createCashuWallet({ vault: createVault({ backend }) }); await restored.restore();
  await restored.recover(pending.id);
  assert.equal(mint.calls.swaps, mutations);
  assert.equal(restored.state().pending.length, 0);
  assert.equal(restored.state().mints[0].reserved, '0');
  const completed = restored.state().history.find(item => item.id === pending.id);
  assert.equal(completed.state, 'cancelled');
  assert.ok(BigInt(completed.fee) > 0n);
  assert.equal(BigInt(restored.state().balance), before - BigInt(completed.fee));
});
