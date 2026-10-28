import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools';
import { MemoryStore, HashTree, nhashDecode, toHex, sha256 } from '@hashtree/core';
import { createMediaUploader, MAX_UPLOAD_BYTES, UPLOAD_SERVER, MEDIA_SERVER } from '../src/uploads.js';
import { validateUploadAuthorization } from '../src/upload-auth.js';

function memoryStore() {
  const memory = new MemoryStore(), hashes = new Map();
  return { get: hash => memory.get(hash), has: hash => memory.has(hash), delete: async hash => {hashes.delete(toHex(hash));return memory.delete(hash);}, put: async(hash,data)=>{hashes.set(toHex(hash),hash);return memory.put(hash,data);},
    count: async()=>memory.size, totalBytes: async()=>memory.totalBytes,
    evict: async max=>{let removed=0;for(const[key,hash]of hashes){if(memory.totalBytes<=max)break;await memory.delete(hash);hashes.delete(key);removed++;}return removed;},close:()=>{},
  };
}
function fixture(t, { corruptRead=false, uploadError=false, delayReads=0, mutateSignature=false }={}) {
  const previous=globalThis.fetch, blobs=new Map(), approvals=[], requests=[], progress=[], store=memoryStore(), secret=generateSecretKey(); let remainingMisses=delayReads;
  const fetchImpl=async(url,options={})=>{
    requests.push({url,method:options.method||'GET'});
    if(url===`${UPLOAD_SERVER}/upload`){
      assert.equal(options.method,'PUT');const event=JSON.parse(atob(options.headers.Authorization.slice(6)));assert.ok(verifyEvent(event));validateUploadAuthorization(event);approvals.push(event);
      const bytes=new Uint8Array(await options.body.arrayBuffer()), hash=toHex(await sha256(bytes));assert.equal(event.tags.find(tag=>tag[0]==='x')[1],hash);if(uploadError)return new Response('unavailable',{status:503});blobs.set(hash,bytes);return Response.json({sha256:hash},{status:201});
    }
    assert.ok(url.startsWith(MEDIA_SERVER+'/'));assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');
    if(remainingMisses-->0)return new Response('not available',{status:404});
    const hash=new URL(url).pathname.slice(1).split('.')[0], value=blobs.get(hash);return new Response(corruptRead?new Uint8Array([1,2,3]):value,{status:value?200:404});
  };
  globalThis.fetch=fetchImpl;t.after(()=>{globalThis.fetch=previous;secret.fill(0);});
  const uploader=createMediaUploader({store,fetchImpl,onProgress:event=>progress.push(event),signEvent:async draft=>finalizeEvent(mutateSignature?{...draft,content:'changed'}:draft,secret),prepareImage:async file=>({blob:new Blob([new Uint8Array([137,80,78,71,1,2,3])],{type:'image/png'}),width:32,height:16})});
  t.after(()=>uploader.close());return{uploader,store,blobs,approvals,requests,progress};
}

test('generic public attachment uploads a real Hashtree leaf and verifies its fresh CDN bytes before returning', async t=>{
  const f=fixture(t), file=new File(['A public test document'], 'guide.pdf',{type:'application/pdf'}), result=await f.uploader.upload(file);
  assert.equal(result.isImage,false);assert.equal(result.mime,'application/pdf');assert.match(result.url,/^https:\/\/cdn\.iris\.to\/[a-f0-9]{64}\.pdf$/);assert.equal(toHex(nhashDecode(result.nhash).hash),result.sha256);assert.equal(nhashDecode(result.nhash).key,undefined);
  assert.equal(result.fileLink,`htree://${result.nhash}/guide.pdf`);assert.deepEqual(result.referenceTag,['r',result.fileLink]);assert.ok(result.imeta.includes(`x ${result.sha256}`));assert.equal(f.approvals.length,1);
  const tree=new HashTree({store:f.store});assert.equal(new TextDecoder().decode(await tree.readFile(nhashDecode(result.nhash))),'A public test document');assert.deepEqual(f.progress.map(event=>event.phase),['preparing','uploading','verifying','complete']);assert.equal(f.requests.at(-1).method,'GET');
});

test('raster preparation changes uploaded bytes and reports safe dimensions without touching selected file', async t=>{
  const f=fixture(t), original=new File(['test photo with metadata'], 'photo.png',{type:'image/png'}), result=await f.uploader.upload(original);
  assert.equal(result.isImage,true);assert.equal(result.size,7);assert.ok(result.imeta.includes('dim 32x16'));assert.equal(await original.text(),'test photo with metadata');assert.equal(f.blobs.get(result.sha256).length,7);
});

test('other files remain downloadable attachments and active formats are served as generic binary', async t=>{
  const f=fixture(t), result=await f.uploader.upload(new File(['<html>test</html>'],'page.html',{type:'text/html'}));assert.equal(result.isImage,false);assert.equal(result.mime,'application/octet-stream');assert.ok(result.url.endsWith('.bin'));assert.equal(result.name,'page.html');
});

test('failed upload preserves verified local bytes and never returns a publishable result', async t=>{
  const f=fixture(t,{uploadError:true}), file=new File(['keep this draft'],'file.txt',{type:'text/plain'});await assert.rejects(f.uploader.upload(file),/selected file and draft/);assert.equal(await f.store.count(),1);assert.equal(f.requests.filter(item=>item.method==='GET').length,0);assert.equal(await file.text(),'keep this draft');assert.equal(f.progress.some(item=>item.phase==='complete'),false);
});

test('a wrong CDN response cannot pass the publication gate even after a successful upload', async t=>{
  const f=fixture(t,{corruptRead:true});await assert.rejects(f.uploader.upload(new File(['expected'],'file.txt',{type:'text/plain'})),/could not be verified/);assert.equal(f.requests.filter(item=>item.method==='GET').length,3);assert.equal(f.progress.some(item=>item.phase==='complete'),false);
});

test('bounded CDN propagation retries eventually verify and retain the original content address', async t=>{
  const f=fixture(t,{delayReads:1}), result=await f.uploader.upload(new File(['eventually available'],'file.txt',{type:'text/plain'}));assert.equal(f.requests.filter(item=>item.method==='GET').length,2);assert.equal(result.sha256,toHex(await sha256(new TextEncoder().encode('eventually available'))));
});

test('cancelled and oversized selections are rejected before signing or upload', async t=>{
  const f=fixture(t), controller=new AbortController();controller.abort();await assert.rejects(f.uploader.upload(new File(['a'],'a.txt'),{signal:controller.signal}),{name:'AbortError'});await assert.rejects(f.uploader.upload({size:MAX_UPLOAD_BYTES+1,arrayBuffer:async()=>new ArrayBuffer(0)}),/8 MiB/);assert.equal(f.approvals.length,0);assert.equal(f.requests.length,0);
});

test('signer changes cannot authorize a different upload', async t=>{
  const f=fixture(t,{mutateSignature:true});await assert.rejects(f.uploader.upload(new File(['file'],'file.txt')));assert.equal(f.requests.length,0);assert.equal(await f.store.count(),1);
});

test('Blossom authorization permits only one bounded upload, never deletion or unscoped signatures',()=>{
  const now=Math.floor(Date.now()/1000), hash='a'.repeat(64), valid={kind:24242,created_at:now,content:`upload ${hash}`,tags:[['t','upload'],['x',hash],['expiration',String(now+300)]]};assert.equal(validateUploadAuthorization(valid,hash),valid);
  for(const changed of [{...valid,content:'delete everything'},{...valid,tags:[['t','delete'],...valid.tags.slice(1)]},{...valid,tags:[...valid.tags,['x','b'.repeat(64)]]},{...valid,tags:[...valid.tags.slice(0,2),['expiration',String(now+301)]]},{...valid,created_at:now-400},{...valid,kind:1}])assert.throws(()=>validateUploadAuthorization(changed,hash),/Invalid file upload approval/);
});
