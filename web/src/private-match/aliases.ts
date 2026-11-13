// Per-match aliases, matching crates/market-core/src/messaging/match_chats.rs.
// An alias secret is derived from the device secret and a random salt when
// needed and never stored. Its invitation and ratchet state live only in the
// encrypted vault. Alias traffic never uses account or device keys.
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex,hexToBytes,randomBytes} from '@noble/hashes/utils.js'
import {getPublicKey,type VerifiedEvent} from 'nostr-tools'
import {Invite,Session,decryptInviteResponse,createSessionFromAccept,serializeSessionState,deserializeSessionState,hasMetadataPrivacyVersion} from 'nostr-double-ratchet'

export const PREFIX='match:', HELLO='Hi! Our helper introduced us privately.'
const INFO=new TextEncoder().encode('iris-market/private-match-alias-v1'), ROOT='https://market.iris.to/invite'
const MAX_TEXT=8*1024, MAX_MESSAGES=10_000
export type AliasMessage={id:string;text:string;mine:boolean;created_at:number;created_at_ms:number;delivery:'pending'|'sent'|'received'}
export type Alias={salt:string;pubkey:string;invite:string;title:string;expires_at:number;peer?:string;early:VerifiedEvent[];session?:string;messages:AliasMessage[]}
export type AliasJob={chat:string;event:VerifiedEvent;inner?:string}
export type AliasChat={id:string;title:string;connected:boolean;messages:AliasMessage[]}

export const aliasSecret=(device:Uint8Array,salt:string)=>hkdf(sha256,device,hexToBytes(salt),INFO,32)

export function createAlias(device:Uint8Array,title:string,expires_at:number,forbidden:string[]):{alias:Alias;url:string}{
  const salt=bytesToHex(randomBytes(32)),secret=aliasSecret(device,salt)
  try{
    const pubkey=getPublicKey(secret)
    if(forbidden.includes(pubkey))throw Error('Could not create a private alias.')
    const invite=Invite.createNew(pubkey,undefined,1)
    return {alias:{salt,pubkey,invite:invite.serialize(),title:[...title].slice(0,200).join(''),expires_at,early:[],messages:[]},url:invite.getUrl(ROOT)}
  }finally{secret.fill(0)}
}

export function aliasOf(url:unknown):string|null{
  if(typeof url!=='string'||url.length>2048)return null
  try{const key=Invite.fromUrl(url).inviter;return /^[0-9a-f]{64}$/.test(key)?key:null}catch{return null}
}

export function aliasUrl(alias:Alias){return Invite.deserialize(alias.invite).getUrl(ROOT)}

const session=(alias:Alias)=>new Session(deserializeSessionState(alias.session!))

export function canSend(alias:Alias){
  if(!alias.session||!alias.peer)return false
  const s=deserializeSessionState(alias.session)
  return !!s.theirNextNostrPublicKey&&!!s.ourCurrentNostrKey
}

export function authors(alias:Alias):string[]{
  if(!alias.session)return []
  const s=deserializeSessionState(alias.session)
  return [...new Set([s.theirCurrentNostrPublicKey,s.theirNextNostrPublicKey,...Object.keys(s.skippedKeys||{})].filter((k):k is string=>!!k))].sort()
}
export const responseKey=(alias:Alias)=>Invite.deserialize(alias.invite).inviterEphemeralPublicKey

export function send(alias:Alias,chat:string,text:string,at=Date.now()):AliasJob{
  if(!canSend(alias))throw Error('Waiting for the other person to say hello.')
  const s=session(alias),created_at=Math.floor(at/1000)
  const {event,innerEvent}=s.sendEvent({kind:14,content:text,pubkey:alias.pubkey,created_at,tags:[['p',alias.peer!],['ms',String(at)]]})
  alias.session=serializeSessionState(s.state)
  alias.messages.push({id:innerEvent.id,text,mine:true,created_at,created_at_ms:at,delivery:'pending'})
  return {chat,event,inner:innerEvent.id}
}

/** The helper named the other alias. The lower key accepts and says hello. */
export async function introduced(device:Uint8Array,alias:Alias,chat:string,peer:string,url:string,at=Date.now()):Promise<AliasJob[]>{
  if(alias.peer||alias.session||peer===alias.pubkey||aliasOf(url)!==peer)return []
  alias.peer=peer
  if(alias.pubkey<peer){
    const secret=aliasSecret(device,alias.salt)
    try{
      const {session,event}=await Invite.fromUrl(url).accept(alias.pubkey,secret)
      alias.session=serializeSessionState(session.state);alias.early=[]
      return [{chat,event},send(alias,chat,HELLO,at)]
    }finally{secret.fill(0)}
  }
  const early=alias.early;alias.early=[]
  for(const event of early)await respond(device,alias,event).catch(()=>{})
  return []
}

export async function respond(device:Uint8Array,alias:Alias,event:VerifiedEvent){
  if(alias.session||!hasMetadataPrivacyVersion(event))return
  if(!alias.peer){if(alias.early.length<4&&!alias.early.some(e=>e.id===event.id))alias.early.push(event);return}
  const invite=Invite.deserialize(alias.invite),secret=aliasSecret(device,alias.salt)
  try{
    const reply=await decryptInviteResponse({envelopeContent:event.content,envelopeSenderPubkey:event.pubkey,
      inviterEphemeralPrivateKey:invite.inviterEphemeralPrivateKey!,inviterPrivateKey:secret,inviterPublicKey:invite.inviter,sharedSecret:invite.sharedSecret})
    if(reply.inviteeIdentity!==alias.peer)throw Error('Unexpected private match reply.')
    const s=createSessionFromAccept({theirPublicKey:reply.inviteeSessionPublicKey,ourSessionPrivateKey:invite.inviterEphemeralPrivateKey!,sharedSecret:invite.sharedSecret,isSender:false})
    alias.session=serializeSessionState(s.state)
  }finally{secret.fill(0)}
}

export function receive(alias:Alias,event:VerifiedEvent,at=Math.floor(Date.now()/1000)):boolean{
  if(!alias.session||!authors(alias).includes(event.pubkey))return false
  const s=session(alias),rumor=s.receiveEvent(event)
  if(!rumor)return false
  alias.session=serializeSessionState(s.state)
  const text=typeof rumor.content==='string'?rumor.content.trim():''
  if(rumor.kind!==14||!text||new TextEncoder().encode(text).length>MAX_TEXT||alias.messages.length>=MAX_MESSAGES||alias.messages.some(m=>m.id===rumor.id))return true
  const created_at=Math.min(rumor.created_at,at+60),ms=Number(rumor.tags.find(t=>t[0]==='ms')?.[1])
  const created_at_ms=Number.isSafeInteger(ms)&&Math.floor(ms/1000)===rumor.created_at?Math.min(ms,(at+60)*1000):created_at*1000
  alias.messages.push({id:rumor.id,text,mine:false,created_at,created_at_ms,delivery:'received'})
  alias.messages.sort((a,b)=>a.created_at_ms-b.created_at_ms)
  return true
}
