import {buildReactionRumor,buildReceiptRumor,parseReaction,parseReceipt} from 'nostr-double-ratchet';
import type {Rumor} from 'nostr-double-ratchet';
import type {Vault} from './vault.ts';
export interface ReceiptPreferences {delivered:boolean;seen:boolean}
export interface ReactionSummary {emoji:string;count:number;reacted_by_me:boolean}
export interface ChatControlMeta {heads?:Record<string,{emoji:string;ms:number;id:string}>;sentReceipt?:'delivered'|'seen'}
export interface ControlMessage {id:string;mine:boolean;delivery:string;_chat?:ChatControlMeta}
export interface ChatControl {peer:string;author:string;id:string;ms:number;target:string;kind:7|15;value:string}
type ControlData={v:1;preferences:ReceiptPreferences;pending:ChatControl[];jobs:{peer:string;rumor:Rumor}[];lastMs:number;floor:Record<string,number>};
const HEX=/^[a-f0-9]{64}$/,KEY='market/chat-controls/v1',LIMIT=4096;
const receiptRank=(value:string)=>value==='seen'?2:value==='delivered'?1:0;
export const deliveryRank=(value:string)=>({queued:0,sent:1,delivered:2,seen:3,received:1}[value]??0);
export const validReaction=(value:unknown):value is string=>{
  if(typeof value!=='string'||[...value].length>32)return false;
  return value===''||/^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\u{e0020}-\u{e007f}]*$/u.test(value)||/^\p{Regional_Indicator}{2}$/u.test(value)||/^[#*0-9]\ufe0f?\u20e3$/u.test(value);
};
const newer=(a:{ms:number;id:string},b:{ms:number;id:string})=>a.ms>b.ms||a.ms===b.ms&&a.id>b.id;
/** Authenticate with NDR owner metadata, never the inner pubkey or JSON claims. */
export function parseChatControls(rumor:Rumor,sender:string,owner:string,peer:string,at=Date.now()):ChatControl[] {
  if(!HEX.test(sender)||!HEX.test(owner)||!HEX.test(peer)||![owner,peer].includes(sender)||!HEX.test(rumor?.id||'')||!Array.isArray(rumor.tags)||rumor.tags.length>268)return[];
  const msTags=rumor.tags.filter(tag=>tag[0]==='ms'),recipientTags=rumor.tags.filter(tag=>tag[0]==='p');
  if(recipientTags.length>1||recipientTags.length===1&&recipientTags[0][1]!==(sender===owner?peer:owner)||msTags.length>1||msTags.length===1&&!/^\d{1,16}$/.test(msTags[0][1]))return[];
  const ms=msTags.length?Number(msTags[0][1]):rumor.created_at*1000;if(!Number.isSafeInteger(ms)||ms<0||ms>at+300000)return[];
  const targets=rumor.tags.filter(tag=>tag[0]==='e');if(!targets.length||targets.length>256||targets.some(tag=>tag.length<2||!HEX.test(tag[1])))return[];
  let normalized=rumor;
  if(typeof rumor.content==='string'&&rumor.content.startsWith('{')){try{const value=JSON.parse(rumor.content);if(rumor.kind===7&&value?.type==='reaction'){if(value.messageId!==targets[0][1]||typeof value.emoji!=='string')return[];normalized={...rumor,content:value.emoji};}else if(rumor.kind===15&&['delivered','seen'].includes(value?.type)){if(!Array.isArray(value.messageIds)||value.messageIds.length!==targets.length||value.messageIds.some((id,index)=>id!==targets[index][1]))return[];normalized={...rumor,content:value.type};}}catch{return[];}}
  const reaction=parseReaction(normalized),receipt=parseReceipt(normalized);
  if(reaction&&(targets.length!==1||!validReaction(reaction.emoji)))return[];
  if(!reaction&&!receipt)return[];
  return [...new Set(targets.map(tag=>tag[1]))].map(target=>({peer,author:sender,id:rumor.id,ms,target,kind:reaction?7:15,value:reaction?reaction.emoji:receipt.type}));
}
export function applyChatControl<T extends ControlMessage>(message:T,control:ChatControl,owner:string,peer:string):T {
  const next=structuredClone(message);if(message.id!==control.target||control.peer!==peer||![owner,peer].includes(control.author))return next;
  if(control.kind===15){
    if(control.author===peer&&message.mine&&deliveryRank(control.value)>deliveryRank(message.delivery))next.delivery=control.value;
    else if(control.author===owner&&!message.mine&&receiptRank(control.value)>receiptRank(message._chat?.sentReceipt||''))next._chat={...next._chat,sentReceipt:control.value as 'delivered'|'seen'};
  }else{
    const heads={...next._chat?.heads},previous=heads[control.author];
    if(!previous||newer(control,previous))heads[control.author]={emoji:control.value,ms:control.ms,id:control.id};
    next._chat={...next._chat,heads};
  }
  return next;
}
export function messageReactions(message:ControlMessage,owner:string):ReactionSummary[] {
  const summaries=new Map<string,ReactionSummary>();for(const [author,head] of Object.entries(message._chat?.heads||{})){if(!head.emoji)continue;const value=summaries.get(head.emoji)||{emoji:head.emoji,count:0,reacted_by_me:false};value.count++;value.reacted_by_me ||= author===owner;summaries.set(head.emoji,value);}return [...summaries.values()].sort((a,b)=>a.emoji.localeCompare(b.emoji));
}
/** Only unmatched controls live here; known target heads stay on their encrypted message row. */
export function createChatControls({vault,owner,device,check=()=>{}}:{vault:Vault;owner:string;device:string;check?:()=>void}) {
  let data:ControlData={v:1,preferences:{delivered:true,seen:true},pending:[],jobs:[],lastMs:0,floor:{}},writes=Promise.resolve();
  const serial=<T>(task:()=>Promise<T>)=>{const result=writes.then(()=>{check();return task();});writes=result.then(()=>{},()=>{});return result;};
  const persist=async(next:ControlData)=>{check();await vault.put(KEY,next);check();data=next;};
  const insert=(next:ControlData,controls:ChatControl[])=>{
    for(const control of controls){if(control.ms<(next.floor[control.peer+control.author]||0))continue;const index=next.pending.findIndex(c=>c.peer===control.peer&&c.author===control.author&&c.target===control.target&&c.kind===control.kind),previous=next.pending[index];if(previous&&(control.kind===15?receiptRank(control.value)<=receiptRank(previous.value):!newer(control,previous)))continue;if(index<0)next.pending.push(control);else next.pending[index]=control;}
    next.pending.sort((a,b)=>a.ms-b.ms||a.id.localeCompare(b.id));if(next.pending.length>LIMIT){const removed=next.pending.splice(0,next.pending.length-LIMIT);for(const control of removed){const scope=control.peer+control.author;next.floor[scope]=Math.max(next.floor[scope]||0,control.ms+1);}next.pending=next.pending.filter(c=>c.ms>=(next.floor[c.peer+c.author]||0));const scopes=Object.keys(next.floor).sort((a,b)=>next.floor[a]-next.floor[b]);for(const scope of scopes.slice(0,Math.max(0,scopes.length-256)))delete next.floor[scope];}
  };
  const stage=async(peer:string,rumor:Rumor)=>{const next=structuredClone(data);insert(next,parseChatControls(rumor,owner,owner,peer));if(rumor.kind===7)next.jobs=next.jobs.filter(job=>!(job.peer===peer&&job.rumor.kind===7&&job.rumor.tags.find(t=>t[0]==='e')?.[1]===rumor.tags.find(t=>t[0]==='e')?.[1]));while(next.jobs.length>=512){const optional=next.jobs.findIndex(job=>job.rumor.kind===15);if(optional<0)throw Error('Some reactions are waiting to sync. Try again after reconnecting.');next.jobs.splice(optional,1);}next.jobs.push({peer,rumor});await persist(next);return rumor;};
  return {
    async load(){const stored=await vault.get<ControlData>(KEY);check();if(stored?.v===1&&Array.isArray(stored.pending)&&Array.isArray(stored.jobs)&&stored.pending.length<=LIMIT&&stored.jobs.length<=512){data={...stored,preferences:{delivered:stored.preferences?.delivered!==false,seen:stored.preferences?.seen!==false},floor:stored.floor&&typeof stored.floor==='object'?stored.floor:{}};}},
    preferences:()=>({...data.preferences}),
    setPreferences(patch:Partial<ReceiptPreferences>){return serial(async()=>{const next=structuredClone(data);for(const key of ['delivered','seen'] as const)if(typeof patch[key]==='boolean')next.preferences[key]=patch[key];next.jobs=next.jobs.filter(job=>job.rumor.kind!==15||next.preferences[job.rumor.content as 'delivered'|'seen']);await persist(next);});},
    pendingFor:(peer:string,target:string)=>structuredClone(data.pending.filter(c=>c.peer===peer&&c.target===target)),
    receive(rumor:Rumor,sender:string,peer:string){return serial(async()=>{const controls=parseChatControls(rumor,sender,owner,peer);if(!controls.length)return[];const next=structuredClone(data);insert(next,controls);await persist(next);return controls;});},
    settled(controls:ChatControl[]){return serial(async()=>{if(!controls.length)return;const next=structuredClone(data);next.pending=next.pending.filter(c=>!controls.some(done=>done.id===c.id&&done.target===c.target&&done.peer===c.peer&&done.author===c.author));if(next.pending.length!==data.pending.length)await persist(next);});},
    reaction(peer:string,message:ControlMessage,emoji:string){return serial(async()=>{if(!validReaction(emoji)||!emoji||!HEX.test(peer))throw Error('Choose an emoji reaction.');const current=message._chat?.heads?.[owner],ms=Math.max(Date.now(),data.lastMs+1,(current?.ms||0)+1),next=structuredClone(data);next.lastMs=ms;await persist(next);return stage(peer,buildReactionRumor(message.id,current?.emoji===emoji?'':emoji,{pubkey:device,nowMs:ms,tags:[['p',peer]]}));});},
    receipt(peer:string,ids:string[],type:'delivered'|'seen'){return serial(async()=>{
      if(!data.preferences[type]||!ids.length)return;
      const next=structuredClone(data),combined=new Map<string,'delivered'|'seen'>(),requested=new Set(ids);
      for(const job of next.jobs.filter(job=>job.peer===peer&&job.rumor.kind===15)){const receipt=parseReceipt(job.rumor);if(receipt)for(const target of receipt.messageIds)if(receiptRank(receipt.type)>receiptRank(combined.get(target)||''))combined.set(target,receipt.type);}
      for(const target of ids)if(receiptRank(type)>receiptRank(combined.get(target)||''))combined.set(target,type);
      next.jobs=next.jobs.filter(job=>job.peer!==peer||job.rumor.kind!==15);
      const available=512-next.jobs.length;if(!available)return;
      let ms=Math.max(Date.now(),data.lastMs+1),count=0;const staged:ChatControl[]=[];
      for(const receiptType of ['seen','delivered'] as const){if(!next.preferences[receiptType])continue;const targets=[...combined].filter(([,value])=>value===receiptType).map(([target])=>target);for(let index=0;index<targets.length&&count<available;index+=128){const rumor=buildReceiptRumor(receiptType,targets.slice(index,index+128),{pubkey:device,nowMs:ms++,tags:[['p',peer]]});next.jobs.push({peer,rumor});count++;staged.push(...parseChatControls(rumor,owner,owner,peer).filter(control=>requested.has(control.target)));}}
      insert(next,staged);next.lastMs=ms;await persist(next);
    });},
    jobs:()=>structuredClone(data.jobs),
    handed(id:string){return serial(async()=>{const next=structuredClone(data);next.jobs=next.jobs.filter(job=>job.rumor.id!==id);await persist(next);});},
    flush:()=>writes,
  };
}
