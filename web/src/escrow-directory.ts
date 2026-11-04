import {applyEvent,isNewer,LISTING_KIND,type MarketListing} from './market.ts';
import {getPublicRuntime} from './nostr-runtime.ts';
import {loadProfileMetadata} from './profiles.ts';

const serviceTag='escrow-provider';

export function advertisedProviders(inventory:readonly MarketListing[],directory:Map<string,MarketListing>,now=Math.floor(Date.now()/1000)){
  const records=new Map(inventory.map(listing=>[listing.id,listing]));
  for(const listing of directory.values())if(isNewer(listing,records.get(listing.id)))records.set(listing.id,listing);
  return new Set([...records.values()].filter(l=>l.status==='active' && l.side==='offer' && l.tags?.includes(serviceTag) &&
    (!l.expiration||l.expiration>now)).map(l=>l.author));
}

export async function findEscrowServices(directory:Map<string,MarketListing>,relays:readonly string[],runtime=getPublicRuntime(relays)){
  // This fixed public query does not identify the traders or include what they typed.
  const {events}=await runtime.query([{kinds:[LISTING_KIND],'#t':[serviceTag],limit:48}],{limit:48,deadline:Date.now()+5000,cache:'network-only'});
  for(const e of events.slice(0,48)){
    if(e.kind!==LISTING_KIND || !e.tags.some(t=>t[0]==='t'&&t[1]===serviceTag))continue;
    try{applyEvent(directory,e,{maxRecords:256});}catch{/* Ignore invalid listings. */}
  }
  const authors=[...advertisedProviders([],directory)].slice(0,48);
  // Keep verified services searchable by address even when profile names are unavailable.
  if(authors.length)await loadProfileMetadata(authors,{relays,runtime,timeoutMs:3000}).catch(()=>[]);
}
