import type {Event as NostrEvent} from 'nostr-tools/pure';
import snapshot from './data/profile-bootstrap.json' with {type:'json'};
import provenance from './data/profile-bootstrap.provenance.json' with {type:'json'};
import {cacheProfileMetadata,verifyProfileRecord} from './profiles.ts';
import {DEFAULT_RELAYS} from './market.ts';

export const PROFILE_BOOTSTRAP_LIMITS=Object.freeze({records:256,bytes:1024*1024,eventBytes:65536});
/** Original signed public heads, including signed empty/unsupported revisions. */
export function validateProfileBootstrap(input:unknown,{now=Math.floor(Date.now()/1000)}={}) {
  const value=input as {version?:number;events?:NostrEvent[]};
  if(value?.version!==1||!Array.isArray(value.events)||value.events.length>PROFILE_BOOTSTRAP_LIMITS.records||new TextEncoder().encode(JSON.stringify(input)).length>PROFILE_BOOTSTRAP_LIMITS.bytes)throw Error('Invalid profile snapshot');
  const authors=new Set<string>();
  return value.events.map(raw=>{
    const event=verifyProfileRecord(raw,{now});
    if(event.kind!==0||authors.has(event.pubkey)||new TextEncoder().encode(JSON.stringify(event)).length>PROFILE_BOOTSTRAP_LIMITS.eventBytes)throw Error('Invalid profile snapshot record');
    authors.add(event.pubkey);return event;
  });
}

/** Lazy, local startup hints. Current signed records always win by NIP-01 order. */
export async function seedProfileMetadata({relays=DEFAULT_RELAYS,signal,onProgress=()=>{}}:{relays?:readonly string[];signal?:AbortSignal;onProgress?:()=>void}={}) {
  signal?.throwIfAborted();
  const bytes=new TextEncoder().encode(JSON.stringify(snapshot)+'\n');
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hex=Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
  if(bytes.length!==provenance.bytes||hex!==provenance.sha256)throw Error('Profile snapshot integrity check failed');
  const events=validateProfileBootstrap(snapshot);
  for(let i=0;i<events.length;i++){
    signal?.throwIfAborted();cacheProfileMetadata(events[i],{relays});
    if(i%16===15){onProgress();await new Promise(resolve=>setTimeout(resolve,0));}
  }
  onProgress();return events.length;
}
