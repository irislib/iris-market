const MAX_BYTES = 8 * 1024 * 1024;
const ITERATIONS = 600_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const domain = encoder.encode('iris-market-cashu-backup-v1');
const b64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text); };
const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function key(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a backup passphrase of 12 to 1,024 characters.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptBackup(data, passphrase) {
  const plain = encoder.encode(JSON.stringify(data));
  if (plain.length > MAX_BYTES) throw new Error('Wallet backup is too large.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: domain }, await key(passphrase, salt), plain);
  return JSON.stringify({ format: 'iris-market-cashu', version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) });
}
export async function decryptBackup(text, passphrase) {
  if (typeof text !== 'string' || text.length > Math.ceil(MAX_BYTES * 4 / 3) + 1024) throw new Error('Wallet backup is too large.');
  try {
    const envelope = JSON.parse(text);
    if (envelope.format !== 'iris-market-cashu' || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256' || envelope.iterations !== ITERATIONS || typeof envelope.ciphertext !== 'string') throw new Error();
    const salt = bytes(envelope.salt), iv = bytes(envelope.iv), ciphertext = bytes(envelope.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length > MAX_BYTES + 16) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: domain }, await key(passphrase, salt), ciphertext);
    return JSON.parse(decoder.decode(plain));
  } catch { throw new Error('Could not open the backup. Check the file and passphrase.'); }
}
