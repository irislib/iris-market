/** Public read-only snapshot refresh. Reproduce bytes offline with:
 * node scripts/generate-profile-bootstrap.mjs --input src/data/profile-bootstrap.json --output /tmp/profile-bootstrap.json
 * Refresh deliberately with --fetch; inspect both changed JSON files before release.
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyEvent} from 'nostr-tools/pure';
import {verifyProfileRecord,DEFAULT_SOCIAL_GRAPH_ROOT} from '../src/profiles.ts';
import {decodeGraphBootstrap,GRAPH_BOOTSTRAP} from '../src/graph-bootstrap.ts';

const root=new URL('../',import.meta.url),args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
const output=args.includes('--output')?arg('--output'):fileURLToPath(new URL('src/data/profile-bootstrap.json',root));
const relays=['wss://relay.primal.net','wss://relay.damus.io'];
const wire=e=>({id:e.id,pubkey:e.pubkey,created_at:e.created_at,kind:e.kind,tags:e.tags.map(t=>[...t]),content:e.content,sig:e.sig});
const newer=(a,b)=>!b||a.created_at>b.created_at||a.created_at===b.created_at&&a.id<b.id;
const digest=value=>createHash('sha256').update(value).digest('hex');
async function query(filters){
  const records=[];let bytes=0,frames=0;
  await Promise.all(relays.map(url=>new Promise(resolve=>{
    const socket=new WebSocket(url),id=crypto.randomUUID();let done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);try{if(socket.readyState===1)socket.send(JSON.stringify(['CLOSE',id]));socket.close();}catch{}resolve();};
    const timer=setTimeout(finish,6500);
    socket.onopen=()=>socket.send(JSON.stringify(['REQ',id,...filters]));socket.onerror=finish;
    socket.onmessage=({data})=>{if(done||typeof data!=='string')return;bytes+=Buffer.byteLength(data);if(++frames>2000||bytes>8*1024*1024){finish();return;}
      try{const frame=JSON.parse(data);if(frame[1]!==id)return;if(frame[0]==='EOSE'){finish();return;}if(frame[0]!=='EVENT')return;
        const e=wire(frame[2]);if(!filters.some(f=>f.kinds.includes(e.kind)&&(!f.authors||f.authors.includes(e.pubkey))))return;
        if(e.kind===0){verifyProfileRecord(e);if(Buffer.byteLength(JSON.stringify(e))>65536)return;}else if(e.kind===30402){if(!verifyEvent(e))return;}
        records.push(e);
      }catch{/* Unverified or malformed public data is omitted. */}
    };
  })));
  return records;
}
await mkdir(dirname(output),{recursive:true});
let input,provenance;
if(args.includes('--fetch')){
  const graphBytes=new Uint8Array(await readFile(new URL(GRAPH_BOOTSTRAP.packagePath,root)));
  const {graph}=await decodeGraphBootstrap(graphBytes);
  const listings=(await query([{kinds:[30402],limit:64}])).sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id));
  const marketAuthors=[...new Set(listings.map(e=>e.pubkey))].slice(0,128);
  const authors=[...new Set([DEFAULT_SOCIAL_GRAPH_ROOT,...marketAuthors,...[...graph.getFollowedByUser(DEFAULT_SOCIAL_GRAPH_ROOT)].sort()])].slice(0,256);
  const events=[];for(let i=0;i<authors.length;i+=64)events.push(...await query([{kinds:[0],authors:authors.slice(i,i+64),limit:128}]));
  input={version:1,events};provenance={version:1,source:'Public signed Nostr kind-0 metadata',retrievedAt:new Date().toISOString(),relays,selection:{maxAuthors:256,graphSha256:GRAPH_BOOTSTRAP.sha256,listingEventIds:[...new Set(listings.map(e=>e.id))].sort()},generator:'web/scripts/generate-profile-bootstrap.mjs',reproduction:'Pass this frozen snapshot as --input; no network is used. Records are hints, never identity verification.'};
}else if(args.includes('--input'))input=JSON.parse(await readFile(arg('--input'),'utf8'));
else throw Error('Use --input for offline reproduction or --fetch for a reviewed public refresh.');
if(input?.version!==1||!Array.isArray(input.events)||input.events.length>2000)throw Error('Invalid snapshot input');
const winners=new Map();for(const raw of input.events){const e=verifyProfileRecord(wire(raw));if(e.kind!==0||Buffer.byteLength(JSON.stringify(e))>65536)throw Error('Invalid metadata record');if(newer(e,winners.get(e.pubkey)))winners.set(e.pubkey,e);}
if(!winners.size)throw Error('No verified profiles were received');
if(winners.size>256)throw Error('Too many profile authors');
const snapshot=JSON.stringify({version:1,events:[...winners.values()].sort((a,b)=>a.pubkey.localeCompare(b.pubkey))})+'\n';
if(Buffer.byteLength(snapshot)>1024*1024)throw Error('Snapshot exceeds 1 MiB');
await writeFile(output,snapshot);
if(provenance)await writeFile(new URL('src/data/profile-bootstrap.provenance.json',root),JSON.stringify({...provenance,sha256:digest(snapshot),bytes:Buffer.byteLength(snapshot),profiles:winners.size},null,2)+'\n');
console.log(JSON.stringify({profiles:winners.size,bytes:Buffer.byteLength(snapshot),sha256:digest(snapshot)}));
