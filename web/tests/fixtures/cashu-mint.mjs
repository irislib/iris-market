// A synthetic Cashu mint for local tests only. Fixed public test key = 1; no live money.
import { Amount, JSONInt, deriveKeysetId, hashToCurve, pointFromHex, getEncodedToken, bolt11AmountMsat } from '@cashu/cashu-ts';
export const TEST_MINT = 'https://mint.market-test.invalid';
export function createTestMint({ saved, persist = () => {}, feePpk = 0 } = {}) {
  const point = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const keys = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [(2n ** BigInt(i)).toString(), pointFromHex(point).multiply(BigInt(i + 1)).toHex(true)]));
  const keysetId = deriveKeysetId(keys, { versionByte: 0 });
  const ledger = saved || { signatures: {}, spent: [], quotes: {}, melts: {} };
  let interrupt = '', rejectMelt = false;
  const calls = { reads: 0, swaps: 0, mints: 0, melts: 0, restores: 0 };
  const save = () => persist(JSON.parse(JSONInt.stringify(ledger)));
  const amount = value => BigInt(value.toString());
  const sum = values => values.reduce((total, value) => total + amount(value.amount), 0n);
  const y = secret => hashToCurve(new TextEncoder().encode(secret)).toHex(true);
  const fee = inputs => BigInt(Math.ceil(inputs.length * feePpk / 1000));
  const spend = inputs => { if (inputs.some(input => ledger.spent.includes(y(input.secret)))) throw new Error('Synthetic proof already spent'); ledger.spent.push(...inputs.map(input => y(input.secret))); };
  const privateKey = value => BigInt(Math.log2(Number(value)) + 1);
  const sign = output => { const result = { amount: output.amount, id: keysetId, C_: pointFromHex(output.B_).multiply(privateKey(output.amount)).toHex(true) }; ledger.signatures[output.B_] = result; return result; };
  const invoice = sats => `lnbc${BigInt(sats) * 10n}n1marketfixture`;
  const handler = (path, body) => {
    if (path === '/v1/info') return { name: 'Local test mint', version: 'test/1', pubkey: point, nuts: { 4: { methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 10000000 }], disabled: false }, 5: { methods: [{ method: 'bolt11', unit: 'sat', min_amount: 1, max_amount: 10000000 }], disabled: false }, 7: { supported: true }, 9: { supported: true } } };
    if (path === '/v1/keysets') return { keysets: [{ id: keysetId, unit: 'sat', active: true, input_fee_ppk: feePpk }] };
    if (path.startsWith('/v1/keys')) return { keysets: [{ id: keysetId, unit: 'sat', keys }] };
    if (path === '/v1/checkstate') return { states: body.Ys.map(Y => ({ Y, state: ledger.spent.includes(Y) ? 'SPENT' : 'UNSPENT' })) };
    if (path === '/v1/swap') { calls.swaps++; if (sum(body.inputs) !== sum(body.outputs) + fee(body.inputs)) throw new Error('Synthetic amount mismatch'); spend(body.inputs); return { signatures: body.outputs.map(sign) }; }
    if (path === '/v1/restore') { calls.restores++; const outputs = body.outputs.filter(output => ledger.signatures[output.B_]); return { outputs, signatures: outputs.map(output => ledger.signatures[output.B_]) }; }
    if (path === '/v1/mint/quote/bolt11') { const quote = crypto.randomUUID(), value = amount(body.amount); return ledger.quotes[quote] = { quote, amount: value, unit: 'sat', request: invoice(value), state: 'UNPAID', expiry: Math.floor(Date.now() / 1000) + 3600 }; }
    if (path.startsWith('/v1/mint/quote/bolt11/')) return ledger.quotes[path.split('/').at(-1)];
    if (path === '/v1/mint/bolt11') { calls.mints++; const quote = ledger.quotes[body.quote]; if (quote.state !== 'PAID' || sum(body.outputs) !== amount(quote.amount)) throw new Error('Synthetic quote unpaid'); quote.state = 'ISSUED'; return { signatures: body.outputs.map(sign) }; }
    if (path === '/v1/melt/quote/bolt11') { const quote = crypto.randomUUID(); return ledger.melts[quote] = { quote, request: body.request, amount: bolt11AmountMsat(body.request) / 1000n, unit: 'sat', fee_reserve: 2, state: 'UNPAID', expiry: Math.floor(Date.now() / 1000) + 3600, payment_preimage: null }; }
    if (path.startsWith('/v1/melt/quote/bolt11/')) return ledger.melts[path.split('/').at(-1)];
    if (path === '/v1/melt/bolt11') { calls.melts++; if (rejectMelt) { rejectMelt = false; throw new Error('Synthetic unpaid Lightning failure'); } const quote = ledger.melts[body.quote]; if (sum(body.inputs) < amount(quote.amount) + amount(quote.fee_reserve) + fee(body.inputs)) throw new Error('Synthetic melt too small'); spend(body.inputs); quote.state = 'PAID'; quote.change = []; return quote; }
    throw new Error('Unexpected synthetic mint request');
  };
  return {
    calls, invoice,
    issueToken(sats = 128) { const secret = crypto.randomUUID(); return getEncodedToken({ mint: TEST_MINT, unit: 'sat', proofs: [{ id: keysetId, amount: Amount.from(sats), secret, C: pointFromHex(y(secret)).multiply(privateKey(sats)).toHex(true) }] }); },
    payInvoices() { for (const quote of Object.values(ledger.quotes)) if (quote.state === 'UNPAID') quote.state = 'PAID'; save(); },
    interruptNext(operation = 'swap') { interrupt = operation; },
    rejectNextMelt() { rejectMelt = true; },
    async fetch(url, options = {}) {
      if (!url.startsWith(TEST_MINT + '/')) throw new Error('Public network forbidden by local wallet fixture');
      calls.reads++; const path = new URL(url).pathname, body = options.body ? JSONInt.parse(options.body) : undefined;
      const response = handler(path, body); save();
      if (interrupt && path === `/v1/${interrupt}` || interrupt === 'mint' && path === '/v1/mint/bolt11' || interrupt === 'melt' && path === '/v1/melt/bolt11') { interrupt = ''; throw new Error('Synthetic lost response'); }
      return new Response(JSONInt.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}
