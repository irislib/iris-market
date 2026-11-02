import {getEventHash} from 'nostr-tools/pure'
import type {Vault} from './messaging/vault.ts'
import type {Rumor} from 'nostr-double-ratchet'

const WEEK=7*86400, CAP=128, KEY='market/private-matches-v1'
const tag='iris-market/private-match'
const key=(v:unknown):v is string=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v)
const uuid=(v:unknown):v is string=>typeof v==='string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const summary=(v:unknown):v is string=>typeof v==='string' && !!v.trim() && [...v].length<=200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(v)
const address=(v:unknown):v is string=>typeof v==='string' && /^(30402|38383):[a-f0-9]{64}:[^\u0000-\u001f\u007f-\u009f]{1,250}$/u.test(v)
const current=(v:number,at:number)=>Number.isSafeInteger(v)&&v>at&&v<=at+WEEK
const requireMatch=(v:unknown,message:string)=>{if(!v)throw new Error(message)}
type Side='offer'|'request'
export type Entry={id:string;side:Side;summary:string;expires_at:number}
export type Row=Entry&{peer:string}
type Pair={entries:[string,string];votes:[boolean|null,boolean|null];expires_at:number;introduced:boolean}
type Interest={helper:string;entry:string;summary:string;expires_at:number;vote:boolean|null;contact:string|null}
type Lead={helper:string;entry:string;listing:string;title:string;expires_at:number}
export type MatchView={sent:Record<string,Row>;received:Record<string,Row>;pairs:Record<string,Pair>;interests:Record<string,Interest>;public_leads:Record<string,Lead>}
export type MatchAction=
  |{op:'enable';enabled:boolean}|{op:'share';helper:string;side:Side;summary:string}
  |{op:'withdraw';entry:string}|{op:'suggest';left:string;right:string}
  |{op:'vote';proposal:string;accept:boolean}|{op:'introduce';proposal:string}|{op:'send_public';entry:string;listing:string}
type Wire=
  |{op:'share';entry:Entry}|{op:'withdraw';entry:string;expires_at:number}
  |{op:'suggest';proposal:string;entry:string;summary:string;expires_at:number}
  |{op:'vote';proposal:string;accept:boolean;expires_at:number}
  |{op:'introduce';proposal:string;contact:string;expires_at:number}
  |{op:'public_listing';entry:string;listing:string;title:string;expires_at:number}
type Listing={id:string;author:string;side:string;title:string;category?:string;tags?:readonly string[];expiresAt?:number}
type Job={peer:string;rumor:Rumor;expires_at:number}
type Book=MatchView&{enabled:boolean;ignoreSharesThrough?:number;withdrawn:Record<string,number>;jobs:Job[]}
const empty=():Book=>({enabled:false,sent:{},received:{},pairs:{},interests:{},public_leads:{},withdrawn:{},jobs:[]})
function prune(b:Book,at:number){
  for(const items of [b.sent,b.received])for(const r of Object.values(items))if(r.expires_at<=at)delete items[r.id]
  for(const [id,p] of Object.entries(b.pairs))if(p.expires_at<=at||p.entries.some(e=>!b.received[e]))delete b.pairs[id]
  for(const items of [b.interests,b.public_leads])for(const [id,p] of Object.entries(items))if(p.expires_at<=at||!b.sent[p.entry])delete items[id]
  for(const [id,until] of Object.entries(b.withdrawn))if(until<=at)delete b.withdrawn[id]
  b.jobs=b.jobs.filter(j=>j.expires_at>at)
}
export const isPrivateMatch=(event:Rumor)=>event.kind===14 && event.tags.some(t=>t[0]===tag)
function incoming(b:Book,me:string,peer:string,w:Wire,at:number,created:number){
  if(!b.enabled||me===peer)return
  if(w.op==='share'){
    const e=w.entry
    if(created<=(b.ignoreSharesThrough??-1)||!e||!uuid(e.id)||!['offer','request'].includes(e.side)||!summary(e.summary)||!current(e.expires_at,at))return
    const rows=Object.values(b.received)
    if(rows.length<CAP&&rows.filter(r=>r.peer===peer).length<16&&!b.withdrawn[peer+'/'+e.id]&&!b.received[e.id])
      b.received[e.id]={id:e.id,side:e.side,summary:e.summary,expires_at:e.expires_at,peer}
    return
  }
  if(!current(w.expires_at,at))return
  switch(w.op){
    case 'withdraw':
      if(!uuid(w.entry))return
      if(b.received[w.entry]?.peer===peer)delete b.received[w.entry]
      const id=peer+'/'+w.entry
      if(b.withdrawn[id]||Object.keys(b.withdrawn).length<4*CAP)b.withdrawn[id]=Math.max(b.withdrawn[id]||0,w.expires_at)
      else b.ignoreSharesThrough=Math.max(b.ignoreSharesThrough??-1,created)
      break
    case 'suggest':{
      if(!uuid(w.entry)||!uuid(w.proposal)||!summary(w.summary))return
      const row=b.sent[w.entry]
      if(row?.peer===peer&&row.expires_at>=w.expires_at&&Object.keys(b.interests).length<CAP)
        b.interests[w.proposal]??={helper:peer,entry:w.entry,summary:w.summary,expires_at:w.expires_at,vote:null,contact:null}
      break
    }
    case 'vote':{
      if(!uuid(w.proposal)||typeof w.accept!=='boolean')return
      const p=b.pairs[w.proposal]
      if(p?.expires_at===w.expires_at)p.entries.forEach((id,i)=>{if(b.received[id]?.peer===peer)p.votes[i]??=w.accept})
      break
    }
    case 'introduce':{
      if(!uuid(w.proposal)||!key(w.contact)||[me,peer].includes(w.contact))return
      const p=b.interests[w.proposal]
      if(p?.helper===peer&&p.vote===true&&p.expires_at===w.expires_at)p.contact??=w.contact
      break
    }
    case 'public_listing':{
      if(!uuid(w.entry)||!address(w.listing)||!summary(w.title))return
      const r=b.sent[w.entry]
      if(r?.peer===peer&&r.expires_at===w.expires_at&&Object.keys(b.public_leads).length<CAP)
        b.public_leads[w.entry+'/'+w.listing]={helper:peer,entry:w.entry,listing:w.listing,title:w.title,expires_at:w.expires_at}
      break
    }
  }
}
type Send=(peer:string,w:Wire,until:number)=>void
function act(b:Book,me:string,a:MatchAction,at:number,send:Send,publicItem?:Listing){
  if(a.op==='withdraw'||(a.op==='enable'&&!a.enabled)){
    b.jobs=b.jobs.filter(job=>{
      const wire=JSON.parse(job.rumor.tags.find(t=>t[0]===tag)![2]) as Wire
      return a.op==='withdraw' ? wire.op!=='share'||wire.entry.id!==a.entry : wire.op==='withdraw'
    })
  }
  if(a.op==='enable'){
    if(!a.enabled){
      b.ignoreSharesThrough=at
      for(const r of Object.values(b.sent))send(r.peer,{op:'withdraw',entry:r.id,expires_at:r.expires_at},r.expires_at)
      Object.assign(b,{sent:{},received:{},pairs:{},interests:{},public_leads:{}})
    }
    b.enabled=a.enabled;return
  }
  requireMatch(b.enabled,'Enable private matching in Settings first.')
  switch(a.op){
    case 'share':{
      requireMatch(key(a.helper)&&a.helper!==me&&summary(a.summary)&&['offer','request'].includes(a.side)&&Object.keys(b.sent).length<CAP,'Choose another helper and a short summary.')
      const entry={id:crypto.randomUUID(),side:a.side,summary:a.summary.trim(),expires_at:at+WEEK}
      b.sent[entry.id]={...entry,peer:a.helper};send(a.helper,{op:'share',entry},entry.expires_at);break
    }
    case 'withdraw':{
      const r=b.sent[a.entry];requireMatch(r,'This entry is no longer pending.')
      send(r.peer,{op:'withdraw',entry:r.id,expires_at:r.expires_at},r.expires_at);delete b.sent[r.id];break
    }
    case 'suggest':{
      const left=b.received[a.left],right=b.received[a.right],pairs=Object.values(b.pairs)
      requireMatch(left&&right&&left.peer!==right.peer&&left.side!==right.side&&pairs.length<CAP&&!pairs.some(p=>p.entries.includes(left.id)&&p.entries.includes(right.id)),'Choose two different people with opposite interests.')
      const id=crypto.randomUUID(),end=Math.min(left.expires_at,right.expires_at)
      for(const [r,other] of [[left,right],[right,left]])send(r.peer,{op:'suggest',proposal:id,entry:r.id,summary:other.summary,expires_at:end},end)
      b.pairs[id]={entries:[left.id,right.id],votes:[null,null],expires_at:end,introduced:false};break
    }
    case 'vote':{
      const p=b.interests[a.proposal];requireMatch(p&&p.vote===null,'Suggestion expired or already answered.')
      p.vote=a.accept;send(p.helper,{...a,expires_at:p.expires_at},p.expires_at);break
    }
    case 'introduce':{
      const p=b.pairs[a.proposal];requireMatch(p&&p.votes.every(v=>v===true)&&!p.introduced,'Both people must agree to this introduction.')
      const [one,two]=p.entries.map(id=>b.received[id].peer)
      for(const [peer,contact] of [[one,two],[two,one]])send(peer,{...a,contact,expires_at:p.expires_at},p.expires_at)
      p.introduced=true;break
    }
    case 'send_public':{
      const r=b.received[a.entry],l=publicItem
      requireMatch(r&&l&&l.id===a.listing&&l.author!==r.peer&&l.side!==r.side&&(!l.expiresAt||l.expiresAt>at),'Choose an active public listing on the opposite side.')
      const listing=address(l.id)?l.id:'30402:'+l.id
      requireMatch(address(listing),'Invalid listing address.')
      send(r.peer,{op:'public_listing',entry:r.id,listing,title:[...l.title].slice(0,200).join(''),expires_at:r.expires_at},r.expires_at);break
    }
  }
}
const stop=new Set('the for and are can with need looking want offer request sell buy sale have any some to of is an'.split(' '))
const terms=(s:string)=>new Set((s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>w.length>1&&!stop.has(w)).slice(0,40))
export function matchCandidates(view:MatchView,id:string,items:Listing[],at=Math.floor(Date.now()/1000)){
  const r=view.received[id];if(!r||r.expires_at<=at)return []
  const query=terms(r.summary)
  const rows:{kind:string;id:string;summary:string;score:number}[]=[]
  const add=(kind:string,id:string,summary:string,full:string)=>{const score=[...terms(full)].filter(w=>query.has(w)).length;if(score)rows.push({kind,id,summary,score})}
  for(const item of Object.values(view.received))if(item.side!==r.side&&item.peer!==r.peer&&item.expires_at>at)add('private',item.id,item.summary,item.summary)
  for(const l of items)if(l.side!==r.side&&l.author!==r.peer&&(!l.expiresAt||l.expiresAt>at))add('public',l.id,l.title,[l.title,l.category,...(l.tags||[])].join(' '))
  return rows.sort((a,b)=>b.score-a.score||(a.kind<b.kind?-1:a.kind>b.kind?1:a.id<b.id?-1:a.id>b.id?1:0)).slice(0,40)
}
export function createMatchBook(vault:Vault,owner:string,device:string,notify:()=>void,check:()=>void,now=()=>Math.floor(Date.now()/1000)){
  const storageKey=KEY+'/'+owner
  let book=empty(),tail=Promise.resolve()
  const serial=<T>(f:()=>Promise<T>)=>{const next=tail.then(f);tail=next.then(()=>{},()=>{});return next}
  async function write(fn:(next:Book)=>void){
    return serial(async()=>{check();const next=structuredClone(book);prune(next,now());fn(next);prune(next,now());await vault.put(storageKey,next);check();book=next;notify()})
  }
  return {
    async load(){const stored=await vault.get<Book>(storageKey);check();book=stored||empty();const before=JSON.stringify(book);prune(book,now());if(stored&&before!==JSON.stringify(book))await vault.put(storageKey,book);check()},
    view():MatchView|null{if(!book.enabled)return null;const b=structuredClone(book);prune(b,now());const {sent,received,pairs,interests,public_leads}=b;return {sent,received,pairs,interests,public_leads}},
    action:(action:MatchAction,listing?:Listing)=>write(b=>act(b,owner,action,now(),(peer,wire,expires_at)=>{
      requireMatch(b.jobs.length<256,'Private delivery queue is full.')
      const event={kind:14,pubkey:device,created_at:now(),content:'Private matching',tags:[['p',peer],['ms',String(Date.now())],[tag,'1',JSON.stringify(wire)]]}
      b.jobs.push({peer,expires_at,rumor:{...event,id:getEventHash(event)}})
    },listing)),
    async receive(event:Rumor,peer:string,senderDevice?:string){
      if(!book.enabled||!isPrivateMatch(event)||!key(peer)||peer===owner||![peer,senderDevice].includes(event.pubkey)||getEventHash(event)!==event.id)return
      const ps=event.tags.filter(t=>t[0]==='p'),c=event.tags.filter(t=>t[0]===tag)
      if(ps.length!==1||ps[0][1]!==owner||c.length!==1||c[0].length!==3||c[0][1]!=='1'||c[0][2].length>4096||event.created_at>now()+60||event.created_at+WEEK<=now())return
      let w:Wire;try{w=JSON.parse(c[0][2])}catch{return}if(!w||typeof w!=='object')return
      await write(b=>incoming(b,owner,peer,w,now(),event.created_at))
    },
    jobs:()=>book.jobs.filter(j=>j.expires_at>now()),
    handed:(id:string)=>write(b=>{b.jobs=b.jobs.filter(j=>j.rumor.id!==id)}),
    flush:()=>tail,
  }
}
