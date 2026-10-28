import { HashTree, BlossomStore, nhashEncode, sha256, toHex } from '@hashtree/core';
import { getEventHash, verifyEvent } from 'nostr-tools';
import { MapBlockCache, readBounded } from './map/cache.js';
import { DEFAULT_CACHE_MIB } from './map/config.js';
import { validateUploadAuthorization } from './upload-auth.js';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const UPLOAD_SERVER = 'https://upload.iris.to';
export const MEDIA_SERVER = 'https://cdn.iris.to';
const rasterTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const extensionFor = mime => ({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf','text/plain':'txt','application/zip':'zip' })[mime] || 'bin';
const checkAbort = signal => { if (signal?.aborted) throw new DOMException('File upload cancelled', 'AbortError'); };
function safeFilename(name, extension) {
  const basename = String(name || `file.${extension}`).split(/[\\/]/).at(-1).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (basename || `file.${extension}`).slice(0, 160);
}

/** Raster re-encoding strips EXIF/GPS and avoids publishing the original photo metadata. */
export async function preparePhoto(file, { signal } = {}) {
  checkAbort(signal);
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot prepare photos. Try a current browser.');
  const bitmap = await createImageBitmap(file);
  try {
    checkAbort(signal);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 48_000_000) throw new Error('Choose a photo under 48 megapixels.');
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height)), width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d'); if (!context) throw new Error('This browser could not prepare the photo.');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: file.type, quality: 0.9 }) : await new Promise(resolve => canvas.toBlob(resolve, file.type, 0.9));
    checkAbort(signal);
    if (!blob || !rasterTypes.has(blob.type)) throw new Error('This browser could not prepare the photo.');
    return { blob, width, height };
  } finally { bitmap.close(); }
}

/** Public leaf blobs have ordinary HTTPS URLs and complete unencrypted Hashtree CIDs. */
export function createMediaUploader({ signEvent, getCacheMiB = () => DEFAULT_CACHE_MIB, onProgress = () => {}, store, fetchImpl = globalThis.fetch, prepareImage = preparePhoto } = {}) {
  let cache, closed = false, queue = Promise.resolve();
  const progress = (phase, loaded, total) => { try { onProgress({phase,loaded,total}); } catch {} };
  const run = async (file, { signal } = {}) => {
    if (closed) throw new Error('File uploader is closed.');
    if (typeof signEvent !== 'function') throw new Error('Sign in to upload a file.');
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_UPLOAD_BYTES || typeof file.arrayBuffer !== 'function') throw new Error('Choose a file between 1 byte and 8 MiB.');
    checkAbort(signal); progress('preparing',0,file.size);
    const type = String(file.type || '').toLowerCase();
    const isImage = rasterTypes.has(type);
    const prepared = isImage ? await prepareImage(file,{signal}) : { blob:file };
    checkAbort(signal);
    const mime = isImage ? prepared.blob.type : ['application/pdf','text/plain','application/zip'].includes(type) ? type : 'application/octet-stream';
    if (isImage && !rasterTypes.has(mime)) throw new Error('Could not prepare this photo.');
    const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error('The prepared file is larger than 8 MiB.');
    checkAbort(signal);
    cache ||= new MapBlockCache({ cacheMiB:getCacheMiB(), ...(store?{store}:{}), fetchImpl });
    await cache.ready; await cache.setCacheMiB(getCacheMiB());
    const tree = new HashTree({ store: {
      get: hash => cache.store.get(hash), has: hash => cache.store.has(hash), delete: async () => false,
      put: (hash,data) => cache.mutate(async () => {
        if (toHex(await sha256(data)) !== toHex(hash)) throw new Error('File integrity check failed.');
        const existing = await cache.store.get(hash);
        if (existing && toHex(await sha256(existing)) === toHex(hash)) return false;
        await cache.enforceLimit(Math.max(0,cache.maxBytes-data.length)); await cache.store.put(hash,data); await cache.enforceLimit(cache.maxBytes);
        const saved = await cache.store.get(hash);
        if (!saved || toHex(await sha256(saved)) !== toHex(hash)) throw new Error('Could not save the selected file.');
        return true;
      }),
    } });
    const hash = await tree.putBlob(bytes), hashHex = toHex(hash); checkAbort(signal);
    const extension = extensionFor(mime), name = safeFilename(file.name,extension), url = `${MEDIA_SERVER}/${hashHex}.${extension}`;
    const remote = new BlossomStore({ servers:[{url:UPLOAD_SERVER,write:true,read:false}], putTimeoutMs:15000, maxConcurrentWrites:1, skipExistenceCheck:true,
      signer: async draft => {
        checkAbort(signal); validateUploadAuthorization(draft,hashHex);
        const expected = structuredClone(draft), signed = structuredClone(await signEvent(structuredClone(expected)));
        checkAbort(signal); validateUploadAuthorization(signed,hashHex);
        if (!verifyEvent(signed) || getEventHash({...expected,pubkey:signed.pubkey}) !== signed.id) throw new Error('The signer changed this file upload approval.');
        return signed;
      },
    });
    progress('uploading',0,bytes.length);
    try { await remote.put(hash,bytes,mime); }
    catch (error) { if (signal?.aborted) checkAbort(signal); throw new Error('Could not upload the file. Your selected file and draft are still here.'); }
    checkAbort(signal); progress('verifying',bytes.length,bytes.length);
    // A successful PUT/HEAD alone does not establish that the public file is readable or correct.
    let verified = false;
    for (let attempt=0; attempt<3; attempt++) {
      checkAbort(signal);
      try {
        const response = await fetchImpl(url,{credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])])});
        const returned = await readBounded(response,MAX_UPLOAD_BYTES);
        if (returned.length !== bytes.length || toHex(await sha256(returned)) !== hashHex) throw new Error('Uploaded file failed its integrity check.');
        verified=true; break;
      } catch (error) {
        checkAbort(signal);
        if (attempt===2) throw new Error('The file was uploaded but could not be verified yet. Your draft is still here; retry before publishing.');
        await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
    }
    if (!verified) throw new Error('The uploaded file could not be verified.');
    checkAbort(signal);
    const nhash = nhashEncode({hash}), fileLink=`htree://${nhash}/${encodeURIComponent(name)}`;
    const imeta=['imeta',`url ${url}`,`x ${hashHex}`,`m ${mime}`,`size ${bytes.length}`,`alt ${name}`];
    if(isImage&&prepared.width&&prepared.height)imeta.push(`dim ${prepared.width}x${prepared.height}`);
    progress('complete',bytes.length,bytes.length);
    return Object.freeze({url,nhash,fileLink,sha256:hashHex,mime,size:bytes.length,name,isImage,imeta:Object.freeze(imeta),referenceTag:Object.freeze(['r',fileLink])});
  };
  return {
    upload(file,options) { const result=queue.then(()=>run(file,options));queue=result.catch(()=>{});return result; },
    async close() { closed=true;await queue;await cache?.close(); },
  };
}
