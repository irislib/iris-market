import { Wallet, Mint, JSONInt, Amount, OutputData, deserializeProofs, serializeSwapPreview, deserializeSwapPreview, getTokenMetadata, getEncodedToken } from '@cashu/cashu-ts';
export { Amount, OutputData, getTokenMetadata, getEncodedToken, serializeSwapPreview, deserializeSwapPreview };
export const json = value => JSON.parse(JSON.stringify(value));
export const hydrateProofs = proofs => deserializeProofs(proofs);
export const quoteFromJson = quote => ({ ...quote, amount: Amount.from(quote.amount), ...(quote.fee_reserve !== undefined ? { fee_reserve: Amount.from(quote.fee_reserve) } : {}) });
export const packPreview = preview => ({ ...json({ ...preview, outputData: undefined }), inputs: preview.inputs ? json(preview.inputs) : undefined, outputData: preview.outputData.map(OutputData.serialize) });
export const unpackPreview = preview => ({ ...preview, quote: quoteFromJson(preview.quote), inputs: preview.inputs ? hydrateProofs(preview.inputs) : undefined, outputData: preview.outputData.map(OutputData.deserialize) });

// No cookies, redirects, unbounded responses, background retries or secret-bearing logs.
export function createSdk(mintUrl, { seed, counterSource }) {
  const mint = new Mint(mintUrl, { customRequest: async ({ endpoint, requestBody, method, headers }) => {
    if (!endpoint.startsWith(`${mintUrl}/`)) throw new Error('Unexpected mint endpoint.');
    const response = await fetch(endpoint, { method: method || (requestBody ? 'POST' : 'GET'), headers: { ...headers, ...(requestBody ? { 'Content-Type': 'application/json' } : {}) }, body: requestBody ? JSONInt.stringify(requestBody) : undefined,
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('The mint did not complete this request.');
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 2 * 1024 * 1024) throw new Error('Mint response is too large.'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const body = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    return JSONInt.parse(new TextDecoder().decode(body));
  } });
  return new Wallet(mint, { unit: 'sat', bip39seed: seed, counterSource });
}

/** NUT-09 recovery uses the exact persisted outputs, never a fresh counter range. */
export async function restoreOutputs(wallet, outputs) {
  if (!outputs.length) return [];
  const response = await wallet.mint.restore({ outputs: outputs.map(output => output.blindedMessage) });
  if (!Array.isArray(response.outputs) || !Array.isArray(response.signatures) || response.outputs.length !== response.signatures.length || response.outputs.length > outputs.length) throw new Error('Invalid mint recovery response.');
  const requested = new Map(outputs.map(output => [output.blindedMessage.B_, output]));
  const signatures = new Map();
  for (let index = 0; index < response.outputs.length; index++) {
    const blinded = response.outputs[index], signature = response.signatures[index], output = requested.get(blinded.B_);
    if (!output || signatures.has(blinded.B_) || signature.id !== output.blindedMessage.id || !Amount.from(signature.amount).equals(output.blindedMessage.amount)) throw new Error('Invalid mint recovery response.');
    signatures.set(blinded.B_, { ...signature, amount: Amount.from(signature.amount) });
  }
  await wallet.ensureOperableKeysets([...signatures.values()].map(signature => signature.id));
  return outputs.map(output => {
    const signature = signatures.get(output.blindedMessage.B_);
    return signature ? output.toProof(signature, wallet.getKeyset(signature.id)) : null;
  });
}
