import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {runInNewContext} from 'node:vm'
import {buildPwa} from '../scripts/pwa-build.mjs'

test('release builder includes current hashed chunks only and changes revision with release bytes',async()=>{
  const root=resolve(import.meta.dirname,'..'),dest=await mkdtemp(join(tmpdir(),'market-pwa-test-'))
  try{
    for(const name of ['index.html','styles.css','profiles.css','account.css','wallet.css','orders.css','notifications.css','maplibre-gl.css','theme-init.js','icon.svg','social-graph.bin','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs'])await writeFile(join(dest,name),name==='index.html'?'<!doctype html><title>Market</title>':'asset')
    await mkdir(join(dest,'chunks'))
    await writeFile(join(dest,'app.js'),'import "./chunks/current.js"')
    await writeFile(join(dest,'chunks/current.js'),'export const current=true')
    await writeFile(join(dest,'chunks/stale.js'),'old release')
    await writeFile(join(dest,'private-response.json'),'private')
    const results=[{metafile:{outputs:{[join(dest,'app.js')]:{},[join(dest,'chunks/current.js')]:{}}}}]
    const first=await buildPwa({root,dest,results}),same=await buildPwa({root,dest,results})
    assert.equal(first.revision,same.revision);assert(first.bytes<24*1024*1024);assert(first.assets<=256)
    const sw=await readFile(join(dest,'sw.js'),'utf8')
    assert(sw.includes('chunks/current.js'));assert(!sw.includes('chunks/stale.js'));assert(!sw.includes('private-response.json'))
    // Exercise the actual bundled worker wiring, without a browser or external
    // requests, so install verification is covered through the release entry.
    const handlers=new Map(),stored=new Map(),downloads=[]
    const worker={registration:{scope:'https://market.example/mount/'},addEventListener:(type,listener)=>handlers.set(type,listener),caches:{async open(){return{async put(url,response){stored.set(url,response)},async match(url){return stored.get(url)?.clone()}}},async keys(){return[]},async delete(){return true}},async fetch(request){downloads.push(request.url);return new Response(await readFile(join(dest,new URL(request.url).pathname.slice('/mount/'.length))))}}
    runInNewContext(sw,{self:worker,crypto,Request,Response,Headers,URL,Uint8Array,Map,Error,Number,Array})
    let installed;handlers.get('install')({waitUntil:promise=>{installed=promise}});await installed
    assert.equal(downloads.length,first.assets);assert(stored.has('https://market.example/mount/chunks/current.js'))
    worker.fetch=async()=>{throw new Error('offline')};let response
    handlers.get('fetch')({request:{url:'https://market.example/mount/settings/profile',mode:'navigate',method:'GET'},respondWith:promise=>{response=promise}})
    assert.match(await(await response).text(),/<title>Market/)
    await writeFile(join(dest,'chunks/current.js'),'export const current="updated"')
    const changed=await buildPwa({root,dest,results});assert.notEqual(changed.revision,first.revision)
  }finally{await rm(dest,{recursive:true,force:true})}
})
