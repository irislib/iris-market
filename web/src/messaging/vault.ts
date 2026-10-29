const DB_NAME = 'iris-market-private';
const ROW = 'vault';
const MAX_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clone = <T>(value: T): T => value === undefined ? undefined : structuredClone(value);
export interface VaultRow {schema:number;mode:'password'|'device';version?:number;key?:CryptoKey;salt?:Uint8Array<ArrayBuffer>;iterations?:number;iv?:Uint8Array<ArrayBuffer>;ciphertext?:ArrayBuffer}
export interface VaultBackend {read():Promise<VaultRow|undefined>;write(value:VaultRow,expectedVersion?:number):Promise<void>}
export interface Vault {status():Promise<{exists:boolean;locked:boolean;password:boolean}>;create(initial?:Record<string,unknown>,options?:{password?:string}):Promise<void>;unlock(password?:string):Promise<boolean>;lock():void;get<T=unknown>(name:string):Promise<T|undefined>;put<T>(name:string,value:T):Promise<void>;del(name:string):Promise<void>;list(prefix?:string):Promise<string[]>;flush():Promise<void>}

/** A single encrypted snapshot makes each store mutation durable and atomic. */
export function indexedDbVaultBackend(indexedDBImpl = globalThis.indexedDB, databaseName = DB_NAME): VaultBackend {
  let database: Promise<IDBDatabase>;
  const open = async () => {
    if (!indexedDBImpl) throw new Error('Private storage is unavailable in this browser.');
    if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDBImpl.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('private');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not open private storage.'));
      request.onblocked = () => reject(new Error('Close other Market tabs to open private storage.'));
    });
    return database;
  };
  const transact = async <T>(mode:IDBTransactionMode, operation:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('private', mode);
      const request = operation(tx.objectStore('private'));
      let result:T;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('Could not save private storage.'));
    });
  };
  return {
    read: () => transact('readonly', store => store.get(ROW)),
    async write(value, expectedVersion) {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction('private', 'readwrite');
        const store = tx.objectStore('private');
        const reading = store.get(ROW);
        let conflict = false;
        reading.onsuccess = () => {
          if ((reading.result?.version ?? 0) !== expectedVersion) { conflict = true; tx.abort(); return; }
          store.put(value, ROW);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error(conflict ? 'Data changed in another tab. Reload this page.' : 'Could not save private storage.'));
      });
    },
  };
}

async function passwordKey(password, salt, cryptoImpl, iterations = 600_000) {
  const material = await cryptoImpl.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return cryptoImpl.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Browser-managed keys protect data at rest; they cannot protect an unlocked page from malicious code. */
export function createVault({ backend = indexedDbVaultBackend(), cryptoImpl = globalThis.crypto }: {backend?:VaultBackend;cryptoImpl?:Crypto} = {}): Vault {
  let key:CryptoKey, row:VaultRow, values:Map<string,unknown>, revision = 0;
  let queue = Promise.resolve();
  const assertOpen = () => { if (!key || !values) throw new Error('Unlock private storage first.'); };
  const serial = <T>(operation:()=>T|Promise<T>):Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(()=>{},() => {});
    return result;
  };
  const save = async (next:Map<string,unknown>) => {
    assertOpen();
    const attempt = revision;
    const bytes = encoder.encode(JSON.stringify({ schema: 1, entries: [...next] }));
    if (bytes.length > MAX_BYTES || next.size > 5000) throw new Error('Private storage is full.');
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('iris-market-vault-v1') }, key, bytes);
    const updated = { ...row, version: (row.version ?? 0) + 1, iv, ciphertext };
    await backend.write(updated, row.version ?? 0);
    if (attempt !== revision) throw new Error('Private storage was locked.');
    row = updated;
    values = next;
  };
  return {
    async status() {
      const stored = await backend.read();
      return { exists: !!stored, locked: !key, password: stored?.mode === 'password' };
    },
    create(initial = {}, { password }: {password?:string} = {}) {
      return serial(async () => {
        if (await backend.read()) throw new Error('An account already exists on this device.');
        if (password && password.length < 8) throw new Error('Use at least 8 characters for your password.');
        if (!cryptoImpl?.subtle) throw new Error('Private storage requires a secure browser connection.');
        const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
        key = password ? await passwordKey(password, salt, cryptoImpl)
          : await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        row = password ? { schema: 1, mode: 'password', salt, iterations: 600_000 }
          : { schema: 1, mode: 'device', key };
        values = new Map();
        try { await save(new Map(Object.entries(initial))); }
        catch (error) { key = row = values = undefined; throw error; }
      });
    },
    unlock(password) {
      return serial(async () => {
        const attempt = revision;
        const stored = await backend.read();
        if (!stored) return false;
        if (stored.schema !== 1 || !['device', 'password'].includes(stored.mode)) throw new Error('Unsupported private storage.');
        if (stored.mode === 'password' && (!password || stored.iterations !== 600_000)) throw new Error('Enter your password.');
        const candidate = stored.mode === 'password' ? await passwordKey(password, stored.salt, cryptoImpl, stored.iterations) : stored.key;
        try {
          if (!candidate || candidate.extractable || candidate.algorithm?.name !== 'AES-GCM') throw new Error('Invalid key');
          const decrypted = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv,
            additionalData: encoder.encode('iris-market-vault-v1') }, candidate, stored.ciphertext);
          if (decrypted.byteLength > MAX_BYTES) throw new Error('Invalid storage');
          const data = JSON.parse(decoder.decode(decrypted));
          if (data.schema !== 1 || !Array.isArray(data.entries) || data.entries.length > 5000) throw new Error('Invalid storage');
          if (attempt !== revision) throw new Error('Unlock cancelled.');
          key = candidate; row = stored; values = new Map(data.entries);
          return true;
        } catch { throw new Error(stored.mode === 'password' ? 'Could not unlock. Check your password.' : 'Could not open private storage.'); }
      });
    },
    lock() { revision++; key = row = values = undefined; },
    get<T>(name:string) { return serial(() => { assertOpen(); return clone(values.get(name)) as T|undefined; }); },
    put(name, value) { return serial(async () => { assertOpen(); const next = new Map(values); next.set(name, clone(value)); await save(next); }); },
    del(name) { return serial(async () => { assertOpen(); const next = new Map(values); next.delete(name); await save(next); }); },
    list(prefix = '') { return serial(() => { assertOpen(); return [...values.keys()].filter(name => name.startsWith(prefix)); }); },
    flush() { return queue; },
  };
}
