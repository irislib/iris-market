// Private wallet boundary. Only the blinded /v1/swap request is shared with another signer.
import { Amount, SigAll, getPubKeyFromPrivKey, pointFromHex, schnorrVerifyDigest } from '@cashu/cashu-ts';
import type { Proof, SwapPreview, Wallet, SigAllSigningPackage } from '@cashu/cashu-ts';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export class EscrowError extends Error {}
export function requireEscrow(value: unknown, message: string): asserts value {
  if (!value) throw new EscrowError(message);
}

export interface EscrowTerms {
  mint: string;
  sats: number;
  buyer_key: string;
  seller_key: string;
  provider: {profile: string; key: string; signature: string};
}
interface Input {id:string; amount:number; secret:string; C:string; witness?:string}
interface Output {id:string; amount:number; B_:string}
export interface WireSwap {inputs:Input[]; outputs:Output[]}
export interface EscrowAction {
  op: 'key'|'preview_fund'|'fund'|'recover_funding'|'check'|'prepare'|'cosign'|'complete';
  trade_id: string;
  terms?: EscrowTerms;
  max_fee?: number;
  token?: string;
  direction?: 'release'|'refund';
  swap?: WireSwap;
  recipient_key?: string;
}
const domain = utf8ToBytes('iris-market/escrow/wallet-key/v1');
const certificate = utf8ToBytes('iris-market/escrow-provider/cashu-2of3-v1\0');
const keyPattern = /^(02|03)[a-f0-9]{64}$/;
export const validTradeId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export function escrowRoot(seed: string): string {
  const bytes = hexToBytes(seed);
  try { return bytesToHex(hmac(sha256, domain, bytes)); } finally { bytes.fill(0); }
}
export function escrowSigner(root:string, tradeId:string) {
  requireEscrow(validTradeId(tradeId), 'Invalid escrow trade.');
  const prk = hexToBytes(root);
  const key = hmac(sha256, prk, concatBytes(utf8ToBytes(tradeId), new Uint8Array([1])));
  prk.fill(0);
  return {key, pubkey: bytesToHex(getPubKeyFromPrivKey(key))};
}
export function policy(terms:EscrowTerms) {
  requireEscrow(terms && Number.isSafeInteger(terms.sats) && terms.sats > 0 && terms.sats <= 1e12 && terms.provider, 'Invalid escrow terms.');
  const keys = [terms.buyer_key, terms.seller_key, terms.provider.key];
  requireEscrow(keys.every(key => keyPattern.test(key)) && new Set(keys.map(k=>k.slice(2))).size === 3, 'Escrow needs three distinct spending keys.');
  for (const k of keys) pointFromHex(k);
  requireEscrow(validTradeId(terms.provider.profile) && !keys.some(k => k.slice(2)===terms.provider.profile) &&
    schnorrVerifyDigest(terms.provider.signature, sha256(concatBytes(certificate,hexToBytes(terms.provider.key))),terms.provider.profile),
    'The provider did not authorize this escrow key.');
  return keys;
}
export function binding(terms:EscrowTerms) {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([terms.mint,terms.sats,terms.buyer_key,terms.seller_key,terms.provider.profile,terms.provider.key]))));
}
export const tokenBinding = (token:string) => bytesToHex(sha256(utf8ToBytes(token)));
export async function requireEscrowMint(wallet:Wallet) {
  const info = await wallet.mint.getInfo();
  requireEscrow([7,9,10,11,12].every(n=>info.nuts?.[n]?.supported===true), 'This mint does not support verified escrow payments.');
}
function validateLock(secret:string, [buyer,seller,provider]:string[]) {
  const parsed = JSON.parse(secret);
  const lock = parsed?.[1];
  requireEscrow(Array.isArray(parsed) && parsed.length===2 && parsed[0]==='P2PK' && typeof lock.nonce==='string' &&
    lock.data===buyer && Array.isArray(lock.tags) && lock.tags.length===3, 'The payment has different spending conditions.');
  const canonical=[['pubkeys',seller,provider],['n_sigs','2'],['sigflag','SIG_ALL']].map(t=>JSON.stringify(t));
  requireEscrow(canonical.every(t=>lock.tags.some(tag=>JSON.stringify(tag)===t)), 'The payment has different spending conditions.');
  return JSON.stringify(lock.tags);
}
export async function checkFunding(wallet:Wallet, terms:EscrowTerms, token:string, unspent=true) {
  requireEscrow(typeof token==='string' && token.length<=32768, 'Invalid or oversized escrow payment.');
  const decoded=wallet.decodeToken(token);
  const proofs=decoded.proofs;
  requireEscrow(decoded.mint===terms.mint && decoded.unit==='sat' && proofs.length>0 && proofs.length<=128 &&
    new Set(proofs.map(p=>p.secret)).size===proofs.length && new Set(proofs.map(p=>p.id)).size<=8, 'This payment does not match the agreed mint or unit.');
  const keys=policy(terms);
  requireEscrow(new Set(proofs.map(p=>validateLock(p.secret, keys))).size===1, 'All escrow proofs must carry the same lock.');
  await wallet.ensureOperableKeysets(proofs.map(p=>p.id));
  requireEscrow(proofs.every(p=>wallet.getKeyset(p.id).unit==='sat' && wallet.getKeyset(p.id).verify()), 'The mint returned an invalid sat keyset.');
  requireEscrow((await wallet.verifyMintSignatures(proofs,{require:true})).valid.length===proofs.length, 'The mint signature on the escrow payment is invalid.');
  const fee=wallet.getFeesForProofs(proofs).toNumber();
  const amount=proofs.reduce((sum,p)=>sum+p.amount.toNumber(),0)-fee;
  requireEscrow(Number.isSafeInteger(amount) && amount>=terms.sats, 'Escrow contains fewer sats than agreed after fees.');
  if (unspent) {
    const states=await wallet.checkProofsStates(proofs);
    requireEscrow(states.length===proofs.length && states.every(s=>s.state==='UNSPENT'), 'The escrow is already spent or pending.');
  }
  return {amount,fee,proofs};
}
function cleanInput(p:Proof|Input):Input { return {id:p.id, amount:Amount.from(p.amount).toNumber(), secret:p.secret, C:p.C}; }
function cleanOutput(o:Output):Output { return {id:o.id,amount:o.amount,B_:o.B_}; }
export function template(preview:SwapPreview):WireSwap {
  return {inputs:preview.inputs.map(cleanInput),outputs:[...(preview.keepOutputs ?? []),...(preview.sendOutputs ?? [])].map(({blindedMessage:o})=>({id:o.id,amount:o.amount.toNumber(),B_:o.B_}))};
}
export function transcript(swap:WireSwap) {
  return JSON.stringify([swap.inputs.map(cleanInput),swap.outputs.map(cleanOutput)]);
}
function witness(swap:WireSwap):string[] {
  const raw=swap.inputs[0]?.witness;
  if (raw===undefined) return [];
  requireEscrow(typeof raw==='string' && raw.length<=512, 'Invalid escrow signatures.');
  const value=JSON.parse(raw);
  requireEscrow(Array.isArray(value.signatures) && Object.keys(value).length===1 && value.signatures.length<=2 &&
    value.signatures.every(sig=>typeof sig==='string' && /^[0-9a-f]{128}$/.test(sig)), 'Invalid escrow signatures.');
  return value.signatures;
}
function signingPackage(swap:WireSwap):SigAllSigningPackage {
  return {version:'sigallA',type:'swap',inputs:swap.inputs.map(p=>({C:p.C,secret:p.secret})),
    outputs:swap.outputs.map(o=>({...o,amount:Amount.from(o.amount)})),witness:{signatures:witness(swap)}};
}
export function signatures(swap:WireSwap,keys:string[]) {
  const pkg=signingPackage(swap), digest=SigAll.computeDigests(pkg.inputs,pkg.outputs).v0;
  return keys.filter(key=>pkg.witness.signatures.some(sig=>schnorrVerifyDigest(sig,digest,key)));
}
export function sign(swap:WireSwap,key:Uint8Array):WireSwap {
  const pkg=SigAll.signPackage(signingPackage(swap),bytesToHex(key));
  const inputs=swap.inputs.map(cleanInput);
  inputs[0].witness=JSON.stringify(pkg.witness);
  return {inputs,outputs:swap.outputs.map(cleanOutput)};
}
export function applySignatures(preview:SwapPreview,swap:WireSwap) {
  requireEscrow(transcript(template(preview))===transcript(swap), 'The settlement outputs do not belong to this wallet.');
  return SigAll.mergeSwapPackage(signingPackage(swap), preview);
}
export function validateSwap(wallet:Wallet, swap:WireSwap, proofs:Proof[], amount:number) {
  requireEscrow(swap && Array.isArray(swap.inputs) && swap.inputs.length===proofs.length &&
    Array.isArray(swap.outputs) && swap.outputs.length>0 && swap.outputs.length<=128, 'Invalid settlement request.');
  const expected = new Set(proofs.map(p=>JSON.stringify(cleanInput(p))));
  for (const [i,p] of swap.inputs.entries()) {
    requireEscrow(p && Number.isSafeInteger(p.amount) && expected.delete(JSON.stringify(cleanInput(p))) &&
      (i===0 || p.witness===undefined), 'The settlement spends different funds.');
  }
  const blinded=new Set<string>(); let total=0;
  for (const output of swap.outputs) {
    requireEscrow(output && Number.isSafeInteger(output.amount) && output.amount>0 && typeof output.id==='string' &&
      keyPattern.test(output.B_) && !blinded.has(output.B_), 'Invalid settlement outputs.');
    const keyset=wallet.getKeyset(output.id);
    requireEscrow(keyset.id===output.id && keyset.unit==='sat' && keyset.isActive && !!keyset.keys[output.amount], 'The settlement uses an invalid denomination or keyset.');
    pointFromHex(output.B_); blinded.add(output.B_); total+=output.amount;
  }
  requireEscrow(total===amount, 'The payout amount does not match the escrow balance.');
}
