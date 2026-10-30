import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fstatSync,statSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {startDemoRelay} from './relay.ts';
import {startDemoActors} from './actors.ts';
import {startLocalTestMint} from './local-mint.ts';
import {maintainLocalModel} from './ollama.ts';

const directory=resolve(process.env.MARKET_DEMO_ASSETS??resolve(import.meta.dirname,'../../dist'));
const requestedPort=Number(process.env.MARKET_DEMO_PORT??0),relayPort=Number(process.env.MARKET_DEMO_RELAY_PORT??0);
for(const value of [requestedPort,relayPort])if(!Number.isInteger(value)||value!==0&&(value<1024||value>65535))throw new Error('Choose unprivileged local ports, or 0 for automatic.');
const stateDir=process.env.MARKET_DEMO_STATE_DIR;
if(stateDir&&(!requestedPort||!relayPort))throw new Error('Persistent demo state requires fixed web and relay ports.');
const password=stateDir?await readFile(process.env.MARKET_DEMO_SECRET_FILE!,'utf8'):undefined;
if(stateDir){
  const descriptor=Number(process.env.MARKET_DEMO_LOCK_FD);
  if(!Number.isInteger(descriptor)||descriptor<3)throw new Error('Start persistent demos through service-runner.py.');
  const held=fstatSync(descriptor),expected=statSync(resolve(stateDir,'service.lock'));
  if(held.ino!==expected.ino||held.dev!==expected.dev)throw new Error('Invalid demo service lock.');
}
const base=await readFile(resolve(directory,'index.html'),'utf8').catch(()=>{throw new Error('Build the web app first: npm run build --prefix web');});
const scriptHashes=[...base.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join(' ');
const boot=process.env.MARKET_DEMO_BOOT_FILE?await readFile(process.env.MARKET_DEMO_BOOT_FILE,'utf8'):(await (await import('esbuild')).transform(await readFile(resolve(import.meta.dirname,'boot.ts'),'utf8'),{loader:'ts',target:'es2022'})).code;
let handle=(req,res)=>{res.writeHead(503);res.end('Starting demo');};
const server=createServer((req,res)=>handle(req,res));
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,'127.0.0.1',resolve);});
const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
const relay=await startDemoRelay(relayPort,{stateDir,allowedOrigin:origin});
const localModel=maintainLocalModel(process.env.MARKET_DEMO_MODEL??'',{expectedDigest:process.env.MARKET_DEMO_MODEL_DIGEST,openApp:process.env.MARKET_DEMO_MANAGE_OLLAMA==='1'});
const localMint=await startLocalTestMint();
const actorStateDir=stateDir?resolve(stateDir,'runs',randomUUID()):undefined;
const actors=await startDemoActors({relay:relay.url,origin,mintUrl:localMint.url,model:process.env.MARKET_DEMO_MODEL??'',stateDir:actorStateDir,password,modelReady:()=>localModel.state().state==='ready'}).catch(async error=>{await localMint.close();await relay.close();localModel.close();server.close();throw error;});
const styles=`.demo-banner{display:flex;gap:1rem;justify-content:space-between;align-items:center;padding:.65rem max(20px,calc((100vw - 1400px)/2));background:#eeeaf8;color:#493a64;font-size:13px}.demo-banner a{color:inherit;white-space:nowrap}body.demo-home{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f7f7fa;color:#232329}.demo-home main{max-width:920px;margin:9vh auto;padding:24px}.demo-home h1{font-size:clamp(32px,6vw,52px);letter-spacing:-.045em;line-height:1.1;margin:20px 0}.demo-home p{color:#686872}.demo-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px;margin:32px 0}.demo-card{display:block;background:white;border:1px solid #e6e6eb;border-radius:24px;overflow:hidden;color:inherit;text-decoration:none;box-shadow:0 8px 32px #24223b05;transition:transform .15s}.demo-card:hover{transform:translateY(-3px)}.demo-card img{display:block;width:100%;aspect-ratio:1.6;object-fit:contain;background:#f0eff7}.demo-card section{padding:24px}.demo-card h2{margin:0 0 8px;font-size:22px}.demo-card span{display:inline-block;padding:11px 18px;background:#25232d;color:#fff;border-radius:14px;margin-top:10px}.demo-note{font-size:14px}.demo-home a:focus-visible{outline:3px solid #7963b6;outline-offset:4px}@media(prefers-color-scheme:dark){body.demo-home{background:#18181d;color:#eeeef3}.demo-home p{color:#aaaab6}.demo-card{background:#222229;border-color:#363640}.demo-card img{background:#282630}.demo-card span{background:#ddd7ed;color:#25232d}.demo-banner{background:#302a3b;color:#ded5ec}}@media(max-width:520px){.demo-banner{align-items:flex-start;font-size:12px}.demo-home main{margin:3vh auto}}`;
const art=(kind:string)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><rect width="640" height="400" fill="#eeedf5"/><path d="M70 320C170 230 240 350 330 255S440 160 570 90" fill="none" stroke="#cbc5db" stroke-width="4" stroke-dasharray="9 12"/><circle cx="80" cy="315" r="12" fill="#aa99c5"/><circle cx="565" cy="94" r="12" fill="#aa99c5"/>${kind==='ride'?'<g fill="#706284"><path d="M224 222l25-60c5-11 16-18 28-18h93c12 0 23 7 28 18l25 60v50H224z"/><rect x="236" y="251" width="32" height="40" rx="12"/><rect x="379" y="251" width="32" height="40" rx="12"/></g><path d="M269 163h108l17 47H252z" fill="#e4dfed"/><rect x="242" y="230" width="30" height="10" rx="5" fill="#f5eed5"/><rect x="376" y="230" width="30" height="10" rx="5" fill="#f5eed5"/>':'<g stroke="#706284" stroke-width="10" stroke-linecap="round"><path d="M268 148l104 64m0-64l-104 64"/><ellipse cx="258" cy="141" rx="43" ry="14" fill="#e4dfed"/><ellipse cx="382" cy="141" rx="43" ry="14" fill="#e4dfed"/><ellipse cx="258" cy="217" rx="43" ry="14" fill="#e4dfed"/><ellipse cx="382" cy="217" rx="43" ry="14" fill="#e4dfed"/></g><rect x="295" y="153" width="50" height="53" rx="17" fill="#706284"/><path d="M306 211v30m28-30v30" stroke="#aa99c5" stroke-width="4"/><rect x="290" y="240" width="60" height="49" rx="7" fill="#c9b797"/><path d="M320 240v17" stroke="#eee3ce" stroke-width="7"/>'}</svg>`;
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const landing=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marketplace demos · Iris Market</title><link rel="stylesheet" href="/_demo/style.css"></head><body class="demo-home"><main><p>Iris Market</p><h1>Take it for a spin.</h1><p>Buy an imaginary parcel, hire a separate courier, or try a two-minute ride using the normal marketplace and wallet.</p><div class="demo-cards">${actors.listings.map(item=>`<a class="demo-card" href="${escape(item.url)}"><img src="/_demo/${item.kind==='ride'?'ride':'delivery'}.svg" alt="${item.kind==='ride'?'A car on a dotted route':'A drone carrying a parcel'}"><section><h2>${escape(item.title)}</h2><p>${item.kind==='product'?'16 test sats. Buy from the shop, then arrange delivery separately.':item.kind==='ride'?'8 test sats. Pickup, boarding and arrival.':'8 test sats. Collect your parcel and follow the drone.'}</p><span>${item.kind==='product'?'Buy the parcel':item.kind==='ride'?'Request a ride':'Hire a courier'}</span></section></a>`).join('')}</div><p>Create a test profile, then choose <strong>Buy → Request order</strong>. In the order chat, receive the provider’s test Cashu token in your wallet. A 128-test-sat token yields 127 after the local mint’s receive fee. Pay the requested amount from the order; the provider verifies receipt before accepting.</p><p>For a parcel, choose <strong>Arrange delivery</strong> after purchase to hire the courier separately. Provide pickup and destination instructions and authorize collection on the product order. Open Orders to follow a paid courier or ride, or Message to chat.</p><p class="demo-note">Simulation only. The genuine local CDK test mint has unbacked, temporary state. Test sats have no monetary value; use no real funds. No real booking, product or journey. Fictional Helsinki routes; your location is not used. ${stateDir?'This run’s profiles, wallets and orders are retained on this computer, but its unbacked mint resets when the service stops.':'Demo actors reset when the server stops.'}${process.env.MARKET_DEMO_MODEL?' Local Ollama replies are enabled, with scripted replies if it is unavailable.':' Replies are scripted.'}</p></main></body></html>`;
const types={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.woff2':'font/woff2'};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy':`default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${scriptHashes}; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${relay.url} https://cdn.iris.to ${localMint.url}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`};
handle=async(req,res)=>{
  try {
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host??'')){res.writeHead(403);res.end();return;}
    if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405);res.end();return;}
    const requestURL=new URL(req.url!,origin),path=decodeURIComponent(requestURL.pathname);
    let content:string|Buffer,extension=extname(path);
    if(path==='/demo'||path==='/'&&!requestURL.searchParams.has('test-relay')){content=landing;extension='.html';}
    else if(path==='/_demo/style.css'){content=styles;extension='.css';}
    else if(path==='/_demo/boot.js'){content=boot;extension='.js';}
    else if(['/_demo/ride.svg','/_demo/delivery.svg'].includes(path)){content=art(path.includes('ride')?'ride':'delivery');extension='.svg';}
    else if(path==='/_demo/status'){content=JSON.stringify({ready:true,persistent:!!stateDir,active:actors.active(),events:relay.eventCount(),errors:actors.errors,model:localModel.state(),replies:actors.replyStats()});extension='.json';}
    else if(path==='/sw.js'){content="self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.registration.unregister()));";extension='.js';}
    else {
      const file=resolve(directory,'.'+path);if(!file.startsWith(directory+sep))throw new Error('Invalid path');
      try {content=await readFile(file);}catch {if(extension)throw new Error('Not found');content=base;extension='.html';}
      if(extension==='.html')content=String(content).replace('<html lang="en">',`<html lang="en" data-demo-relay="${relay.url}" data-demo-mint="${localMint.url}">`).replace('<head>','<head><script src="/_demo/boot.js"></script><link rel="stylesheet" href="/_demo/style.css">');
    }
    res.writeHead(200,{...headers,'Content-Type':types[extension]??'application/octet-stream'});res.end(req.method==='HEAD'?undefined:content);
  }catch{res.writeHead(404,headers);res.end('Not found');}
};
process.stdout.write(`Transport demos: ${origin}/demo\n`);
let closing=false;
async function close(){if(closing)return;closing=true;localModel.close();await actors.close();await localMint.close();await relay.close();server.close(()=>process.exit(0));}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
server.on('error',async error=>{console.error(error.message);await close();});
