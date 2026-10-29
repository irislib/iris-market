import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createOfflineShell} from '../src/offline-shell.ts'
import {registerPwa} from '../src/pwa.ts'

const hash=text=>createHash('sha256').update(text).digest('hex')
const revision=hash('release one'),scope='https://example.com/mount/market/'
const bodies={'index.html':'<!doctype html><title>Market</title>','app.js':'export const app=true','chunks/map-A.js':'export const map=true'}
const assets=Object.entries(bodies).map(([path,text])=>({path,sha256:hash(text),bytes:Buffer.byteLength(text)}))
function memoryCaches(){
  const stores=new Map()
  return{stores,async open(name){if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);return{async put(url,response){store.set(url,response.clone())},async match(url){return store.get(url)?.clone()}}},async keys(){return [...stores.keys()]},async delete(name){return stores.delete(name)}}
}
const navigation=path=>({url:new URL(path,scope).href,method:'GET',mode:'navigate'})
const fetchAsset=async request=>new Response(bodies[new URL(request.url).pathname.slice(new URL(scope).pathname.length)],{headers:{'Content-Type':request.url.endsWith('.html')?'text/html':'application/javascript'}})

test('installs a verified release and serves routed pages and chunks completely offline',async()=>{
  const caches=memoryCaches();let online=true,calls=0
  const shell=createOfflineShell({scope,revision,assets,caches,fetch:async request=>{calls++;if(!online)throw new Error('offline');assert.equal(request.credentials,'omit');return fetchAsset(request)}})
  await shell.install();online=false
  for(const path of ['', 'saved','post','courier','settings/profile','orders/order123','messages','wallet']){
    const request=navigation(path);assert(shell.handles(request));assert.equal(await(await shell.respond(request)).text(),bodies['index.html'])
  }
  const chunk=new Request(new URL('chunks/map-A.js',scope));assert(shell.handles(chunk));assert.equal(await(await shell.respond(chunk)).text(),bodies['chunks/map-A.js'])
  assert.equal(calls,assets.length)
})

test('shell refuses private, external, API, uploaded and non-GET responses',()=>{
  const shell=createOfflineShell({scope,revision,assets,caches:memoryCaches(),fetch:fetchAsset})
  for(const path of ['api/orders','upload/document.pdf','invite','../private','unknown','settings/secret'])assert.equal(shell.handles(navigation(path)),false,path)
  for(const url of ['https://other.example/app.js',new URL('app.js?token=secret',scope),new URL('secret.key',scope)])assert.equal(shell.handles(new Request(url)),false)
  assert.equal(shell.handles(new Request(new URL('app.js',scope),{method:'POST',body:'private'})),false)
})

test('tampered or incomplete new releases do not replace the working offline release',async()=>{
  const caches=memoryCaches(),old=createOfflineShell({scope,revision,assets,caches,fetch:fetchAsset});await old.install()
  const next=createOfflineShell({scope,revision:hash('new'),assets,caches,fetch:async request=>request.url.endsWith('app.js')?new Response('forged'):fetchAsset(request)})
  await assert.rejects(next.install(),/verification|bound/)
  assert.deepEqual(await caches.keys(),[old.name]);assert.equal(await(await old.respond(navigation('saved'))).text(),bodies['index.html'])
  const missing=createOfflineShell({scope,revision:hash('missing'),assets,caches,fetch:async()=>new Response('missing',{status:404})})
  await assert.rejects(missing.install(),/unavailable/)
})

test('activation retires only old releases from the same mount, preserving private stores and other apps',async()=>{
  const caches=memoryCaches(),old=createOfflineShell({scope,revision,assets,caches,fetch:fetchAsset});await old.install()
  await caches.open('private-vault');await caches.open(`iris-market-shell:https://example.com/other/:${revision}`)
  const next=createOfflineShell({scope,revision:hash('next'),assets,caches,fetch:fetchAsset});await next.install();await next.activate()
  assert.deepEqual((await caches.keys()).sort(),['private-vault',`iris-market-shell:https://example.com/other/:${revision}`,next.name].sort())
})

test('cache eviction uses network without persisting an unverified replacement',async()=>{
  const caches=memoryCaches(),shell=createOfflineShell({scope,revision,assets,caches,fetch:async()=>new Response('new network page')})
  assert.equal(await(await shell.respond(navigation('saved'))).text(),'new network page')
  assert.equal(caches.stores.get(shell.name).size,0)
})

test('invalid paths, hashes and unbounded releases are rejected before any download',()=>{
  const make=items=>createOfflineShell({scope,revision,assets:items,caches:memoryCaches(),fetch:fetchAsset})
  for(const path of ['../private','/app.js','https://evil.test/a','a//b','a?key=secret'])assert.throws(()=>make([...assets,{...assets[1],path}]),/Invalid/)
  assert.throws(()=>make([{...assets[0],bytes:25*1024*1024}]),/bound/)
  assert.throws(()=>make([{...assets[0],sha256:'bad'}]),/Invalid/)
})

test('registration stays at the current deployment base and never forces active tabs to reload',async()=>{
  const calls=[],serviceWorker={register:async(...args)=>{calls.push(args);return{scope:args[1].scope}}}
  const result=await registerPwa({serviceWorker,href:`${scope}index.html`})
  assert.equal(result.scope,'/mount/market/');assert.deepEqual(calls[0],[`${scope}sw.js`,{scope:'/mount/market/',type:'module',updateViaCache:'none'}])
  await registerPwa({serviceWorker,href:'http://untrusted.example/'});assert.equal(calls.length,1)
  assert.equal(await registerPwa({serviceWorker:{register:async()=>{throw new Error('private mode')}},href:scope}),null)
})

test('manifest has portable start/scope and opaque icons at installation sizes',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../manifest.webmanifest',import.meta.url),'utf8'))
  assert.equal(manifest.start_url,'./');assert.equal(manifest.scope,'./');assert.equal(manifest.display,'standalone')
  for(const size of [192,512]){
    const icon=manifest.icons.find(icon=>icon.sizes===`${size}x${size}`);assert(icon)
    const png=await readFile(new URL(`../${icon.src}`,import.meta.url));assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);assert.equal(png[25],2)
  }
})
