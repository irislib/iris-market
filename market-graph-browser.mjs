import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import {previewHandler} from './web/scripts/serve.mjs';
import {SocialGraph} from './web/node_modules/nostr-social-graph/dist/nostr-social-graph.es.js';
import {createNamedGraphFixture} from './web/node_modules/nostr-social-graph/dist/testing/namedGraph.js';
import { chromium } from '/driver/package/index.mjs';
async function waitFor(f,limit=18000){const until=Date.now()+limit;while(!f()){if(Date.now()>until)throw Error('Graph fixture timed out');await new Promise(r=>setTimeout(r,50));}}
const root='336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b';
const pub='npub1yscmnnadrmvape0mvgzfx9uyl267klnhzy8znsr6ysl8wtxngpqsnx6dm0';
const dist=resolve(import.meta.dirname,'web/dist');
const result={checks:[],passed:false};
const blocked=await new Promise(resolve=>{
 const s=net.connect(443,'203.0.113.1');s.once('connect',()=>{s.destroy();resolve('escaped')});s.once('error',e=>resolve(e.code));s.setTimeout(1500,()=>{s.destroy();resolve('timeout')});
});
assert(['ENETUNREACH','EHOSTUNREACH','EPERM'].includes(blocked),blocked);
const graph=new SocialGraph(root);graph.addFollower(root,'1'.repeat(64));
const f=await createNamedGraphFixture(root,await graph.toBinary());
const mobile=f.uploaded.find(x=>x.name==='mobile-'+root+'.bin').hash;
const server=createServer(previewHandler(dist,'/',false));server.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
const chunks=await readdir(resolve(dist,'chunks'));
const graphChunk=chunks.filter(x=>/^publicGraphSync-.*\.js$/.test(x));assert.equal(graphChunk.length,1);
const original=await readFile(resolve(dist,'chunks',graphChunk[0]),'utf8');assert.equal(original.split(pub).length,2);
const browser=await chromium.launch();
try{
 for(const mode of ['default','saved-empty']){
  const ctx=await browser.newContext({serviceWorkers:'block'});const loaded=[],names=[],blocks=[],posts=[],errors=[];
  try{
   await ctx.addInitScript(mode=>{if(mode==='saved-empty')localStorage.setItem('market-relays','[]');localStorage.setItem('market-ai-mode-v1','off');localStorage.setItem('market-home-feed-v1','{"enabled":false}');},mode);
   await ctx.routeWebSocket(/.*/, ws=>{ws.onMessage(raw=>{
    try{
     const [type,id,...filters]=JSON.parse(String(raw));if(type==='EVENT')posts.push(type);
     if(type==='NEG-OPEN')ws.send(JSON.stringify(['NEG-ERR',id,'unsupported']));
     if(type!=='REQ')return;
     if(filters.some(x=>x?.kinds?.includes(30064)&&x?.authors?.includes(f.event.pubkey)&&x?.['#d']?.includes('social-graph'))){
      names.push(ws.url());ws.send(JSON.stringify(['EVENT',id,f.event]));
     }
     ws.send(JSON.stringify(['EOSE',id]));
    }catch(e){errors.push(String(e))}
   });});
   await ctx.route('**/*',async route=>{const u=new URL(route.request().url());
    if(u.origin===base){loaded.push(u.pathname);if(u.pathname==='/chunks/'+graphChunk[0])return route.fulfill({contentType:'text/javascript',body:original.replace(pub,f.publisher)});return route.continue()}
    if(u.origin==='https://cdn.iris.to'&&/^\/[0-9a-f]{64}\.bin$/.test(u.pathname)){
     const hash=u.pathname.slice(1,-4),block=await f.readBlock(hash);
     if(block){blocks.push(hash);return route.fulfill({body:Buffer.from(block),contentType:'application/octet-stream',headers:{'access-control-allow-origin':'*'}})}
    }
    return route.abort('blockedbyclient');
   });
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base,{waitUntil:'domcontentloaded'});
   if(mode==='default'){
    await waitFor(()=>blocks.includes(mobile));
    assert(names.length>=1);assert(names.every(x=>['temp.iris.to','relay.primal.net'].includes(new URL(x).hostname)));
    for(const item of f.uploaded.filter(x=>x.name!=='mobile-'+root+'.bin'))assert(!blocks.includes(item.hash),item.name);
   }else{await waitFor(()=>loaded.includes('/social-graph.bin'));assert.deepEqual(names,[]);assert.deepEqual(blocks,[]);}
   await page.waitForFunction(()=>document.querySelector('#curation-status')?.textContent!=='Loading public connections…',{},{timeout:22000});
   assert.equal(await page.evaluate(()=>localStorage.getItem('market-relays')),mode==='saved-empty'?'[]':null);
   if(mode==='default'){assert(!loaded.includes('/social-graph.bin'));await page.screenshot({path:'/out/signed-market.png',animations:'disabled'});}
   assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
   result.checks.push({mode,signedNameReads:names.length,verifiedBlockRequests:blocks.length,usedBundledSeed:loaded.includes('/social-graph.bin'),publicPosts:posts.length,errors,status:await page.locator('#curation-status').textContent()});
  }finally{await ctx.close();}
 }
 result.passed=true;
} catch(e){result.error=String(e);throw e;}
finally{await browser.close();await new Promise(r=>server.close(r));await writeFile('/out/receipt.json',JSON.stringify(result,null,2));}
