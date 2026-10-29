import { createVault, indexedDbVaultBackend } from '../messaging/vault.ts';
import { encryptBackup, decryptBackup } from './backup.ts';
import { Amount, OutputData, createSdk, json, hydrateProofs, getTokenMetadata, getEncodedToken, serializeSwapPreview, deserializeSwapPreview, packPreview, unpackPreview, quoteFromJson, restoreOutputs } from './sdk.ts';
import type { Wallet, SerializedProof, SerializedSwapPreview, SerializedOutputData } from '@cashu/cashu-ts';
import type { Vault } from '../messaging/vault.ts';
type ProofState='ready'|'reserved'|'sent'|'spent';
type OperationState='pending'|'complete'|'cancelled';
type OperationType='send'|'receive'|'mint'|'lightning';
interface StoredQuote {quote:string;request:string;amount:string;unit:string;state:string;expiry:number;fee_reserve?:string;pubkey?:string}
interface StoredPreview {quote:StoredQuote;inputs?:SerializedProof[];outputData:SerializedOutputData[]}
interface WalletOperation {id:string;type:OperationType;mint:string;amount:string;fee:string;state:OperationState;createdAt:number;error?:string;phase?:string;invoiceId?:string;parentPaymentId?:string;reclaimId?:string;capacityProofs?:number;capacityBytes?:number;swap?:SerializedSwapPreview;preview?:StoredPreview;quote?:StoredQuote;meltInputs?:SerializedProof[];token?:string}
interface MintRecord {url:string;proofs:{proof:SerializedProof;state:ProofState;operationId?:string}[];counters:Record<string,number>}
interface WalletData {schema:1;seed:string;selectedMint:string;mints:MintRecord[];ops:WalletOperation[];invoices:{id:string;mint:string;amount:string;state:string;quote:StoredQuote}[];quotes:{id:string;mint:string;quote:StoredQuote}[];reviewRequired?:boolean}
export interface WalletState {status:string;busy:boolean;error:string;password:boolean;selectedMint:string;balance:string;reviewRequired:boolean;mints:{url:string;supported:boolean;balance:string;reserved:string}[];invoices:{id:string;mint:string;request:string;amount:string;state:string;expiresAt:number}[];history:{id:string;mint:string;type:OperationType;amount:string;fee:string;state:OperationState;createdAt:number}[];pending:{id:string;type:OperationType;amount:string;state:'pending';canReclaim:boolean;error:string}[]}
interface WalletOptions {onChange?:(state:WalletState)=>void;vault?:Vault;sdkFactory?:typeof createSdk;allowedMints?:string[]}

export const DEFAULT_MINT = 'https://mint.coinos.io';
const MAX_AMOUNT = 2_100_000_000_000_000n;
const MAX_TOKEN = 256 * 1024;
class WalletError extends Error {}
const fail = (message:string):never => { throw new WalletError(message); };
const integer = (value, positive = true) => {
  const text = String(value);
  if (!/^\d{1,16}$/.test(text)) fail('Enter a whole number of sats.');
  const amount = BigInt(text);
  if (amount > MAX_AMOUNT || (positive && amount === 0n)) fail('Enter a valid amount of sats.');
  return amount;
};
const sum = (proofs:{amount:{toString():string}}[]):bigint => proofs.reduce((total, proof) => total + BigInt(proof.amount.toString()), 0n);
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (text:string) => Uint8Array.from(text.match(/../g), part => parseInt(part, 16));
const id = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
export function normalizeMint(value) {
  let url;
  try { url = new URL(value); } catch { fail('Enter a valid HTTPS mint address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Use an HTTPS mint address without credentials, a query or a fragment.');
  return url.href.replace(/\/+$/, '');
}
function validateData(raw:unknown):WalletData {
  const value=raw as WalletData;
  if (value?.schema !== 1 || !/^[a-f0-9]{128}$/.test(value.seed) || !Array.isArray(value.mints) || value.mints.length > 16 || !Array.isArray(value.ops) || value.ops.length > 1024 || !Array.isArray(value.invoices) || value.invoices.length > 512 || !Array.isArray(value.quotes) || value.quotes.length > 128) fail('Unsupported wallet backup.');
  const urls = new Set();
  for (const mint of value.mints) {
    if (normalizeMint(mint.url) !== mint.url || urls.has(mint.url) || !Array.isArray(mint.proofs) || mint.proofs.length > 8192 || !mint.counters || typeof mint.counters !== 'object') fail('Invalid wallet data.');
    urls.add(mint.url);
    for (const counter of Object.values(mint.counters)) if (!Number.isSafeInteger(counter) || counter < 0) fail('Invalid wallet counters.');
    const secrets = new Set();
    for (const item of mint.proofs) {
      if (!['ready', 'reserved', 'sent', 'spent'].includes(item.state) || typeof item.proof?.secret !== 'string' || item.proof.secret.length > 4096 || secrets.has(item.proof.secret)) fail('Invalid wallet proofs.');
      integer(item.proof.amount); hydrateProofs([item.proof]); secrets.add(item.proof.secret);
    }
  }
  if (value.selectedMint && !urls.has(value.selectedMint)) fail('Invalid selected mint.');
  const operationIds = new Set();
  for (const operation of value.ops) {
    if (typeof operation.id !== 'string' || operationIds.has(operation.id) || !urls.has(operation.mint) || !['send', 'receive', 'mint', 'lightning'].includes(operation.type) || !['pending', 'complete', 'cancelled'].includes(operation.state)) fail('Invalid wallet operations.');
    integer(operation.amount); integer(operation.fee, false); operationIds.add(operation.id);
    for (const field of ['capacityBytes', 'capacityProofs']) if (operation[field] !== undefined && (!Number.isSafeInteger(operation[field]) || operation[field] < 0 || operation[field] > 8 * 1024 * 1024)) fail('Invalid wallet recovery capacity.');
    if (operation.swap) deserializeSwapPreview(operation.swap);
    if (operation.preview) unpackPreview(operation.preview);
  }
  for (const mint of value.mints) for (const proof of mint.proofs) if (proof.state === 'reserved' && !operationIds.has(proof.operationId)) fail('A reserved proof is missing its recovery record.');
  return value;
}

/** Independent of Nostr identity. Every money mutation journals exact outputs before contacting a mint. */
export function createCashuWallet({ onChange = () => {}, vault = createVault({ backend: indexedDbVaultBackend(globalThis.indexedDB, 'iris-market-cashu') }), sdkFactory = createSdk, allowedMints }:WalletOptions = {}) {
  let data:WalletData, status = 'disabled', error = '', password = false, busy = false, destroyed = false;
  let queue = Promise.resolve(), activeOperationId;
  const wallets = new Map<string,Wallet>(), seeds = new Set<Uint8Array>();
  const supported = allowedMints ? new Set(allowedMints.map(normalizeMint)) : null;
  const isSupported = url => !supported || supported.has(url);
  const requireSupported = url => { if (!isSupported(url)) fail('This mint is not supported by this Market website. Its saved wallet data is preserved.'); };
  const publicState = ():WalletState => {
    const mints = (data?.mints || []).map(mint => ({ url: mint.url, supported: isSupported(mint.url), balance: sum(mint.proofs.filter(item => item.state === 'ready').map(item => item.proof)).toString(), reserved: sum(mint.proofs.filter(item => item.state === 'reserved').map(item => item.proof)).toString() }));
    return { status, busy, error, password, selectedMint: data?.selectedMint || '', balance: mints.find(mint => mint.url === data?.selectedMint)?.balance || '0', mints,
      reviewRequired: !!data?.reviewRequired,
      invoices: (data?.invoices || []).map(invoice => ({ id: invoice.id, mint: invoice.mint, request: invoice.quote.request, amount: invoice.amount, state: invoice.state, expiresAt: invoice.quote.expiry })),
      history: (data?.ops || []).filter(operation => !operation.parentPaymentId).map(operation => ({ id: operation.id, mint: operation.mint, type: operation.type, amount: operation.amount, fee: operation.fee, state: operation.state, createdAt: operation.createdAt })).reverse(),
      pending: (data?.ops || []).filter(operation => operation.state === 'pending' && !operation.parentPaymentId).map(operation => ({ id: operation.id, type: operation.type, amount: operation.amount, state: 'pending', canReclaim: operation.type === 'lightning' && ['melt-ready', 'melt'].includes(operation.phase) && !operation.reclaimId, error: operation.error || 'Check the mint to finish this operation.' })) };
  };
  const emit = () => { if (!destroyed) onChange(publicState()); };
  const assertReady = () => { if (status !== 'ready' || !data) fail('Unlock your wallet first.'); };
  const serial = fn => {
    const result = queue.then(async () => {
      if (destroyed) fail('Wallet is closed.');
      busy = true; error = ''; emit();
      try { return await fn(); }
      catch (cause) { error = cause instanceof WalletError ? cause.message : /another tab/.test(cause?.message) ? 'Wallet data changed in another tab. Reload before continuing.' : 'The wallet could not finish this request. Check pending operations before retrying.'; emit(); throw new WalletError(error); }
      finally { busy = false; emit(); }
    });
    queue = result.catch(() => {}); return result;
  };
  const bytesUsed = value => new TextEncoder().encode(JSON.stringify({ schema: 1, entries: [['wallet', value]] })).length;
  const assertCapacity = next => {
    const pending = next.ops.filter(item => item.state === 'pending');
    if (bytesUsed(next) + pending.reduce((sum, item) => sum + (item.capacityBytes || 0), 0) > 8 * 1024 * 1024) fail('Wallet storage is nearly full. Existing pending payments can still be recovered.');
    for (const mint of next.mints) if (mint.proofs.length + pending.filter(item => item.mint === mint.url).reduce((sum, item) => sum + (item.capacityProofs || 0), 0) > 8192) fail('This wallet needs fewer pending transfers before accepting more funds.');
  };
  const commit = async (mutate:(data:WalletData)=>void) => {
    assertReady(); const next = structuredClone(data); mutate(next);
    // Spent inputs remain in their immutable operation journals; duplicate proof rows add no recovery value.
    for (const mint of next.mints) mint.proofs = mint.proofs.filter(item => item.state !== 'spent');
    const owner = next.ops.find(item => item.id === activeOperationId && item.state === 'pending');
    if (owner) {
      const previous = new Set(data.mints.flatMap(mint => mint.proofs.map(item => item.proof.secret)));
      const addedProofs = next.mints.flatMap(mint => mint.proofs).filter(item => !previous.has(item.proof.secret)).length;
      owner.capacityProofs = Math.max(0, (owner.capacityProofs || 0) - addedProofs);
      owner.capacityBytes = Math.max(0, (owner.capacityBytes || 0) - Math.max(0, bytesUsed(next) - bytesUsed(data)));
    }
    validateData(next); assertCapacity(next); await vault.put('wallet', next); data = next; emit();
  };
  const mintData = url => { const mint = data.mints.find(mint => mint.url === url); if (!mint) fail('Add and select this mint before using it.'); return mint; };
  const selected = () => { assertReady(); if (!data.selectedMint) fail('Select a mint first.'); return data.selectedMint; };
  const spendable = url => { if (data.reviewRequired) fail('Refresh the restored wallet before spending. Stop using its original copy.'); return hydrateProofs(mintData(url).proofs.filter(item => item.state === 'ready').map(item => item.proof)); };
  const sdk = async url => {
    requireSupported(url); mintData(url);
    if (!wallets.has(url)) {
      const seed = fromHex(data.seed); seeds.add(seed);
      const reserve = async (keyset, start, count) => {
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(start + count)) fail('Invalid wallet counter reservation.');
        await commit(next => { const counters = next.mints.find(mint => mint.url === url).counters; if (start < (counters[keyset] || 0)) fail('Wallet counters changed. Retry this operation.'); counters[keyset] = start + count; });
        return { start, count };
      };
      const counterSource = { reserve: (keyset, count) => reserve(keyset, mintData(url).counters[keyset] || 0, count), reserveAt: reserve,
        advanceToAtLeast: (keyset, minimum) => commit(next => { if (!Number.isSafeInteger(minimum) || minimum < 0) fail('Invalid wallet counter.'); const counters = next.mints.find(mint => mint.url === url).counters; counters[keyset] = Math.max(counters[keyset] || 0, minimum); }), snapshot: async () => ({ ...mintData(url).counters }) };
      const instance = sdkFactory(url, { seed, counterSource });
      await instance.loadMint(); wallets.set(url, instance);
    }
    return wallets.get(url);
  };
  const add = async url => {
    url = normalizeMint(url); requireSupported(url);
    if (!data.mints.some(mint => mint.url === url)) await commit(next => { if (next.mints.length >= 16) fail('You can add up to 16 mints.'); next.mints.push({ url, proofs: [], counters: {} }); });
    await sdk(url); return url;
  };
  const operation = operationId => { const result = data.ops.find(item => item.id === operationId); if (!result) fail('Operation not found.'); return result; };
  const persistOperation = async entry => commit(next => {
    if (next.ops.length >= 1024) fail('Wallet history is full. Export a backup before continuing.');
    const outputCount = (entry.swap?.keepOutputs?.length || 0) + (entry.swap?.sendOutputs?.length || 0) + (entry.preview?.outputData?.length || 0) + (entry.type === 'lightning' ? 64 : 0);
    const ownInputs = (entry.swap?.inputs || entry.preview?.inputs || []).filter(proof => next.mints.find(mint => mint.url === entry.mint).proofs.some(item => item.proof.secret === proof.secret)).length;
    entry = { ...entry, capacityProofs: Math.max(0, outputCount - ownInputs), capacityBytes: 16384 + outputCount * 4096 };
    if (entry.parentPaymentId) {
      const parent = next.ops.find(item => item.id === entry.parentPaymentId);
      if (!parent || parent.state !== 'pending' || parent.reclaimId) fail('This payment already has a recovery operation.');
      parent.reclaimId = entry.id; parent.phase = 'reclaiming'; parent.capacityBytes = 0; parent.capacityProofs = 0;
    }
    next.ops.push(entry);
    const inputs = entry.swap?.inputs || entry.preview?.inputs || [];
    const mint = next.mints.find(mint => mint.url === entry.mint);
    for (const proof of inputs) {
      const own = mint.proofs.find(item => item.proof.secret === proof.secret);
      if (entry.type !== 'receive' && (!own || own.state !== 'ready')) fail('These funds are already reserved.');
      if (own) { if (own.state !== 'ready' && !(entry.parentPaymentId && own.state === 'reserved' && own.operationId === entry.parentPaymentId)) fail('This token has already been used.'); own.state = 'reserved'; own.operationId = entry.id; }
    }
  });
  const addProofs = (mint, proofs, state, operationId) => {
    for (const proof of json(proofs)) {
      const existing = mint.proofs.find(item => item.proof.secret === proof.secret);
      if (existing) continue; // Never revive a spent/sent proof from an old backup or mint replay.
      mint.proofs.push({ proof, state, operationId });
    }
  };
  const finishSwap = async (entry, result) => {
    const amount = sum(result.send || []).toString();
    const token = entry.type === 'send' ? getEncodedToken({ mint: entry.mint, unit: 'sat', proofs: result.send }) : undefined;
    await commit(next => {
      const record = next.ops.find(item => item.id === entry.id), mint = next.mints.find(item => item.url === entry.mint);
      for (const proof of mint.proofs) if (proof.operationId === entry.id && proof.state === 'reserved') proof.state = 'spent';
      addProofs(mint, result.keep || [], 'ready', entry.id);
      if (entry.type === 'lightning') {
        addProofs(mint, result.send, 'reserved', entry.id); record.phase = 'melt-ready'; record.meltInputs = json(result.send);
      } else { addProofs(mint, result.send || [], 'sent', entry.id); record.state = 'complete'; if (token) record.token = token; }
      record.error = '';
      if (entry.parentPaymentId) { const parent = next.ops.find(item => item.id === entry.parentPaymentId); parent.state = 'cancelled'; parent.fee = (BigInt(parent.swap.fees) + BigInt(record.fee)).toString(); parent.error = ''; }
    });
    return { id: entry.parentPaymentId || entry.id, ...(entry.parentPaymentId ? {state:'cancelled'} : {}), amount: entry.type === 'send' ? amount : entry.amount, fee: entry.fee, ...(token ? { token } : {}) };
  };
  const finishMint = async (entry, proofs) => {
    if (sum(proofs) !== BigInt(entry.amount)) fail('The mint returned an unexpected amount. Recovery is still pending.');
    await commit(next => { addProofs(next.mints.find(mint => mint.url === entry.mint), proofs, 'ready', entry.id); const record = next.ops.find(item => item.id === entry.id); record.state = 'complete'; record.error = ''; next.invoices.find(invoice => invoice.id === entry.invoiceId).state = 'ISSUED'; });
    return { id: entry.id, amount: entry.amount, fee: '0' };
  };
  const finishMelt = async (entry, result) => {
    if (result.quote.quote !== entry.quote.quote || result.quote.unit !== 'sat' || String(result.quote.amount) !== entry.amount) fail('The mint returned a different payment. Recovery is still pending.');
    if (result.quote.state !== 'PAID') return { id: entry.id, state: 'pending', fee: entry.fee };
    const paidFee = sum(hydrateProofs(entry.preview.inputs)) - sum(result.change) - BigInt(entry.amount) + BigInt(entry.swap.fees);
    if (paidFee < 0n || paidFee > BigInt(entry.maxFee)) fail('The mint returned an unexpected fee. Recovery is still pending.');
    await commit(next => { const mint = next.mints.find(item => item.url === entry.mint); for (const proof of mint.proofs) if ([entry.id, entry.reclaimId].includes(proof.operationId) && proof.state === 'reserved') proof.state = 'spent'; if (entry.reclaimId) { const reclaim = next.ops.find(item => item.id === entry.reclaimId); reclaim.state = 'cancelled'; reclaim.error = ''; } addProofs(mint, result.change, 'ready', entry.id); const record = next.ops.find(item => item.id === entry.id); record.state = 'complete'; record.fee = paidFee.toString(); record.error = ''; });
    return { id: entry.id, state: 'complete', fee: paidFee.toString() };
  };
  const attempt = async (entry, recovering = false) => {
    const previous = activeOperationId; activeOperationId = entry.id;
    try { return await attemptInner(entry, recovering); } finally { activeOperationId = previous; }
  };
  const attemptInner = async (entry, recovering = false) => {
    if (entry.state === 'complete') return { id: entry.id, amount: entry.amount, fee: entry.fee, state: 'complete', ...(entry.token ? { token: entry.token } : {}) };
    const wallet = await sdk(entry.mint);
    try {
      if (entry.reclaimId) {
        const quote = await wallet.checkMeltQuoteBolt11(entry.quote.quote);
        if (quote.quote !== entry.quote.quote || quote.unit !== 'sat' || String(quote.amount) !== entry.amount) fail('The mint returned a different payment. Recovery is still pending.');
        if (quote.state === 'PAID' && entry.preview) {
          const preview = unpackPreview(entry.preview);
          await wallet.ensureOperableKeysets((quote.change || []).map(signature => signature.id));
          return finishMelt(entry, { quote, change: wallet.createMeltChangeProofs(preview.outputData, quote.change || []) });
        }
        if (quote.state !== 'UNPAID') return {id:entry.id,state:'pending',fee:entry.fee};
        return attempt(operation(entry.reclaimId), true);
      }
      if (entry.type === 'mint') {
        const preview = unpackPreview(entry.preview);
        if (recovering) {
          const restored = await restoreOutputs(wallet, preview.outputData);
          if (restored.every(Boolean)) return finishMint(entry, restored);
          if (restored.some(Boolean)) fail('The mint has only returned part of this payment. Keep the pending recovery record.');
          const quote = await wallet.checkMintQuoteBolt11(preview.quote.quote);
          if (quote.quote !== preview.quote.quote || quote.unit !== 'sat' || String(quote.amount) !== entry.amount) fail('The mint returned a different invoice. Recovery is still pending.');
          if (quote.state !== 'PAID') fail('This invoice is not ready to claim. Keep the pending recovery record.');
        }
        return finishMint(entry, await wallet.completeMint(preview));
      }
      if (entry.phase !== 'melt-ready' && entry.phase !== 'melt') {
        const preview = deserializeSwapPreview(entry.swap); let result;
        if (recovering) {
          const keep = preview.keepOutputs || [], send = preview.sendOutputs || [], restored = await restoreOutputs(wallet, [...keep, ...send]);
          if (restored.every(Boolean)) result = { keep: restored.slice(0, keep.length), send: restored.slice(keep.length) };
          else if (restored.some(Boolean)) fail('The mint has only returned part of this transfer. Keep the pending recovery record.');
          else {
            const states = await wallet.checkProofsStates(preview.inputs);
            if (states.length !== preview.inputs.length || states.some(state => state.state !== 'UNSPENT')) fail('The mint has not resolved this transfer. Its funds remain reserved.');
          }
        }
        result ||= await wallet.completeSwap(preview);
        const completed = await finishSwap(entry, result);
        if (entry.type !== 'lightning') return completed;
        entry = operation(entry.id);
      }
      if (entry.phase === 'melt-ready') {
        const preview = await wallet.prepareMelt('bolt11', quoteFromJson(entry.quote), hydrateProofs(entry.meltInputs));
        await commit(next => { const record = next.ops.find(item => item.id === entry.id); record.preview = packPreview(preview); record.phase = 'melt'; });
        entry = operation(entry.id); recovering = false;
      }
      const preview = unpackPreview(entry.preview);
      if (recovering) {
        const quote = await wallet.checkMeltQuoteBolt11(preview.quote.quote);
        if (quote.quote !== preview.quote.quote || quote.unit !== 'sat' || String(quote.amount) !== entry.amount) fail('The mint returned a different payment. Recovery is still pending.');
        if (quote.state === 'PAID') {
          await wallet.ensureOperableKeysets((quote.change || []).map(signature => signature.id));
          return finishMelt(entry, { quote, change: wallet.createMeltChangeProofs(preview.outputData, quote.change || []) });
        }
        if (quote.state !== 'UNPAID') return { id: entry.id, state: 'pending', fee: entry.fee };
        const states = await wallet.checkProofsStates(preview.inputs);
        if (states.length !== preview.inputs.length || states.some(state => state.state !== 'UNSPENT')) fail('This payment is still being resolved. Its funds remain reserved.');
      }
      return finishMelt(entry, await wallet.completeMelt(preview));
    } catch (cause) {
      await commit(next => { const record = next.ops.find(item => item.id === entry.id); record.error = cause instanceof WalletError ? cause.message : 'The mint response was interrupted. Check this operation to recover it.'; });
      throw cause;
    }
  };
  const entry = (type:OperationType, mint:string, amount:unknown, fee:unknown = '0'):WalletOperation => ({ id: id(), type, mint, amount: String(amount), fee: String(fee), state: 'pending', createdAt: now() });
  const tokenInfo = token => {
    if (typeof token !== 'string' || token.length > MAX_TOKEN || !token.startsWith('cashu')) fail('Enter a Cashu token under 256 KiB.');
    let metadata; try { metadata = getTokenMetadata(token); } catch { fail('This Cashu token is invalid.'); }
    if (metadata.unit !== 'sat') fail('Only Cashu tokens in sats are supported.');
    integer(metadata.amount); return { mint: normalizeMint(metadata.mint), amount: metadata.amount.toString() };
  };
  const sendEstimate = (wallet, amount, proofs, includeFees = false) => {
    const receiverFee = includeFees ? BigInt(wallet.getFeesToInclude(amount).toString()) : 0n;
    const selected = wallet.selectProofsToSend(proofs, amount + receiverFee, true).send;
    const fee = BigInt(wallet.getFeesForProofs(selected).toString());
    if (!selected.length || sum(selected) < amount + receiverFee + fee) fail('There are not enough available sats at this mint.');
    return { fee, receiverFee };
  };
  const claimInvoice = async invoiceId => {
    const invoice = data.invoices.find(invoice => invoice.id === invoiceId); if (!invoice) fail('Invoice not found.');
    const existing = data.ops.find(item => item.invoiceId === invoiceId); if (existing) return attempt(existing, true);
    const wallet = await sdk(invoice.mint), quote = await wallet.checkMintQuoteBolt11(invoice.quote.quote);
    if (quote.unit !== 'sat' || String(quote.amount) !== invoice.amount || quote.quote !== invoice.quote.quote || quote.pubkey) fail('The mint returned a different or unsupported invoice.');
    await commit(next => { next.invoices.find(item => item.id === invoiceId).state = quote.state; });
    if (quote.state !== 'PAID') return { id: invoiceId, state: quote.state };
    const preview = await wallet.prepareMint('bolt11', invoice.amount, quote), record = { ...entry('mint', invoice.mint, invoice.amount), invoiceId, preview: packPreview(preview) };
    await persistOperation(record); return attempt(record);
  };
  const clear = () => { for (const seed of seeds) seed.fill(0); seeds.clear(); wallets.clear(); data = undefined; vault.lock(); status = 'locked'; emit(); };
  return {
    state: publicState,
    restore: () => serial(async () => { const stored = await vault.status(); password = stored.password; if (!stored.exists) { status = 'disabled'; return publicState(); } status = 'locked'; if (!password) { await vault.unlock(); data = validateData(await vault.get('wallet')); status = 'ready'; } return publicState(); }),
    enable: ({ mintUrl = DEFAULT_MINT, password: passphrase }:{mintUrl?:string;password?:string} = {}) => serial(async () => {
      if ((await vault.status()).exists) fail('A wallet already exists on this browser. Unlock it instead.');
      const url = normalizeMint(mintUrl); requireSupported(url); const seed = crypto.getRandomValues(new Uint8Array(64));
      const initial:WalletData = { schema: 1, seed: hex(seed), selectedMint: url, mints: [{ url, proofs: [], counters: {} }], ops: [], invoices: [], quotes: [] }; seed.fill(0);
      await vault.create({ wallet: initial }, { password: passphrase }); data = initial; status = 'ready'; password = !!passphrase; emit(); await sdk(url); return publicState();
    }),
    unlock: passphrase => serial(async () => { if (!await vault.unlock(passphrase)) fail('Enable a wallet first.'); data = validateData(await vault.get('wallet')); status = 'ready'; password = (await vault.status()).password; return publicState(); }),
    lock: () => serial(async () => { await vault.flush(); clear(); }),
    destroy: async () => { await queue; clear(); destroyed = true; },
    addMint: url => serial(async () => { assertReady(); return add(url); }),
    selectMint: url => serial(async () => { assertReady(); url = normalizeMint(url); mintData(url); await commit(next => { next.selectedMint = url; }); return publicState(); }),
    previewReceive: token => serial(async () => {
      assertReady(); const info = tokenInfo(token);
      if (!data.mints.some(mint => mint.url === info.mint)) return { ...info, supported: isSupported(info.mint), unknownMint: true, fee: null, received: null };
      const wallet = await sdk(info.mint), decoded = wallet.decodeToken(token), fee = BigInt(wallet.getFeesForProofs(decoded.proofs).toString());
      if (decoded.proofs.length > 2048 || fee >= BigInt(info.amount)) fail('This token does not cover its mint fee.');
      return { ...info, unknownMint: false, fee: fee.toString(), received: (BigInt(info.amount) - fee).toString() };
    }),
    receive: token => serial(async () => {
      assertReady(); const info = tokenInfo(token), wallet = await sdk(info.mint), decoded = wallet.decodeToken(token);
      if (decoded.proofs.length > 2048) fail('This token has too many proofs.');
      if (new Set(decoded.proofs.map(proof => proof.secret)).size !== decoded.proofs.length) fail('This token contains repeated proofs.');
      for (const proof of decoded.proofs) {
        if (mintData(info.mint).proofs.some(item => item.proof.secret === proof.secret)) fail('This token is already in your wallet or has been used.');
        if (data.ops.some(item => item.swap?.inputs.some(input => input.secret === proof.secret))) fail('This token has already been received or has a pending recovery.');
      }
      const preview = await wallet.prepareSwapToReceive(decoded), record = { ...entry('receive', info.mint, preview.amount, preview.fees), swap: serializeSwapPreview(preview) };
      await persistOperation(record); return attempt(record);
    }),
    previewSend: amount => serial(async () => { const url = selected(), value = integer(amount), wallet = await sdk(url), { fee } = sendEstimate(wallet, value, spendable(url)); return { amount: value.toString(), fee: fee.toString(), maxTotal: (value + fee).toString() }; }),
    send: ({ amount, maxFee }) => serial(async () => {
      const url = selected(), value = integer(amount), limit = integer(maxFee, false), wallet = await sdk(url);
      const preview = await wallet.prepareSwapToSend(value, spendable(url));
      if (BigInt(preview.fees.toString()) > limit) fail('The mint fee changed. Review the transfer again.');
      const record = { ...entry('send', url, value, preview.fees), swap: serializeSwapPreview(preview) };
      await persistOperation(record); return attempt(record);
    }),
    getToken: operationId => serial(async () => { assertReady(); const record = operation(operationId); if (record.type !== 'send' || record.state !== 'complete' || !record.token) fail('This token is not ready.'); return record.token; }),
    createInvoice: amount => serial(async () => {
      const url = selected(), value = integer(amount), wallet = await sdk(url), quote = await wallet.createMintQuoteBolt11(value);
      if (quote.unit !== 'sat' || String(quote.amount) !== value.toString() || quote.pubkey || !quote.request || !quote.quote) fail('The mint returned a different or unsupported invoice.');
      const record = { id: id(), mint: url, amount: value.toString(), state: quote.state, quote: json(quote), createdAt: now() };
      await commit(next => { if (next.invoices.length >= 512) fail('Invoice history is full.'); next.invoices.push(record); });
      return { id: record.id, request: quote.request, amount: record.amount, state: record.state, expiresAt: quote.expiry };
    }),
    checkInvoice: invoiceId => serial(async () => { assertReady(); return claimInvoice(invoiceId); }),
    previewLightning: invoice => serial(async () => {
      const url = selected(); if (typeof invoice !== 'string' || invoice.length > 16_384 || !/^lnbc[0-9a-z]+$/i.test(invoice)) fail('Enter a mainnet Lightning invoice.');
      const wallet = await sdk(url), quote = await wallet.createMeltQuoteBolt11(invoice);
      if (quote.unit !== 'sat' || quote.request !== invoice || quote.state !== 'UNPAID' || quote.expiry <= now()) fail('This Lightning invoice is not payable.');
      const value = integer(quote.amount), reserve = integer(quote.fee_reserve, false), { fee, receiverFee } = sendEstimate(wallet, value + reserve, spendable(url), true), totalFee = fee + receiverFee + reserve;
      const record = { id: id(), mint: url, quote: json(quote), fee: totalFee.toString() };
      await commit(next => { next.quotes = next.quotes.filter(item => item.quote.expiry > now()).slice(-127); next.quotes.push(record); });
      return { quoteId: record.id, amount: value.toString(), fee: totalFee.toString(), maxTotal: (value + totalFee).toString(), expiresAt: quote.expiry };
    }),
    payLightning: ({ quoteId, maxFee }) => serial(async () => {
      assertReady(); const quoted = data.quotes.find(item => item.id === quoteId); if (!quoted || quoted.quote.expiry <= now()) fail('This payment quote expired. Preview the invoice again.');
      if (data.ops.some(item => item.type === 'lightning' && (item.quote.quote === quoted.quote.quote || item.quote.request === quoted.quote.request))) fail('This invoice already has a payment. Check its status first.');
      const wallet = await sdk(quoted.mint), quote = quoteFromJson(quoted.quote), limit = integer(maxFee, false), preview = await wallet.prepareSwapToSend(quote.amount.add(quote.fee_reserve), spendable(quoted.mint), { includeFees: true });
      const maximumFee = preview.sendOutputs.reduce((total, output) => total + BigInt(output.blindedMessage.amount.toString()), 0n) + BigInt(preview.fees.toString()) - BigInt(quote.amount.toString());
      if (maximumFee > limit) fail('The payment fee changed. Review the invoice again.');
      const record = { ...entry('lightning', quoted.mint, quote.amount, maximumFee), maxFee: limit.toString(), quote: quoted.quote, phase: 'split', swap: serializeSwapPreview(preview) };
      await persistOperation(record); return attempt(record);
    }),
    recover: operationId => serial(async () => { assertReady(); return attempt(operation(operationId), true); }),
    cancelPayment: operationId => serial(async () => {
      assertReady(); const parent = operation(operationId);
      if (parent.reclaimId) return attempt(parent, true);
      if (parent.type !== 'lightning' || parent.state !== 'pending' || !['melt-ready', 'melt'].includes(parent.phase)) fail('Check this payment before reclaiming its funds.');
      const wallet = await sdk(parent.mint), quote = await wallet.checkMeltQuoteBolt11(parent.quote.quote);
      if (quote.quote !== parent.quote.quote || quote.unit !== 'sat' || String(quote.amount) !== parent.amount || quote.state !== 'UNPAID') fail('The mint is still processing this payment. Check its status first.');
      const inputs = hydrateProofs(parent.preview?.inputs || parent.meltInputs), states = await wallet.checkProofsStates(inputs);
      if (states.length !== inputs.length || states.some(item => item.state !== 'UNSPENT')) fail('The payment inputs are still pending or spent. Check its status first.');
      const preview = await wallet.prepareSwapToReceive({ mint: parent.mint, unit: 'sat', proofs: inputs });
      const record = {...entry('receive', parent.mint, preview.amount, preview.fees),parentPaymentId:parent.id,swap:serializeSwapPreview(preview)};
      await persistOperation(record); return attempt(record);
    }),
    refresh: () => serial(async () => {
      assertReady();
      for (const mint of data.mints) {
        const wallet = await sdk(mint.url), ready = mint.proofs.filter(item => item.state === 'ready');
        if (!ready.length) continue;
        const states = await wallet.checkProofsStates(hydrateProofs(ready.map(item => item.proof)));
        if (states.length !== ready.length) fail('The mint did not return every proof state.');
        await commit(next => { const stored = next.mints.find(item => item.url === mint.url); states.forEach((state, index) => { const proof = stored.proofs.find(item => item.proof.secret === ready[index].proof.secret); if (state.state === 'SPENT') proof.state = 'spent'; else if (state.state !== 'UNSPENT') fail('Some funds are still pending at the mint. Try refreshing later.'); }); });
      }
      await commit(next => { next.reviewRequired = false; }); return publicState();
    }),
    exportEncryptedBackup: passphrase => serial(async () => { assertReady(); await vault.flush(); try { return await encryptBackup(data, passphrase); } catch (cause) { fail(cause.message); } }),
    importEncryptedBackup: (text, passphrase, { password: localPassword }:{password?:string} = {}) => serial(async () => {
      if ((await vault.status()).exists) fail('Restore a backup only in a browser with no existing wallet. Existing funds will never be overwritten.');
      let imported; try { imported = validateData(await decryptBackup(text, passphrase)); } catch (cause) { fail(cause.message); } imported.reviewRequired = true;
      // A stale snapshot must never reuse output counters advanced by the original wallet.
      // Existing proofs and pending outputs are complete recovery records, independent of this new seed.
      const newSeed = crypto.getRandomValues(new Uint8Array(64)); imported.seed = hex(newSeed); newSeed.fill(0);
      for (const mint of imported.mints) mint.counters = {};
      await vault.create({ wallet: imported }, { password: localPassword }); data = imported; status = 'ready'; password = !!localPassword; return publicState();
    }),
  };
}
