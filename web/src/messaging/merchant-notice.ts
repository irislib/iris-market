import {deadline,follow,validRetention,type Retention} from './retention.ts';
import {generateSecretKey, type Event, type VerifiedEvent} from 'nostr-tools';
import {wrapEvent} from 'nostr-tools/nip17';
import {AppKeys, Invite, INVITE_LIST_LABEL} from 'nostr-double-ratchet';
import {selectSignerRoster} from './authorization.ts';
import {privateRelayUrls, type PrivateTransport} from './transport.ts';
import {createVault, indexedDbVaultBackend, type Vault, type VaultBackend} from './vault.ts';

export const noticeMessage = 'Someone wants to buy from you on market.iris.to. Open Iris Market to set up private messaging.';
type Status = 'locked'|'available'|'unavailable'|'no-inbox'|'queued'|'sent';
interface Notice {history?:boolean;until:number; status:Status; event?:Event}
const now = () => Math.floor(Date.now()/1000);

export function noticeEnvelope(merchant:string):Event {
  const sender = generateSecretKey();
  try { return wrapEvent(sender, {publicKey:merchant}, noticeMessage); }
  finally { sender.fill(0); }
}

function newer(a:Event, b?:Event) {
  return !b || a.created_at > b.created_at || a.created_at === b.created_at && a.id < b.id;
}
function expired(e:Event) {
  return e.tags.some(t => t[0] === 'expiration' && Number(t[1]) <= now());
}

// The private transport verifies wire signatures. Resolve replaceable records
// before inspecting their contents, including withdrawn contact invitations.
export function noticeDestinations(merchant:string, events:VerifiedEvent[], discovery:string[]):string[]|null {
  const records = events.filter(e => e.pubkey === merchant);
  if (records.some(e => e.created_at > now()+300)) throw Error('Could not verify seller settings.');
  const roster = selectSignerRoster(records, merchant);
  if (roster && AppKeys.fromEvent(roster).getAllDevices().length) return null;
  const invites = new Map<string,VerifiedEvent>();
  let inbox:VerifiedEvent;
  for (const event of records) {
    const d = event.tags.find(t => t[0] === 'd')?.[1];
    if (event.kind === 30078 && d?.startsWith(INVITE_LIST_LABEL+'/') && newer(event, invites.get(d))) invites.set(d,event);
    if (event.kind === 10050 && newer(event,inbox)) inbox = event;
  }
  for (const event of invites.values()) {
    if (expired(event) || !event.tags.some(t => t[0] === 'l' && t[1] === INVITE_LIST_LABEL)) continue;
    try { Invite.fromEvent(event); return null; } catch { /* Tombstones have no invitation. */ }
  }
  if (!inbox || expired(inbox)) return [];
  const urls = new Set<string>();
  for (const [name,raw] of inbox.tags) {
    if (name !== 'relay' || !raw) continue;
    try {
      const [url] = privateRelayUrls([raw]);
      if (new URL(url).search || url.startsWith('ws:') && !discovery.some(r => new URL(r).href === url)) continue;
      urls.add(url);
      if (urls.size === 8) break;
    } catch { /* Ignore invalid inbox addresses. */ }
  }
  return [...urls];
}

export function merchantNotices({transport,getRelays,hasChat=()=>false,backend=indexedDbVaultBackend(globalThis.indexedDB,'iris-market-seller-notices'),accountVault,onAccepted,onChange=()=>{}}:
    {transport:PrivateTransport;getRelays:()=>string[];hasChat?:(key:string)=>boolean;backend?:VaultBackend;accountVault?:()=>Vault;onAccepted?:(peer:string,createdAt:number)=>Promise<void>;onChange?:(key:string,status:Status)=>void}) {
  // Shares no account keys, NDR queues or public replay store. Reopen each
  // transaction so concurrent tabs see the journal's current version.
  const prefix=accountVault ? "market/notice-queue/" : "";
  async function journal(create=false) {
    if(accountVault)return accountVault();
    const vault = createVault({backend});
    if (!await vault.unlock()) {
      if (!create) return null;
      await vault.create();
    }
    return vault;
  }
  async function routes(key:string) {
    if (hasChat(key)) return null;
    const relays = getRelays();
    const filters = [{kinds:[37368,30078,10050],authors:[key],limit:1024}];
    const read = async (urls:string[]) => {
      const result = await transport.query(filters,{relays:urls,waitForAll:true});
      if (result.events.length >= 1024) throw Error('Could not check seller messaging.');
      return result;
    };
    const result = await read(relays);
    const inbox = noticeDestinations(key,result.events,relays);
    if (hasChat(key) || inbox === null) return null;
    if (result.complete) return inbox;
    // An unreachable discovery relay is not evidence of missing chat. Confirm
    // the result at the seller's signed inbox before offering the fallback.
    if (!inbox.length || !result.sources?.some(s=>s.complete)) throw Error('Could not check seller messaging.');
    const confirmed = await read(inbox);
    if (!confirmed.complete) throw Error('Could not check seller messaging.');
    return hasChat(key) ? null : noticeDestinations(key,[...result.events,...confirmed.events],relays);
  }
  async function status(key:string):Promise<Status> {
    const row = await (await journal())?.get<Notice>(prefix+key);
    if (row?.until > now()) return row.status;
    const inbox = await routes(key);
    return inbox === null ? 'unavailable' : inbox.length ? 'available' : 'no-inbox';
  }
  let syncing:Promise<void>;
  async function deliver() {
    const vault = await journal();
    if (!vault) return;
    for (const path of await vault.list(prefix)) {
      const key=path.slice(prefix.length);
      if (!/^[0-9a-f]{64}$/.test(key)) continue;
      const row = await vault.get<Notice>(prefix+key);
      if (row.until <= now()) { await vault.del(path); continue; }
      if (!row.event) continue;
      try {
        const relays = await routes(key);
        const state = relays === null ? 'unavailable' : relays.length ? 'sent' : 'no-inbox';
        if (relays?.length && !(await transport.publish(row.event,{relays})).remoteAccepted) continue;
        accountVault?.(); // An account switch or lock invalidates this operation.
        const done={until:row.until,status:state};
        if (state==='sent' && row.history) {
          const created=row.until-86400;
          if(onAccepted) {
            await onAccepted(key,created);
            accountVault?.();
            await vault.put(path,done);
          } else {
            const historyKey='history/'+key;
            const dates=await vault.get<number[]>(historyKey)??[];
            await vault.putMany([[historyKey,[...new Set([...dates,created])]], [path,done]]);
          }
        } else await vault.put(path,done);
        onChange(key,state);
      } catch { /* Keep the same ciphertext for retry after an inconclusive lookup or send. */ }
    }
  }
  function flush() {
    return syncing ??= deliver().finally(() => {syncing=undefined;});
  }
  async function queue(key:string):Promise<Status> {
    const vault = await journal(true);
    const existing = await vault.get<Notice>(prefix+key);
    if (existing?.until > now()) return existing.status;
    if ((await vault.list(prefix)).filter(p=>/^[0-9a-f]{64}$/.test(p.slice(prefix.length))).length >= 128) throw Error('Too many recent seller notifications.');
    await vault.put(prefix+key,{history:true,until:now()+86400,status:'queued',event:noticeEnvelope(key)});
    onChange(key,'queued');
    void flush().catch(()=>{});
    return 'queued';
  }
  async function guestRetention():Promise<Retention> {return (await (await journal())?.get<Retention>('retention'))??follow;}
  async function guestHistory(policy?:Retention) {
    const vault=await journal(!!policy);
    if(!vault || accountVault)return [];
    const prior=await vault.get<Retention>('retention')??follow;
    const chats=[],changes:Array<[string,unknown]>=[];
    if(policy){if(!validRetention(policy))throw Error('Choose a positive duration.');changes.push(['retention',policy]);}
    for(const path of await vault.list('history/')){
      const dates=await vault.get<number[]>(path)??[];
      const live=dates.filter(createdAt=>[prior,policy??prior].every(p=>(deadline(p,{createdAt})??Infinity)>now()));
      if(live.length!==dates.length)changes.push([path,live]);
      if(live.length)chats.push({pubkey:path.slice(8),messages:live.map(noticeMessageRow)});
    }
    if(changes.length)await vault.putMany(changes);
    return chats;
  }
  return {status,queue,flush,guestHistory,guestRetention};
}

export function noticeMessageRow(createdAt:number) {
  return {id:'notice-'+createdAt,text:noticeMessage,createdAt,mine:true,delivery:'sent' as const,system:true};
}
