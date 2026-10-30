import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fstatSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {DEFAULT_RELAYS} from '../../src/market.ts';
import {startDemoActors} from './actors.ts';
import {maintainLocalModel} from './ollama.ts';

// Public traffic uses outbound Nostr WSS. HTTP serves loopback health only.
const port=Number(process.env.MARKET_DEMO_PORT??4194);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose a fixed unprivileged local health port.');
const stateDir=process.env.MARKET_DEMO_STATE_DIR;
if(!stateDir)throw new Error('Public demos require dedicated persistent state.');
const descriptor=Number(process.env.MARKET_DEMO_LOCK_FD);
if(!Number.isInteger(descriptor)||descriptor<3)throw new Error('Start public demos through service-runner.py.');
const held=fstatSync(descriptor),expected=statSync(resolve(stateDir,'service.lock'));
if(held.ino!==expected.ino||held.dev!==expected.dev)throw new Error('Invalid demo service lock.');
const password=await readFile(process.env.MARKET_DEMO_SECRET_FILE!,'utf8');
const publicRelays=[...DEFAULT_RELAYS];
if(publicRelays.some(relay=>new URL(relay).protocol!=='wss:'))throw new Error('Public demo relays require WSS.');
let actors:Awaited<ReturnType<typeof startDemoActors>>|undefined,closing=false;
const localModel=maintainLocalModel(process.env.MARKET_DEMO_MODEL??'',{expectedDigest:process.env.MARKET_DEMO_MODEL_DIGEST,openApp:process.env.MARKET_DEMO_MANAGE_OLLAMA==='1'});
const server=createServer((req,res)=>{
  const headers={'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host??'')){res.writeHead(403,headers);res.end();return;}
  if(!['GET','HEAD'].includes(req.method??'')){res.writeHead(405,headers);res.end();return;}
  if(req.url!=='/_demo/status'){res.writeHead(404,headers);res.end();return;}
  res.writeHead(actors?200:503,headers);
  res.end(req.method==='HEAD'?undefined:JSON.stringify({ready:!!actors,persistent:true,mode:'public',active:actors?.active()??0,errors:actors?.errors??[],model:localModel.state(),replies:actors?.replyStats(),listings:actors?.listings,clients:actors?.clients.map(client=>({canSend:client.state().canSend,pendingPublic:client.state().pendingPublic}))}));
});
async function close(){if(closing)return;closing=true;localModel.close();await actors?.close();server.close(()=>process.exit(0));}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
try {
  // Reserve health before creating or publishing bot identities.
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  actors=await startDemoActors({publicRelays,origin:'https://market.iris.to',stateDir,password,tickMs:10000,model:process.env.MARKET_DEMO_MODEL??'',modelReady:()=>localModel.state().state==='ready'});
  console.log(`Public demo ready; local health: http://127.0.0.1:${port}/_demo/status`);
  server.on('error',()=>void close());
}catch(error){localModel.close();await actors?.close();server.close();throw error;}
