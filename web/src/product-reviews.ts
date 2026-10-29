// Read-only NIP-99 extensions. Product scores must never enter profile star averages.
// https://github.com/GammaMarkets/market-spec/blob/5dc79c5db0d41c0bea774debf445cce041192840/spec.md#5-product-reviews-kind-31555
// https://github.com/shopstr-eng/shopstr/blob/2e11d0b6d7b8d5d3007c5393882a77dc2f0721e2/packages/shopstr-mcp/src/tools/utils/review-helpers.ts
// Preserve each dimension's native 0..1 scale: clients disagree about overall weighting.
import {verifyEvent} from 'nostr-tools/pure';
import type {Event, Filter, VerifiedEvent} from 'nostr-tools';
import type {ReviewQuery} from './reviews.ts';

export const PRODUCT_REVIEW_KIND=31555;
export const PRODUCT_REVIEW_LIMITS=Object.freeze({reviews:128,events:512,eventBytes:8192,queryBytes:1024*1024,timeoutMs:6000,body:3000});
export interface ProductReview {
  scope:'product';format:'market-spec'|'shopstr-legacy'|'shopstr-address';
  id:string;subject:string;author:string;targetAddress:string;rating:number;ratingMax:1;
  ratings:Readonly<Record<string,number>>;body:string;updatedAt:number;event:VerifiedEvent;
}
const key=/^[a-f0-9]{64}$/,encoder=new TextEncoder(),seconds=()=>Math.floor(Date.now()/1000);
const newer=(a:Event,b:Event)=>a.created_at>b.created_at||a.created_at===b.created_at&&a.id<b.id;
const requireValue=(condition:unknown,message:string):void=>{if(!condition)throw new Error(message);};

/** Exact NIP-99 address, including the complete opaque identifier (which may contain colons). */
export function productReviewTarget(address:string):string {
  requireValue(typeof address==='string'&&/^30402:[a-f0-9]{64}:[^\u0000-\u001f\u007f]{1,512}$/u.test(address),'Invalid product address.');
  return address;
}
function address(value:string|undefined):string|undefined {
  try{return productReviewTarget(value?.startsWith('a:')?value.slice(2):value);}catch{return undefined;}
}
function checkedEvent(input:Event,now:number):VerifiedEvent {
  requireValue(input&&(input.kind===PRODUCT_REVIEW_KIND||input.kind===5)&&key.test(input.id)&&key.test(input.pubkey)&&/^[a-f0-9]{128}$/.test(input.sig),'Invalid review signature.');
  requireValue(Number.isSafeInteger(input.created_at)&&input.created_at>=0&&input.created_at<=now+300,'Invalid review time.');
  requireValue(typeof input.content==='string'&&input.content.length<=12000&&Array.isArray(input.tags)&&input.tags.length<=64&&input.tags.every(tag=>Array.isArray(tag)&&tag.length>=1&&tag.length<=4&&tag.every(value=>typeof value==='string'&&value.length<=2048)),'Invalid review fields.');
  // Copy canonical fields so a cached nostr-tools verification symbol cannot bless mutated data.
  const event={id:input.id,pubkey:input.pubkey,created_at:input.created_at,kind:input.kind,content:input.content,tags:input.tags.map(tag=>[...tag]),sig:input.sig};
  requireValue(encoder.encode(JSON.stringify(event)).length<=PRODUCT_REVIEW_LIMITS.eventBytes,'Review is too large.');
  requireValue(verifyEvent(event),'Invalid review signature.');return event as VerifiedEvent;
}
function subject(event:Event):string|undefined {return event.tags.find(tag=>tag[0]==='d')?.[1];}
function coordinate(event:Event):string|undefined {const d=subject(event);return d?`${PRODUCT_REVIEW_KIND}:${event.pubkey}:${d}`:undefined;}
function targetHint(event:Event):string|undefined {
  return address(subject(event))??address(event.tags.find(tag=>tag[0]==='a')?.[1]);
}
function project(event:VerifiedEvent,target:string|undefined,now:number):ProductReview {
  requireValue(event.kind===PRODUCT_REVIEW_KIND,'Not a product review.');
  const d=event.tags.filter(tag=>tag[0]==='d'),a=event.tags.filter(tag=>tag[0]==='a');
  requireValue(d.length===1&&d[0].length===2&&d[0][1].length>0&&d[0][1].length<=1024&&a.length<=1,'Ambiguous product review target.');
  const fromD=address(d[0][1]),fromA=a.length?address(a[0][1]):undefined;
  requireValue(!a.length||fromA&&a[0][1]===fromA,'Invalid product reference.');
  requireValue((fromD||fromA)&&(!fromD||!fromA||fromD===fromA),'Ambiguous product review target.');
  const targetAddress=fromD??fromA;
  requireValue(!target||targetAddress===productReviewTarget(target),'Review belongs to another product.');
  requireValue(targetAddress.split(':')[1]!==event.pubkey,'Self-reviews are not counted.');
  const expiration=event.tags.filter(tag=>tag[0]==='expiration');
  requireValue(expiration.length<=1&&(!expiration.length||expiration[0].length===2&&/^\d{1,16}$/.test(expiration[0][1])&&Number.isSafeInteger(Number(expiration[0][1]))&&Number(expiration[0][1])>now),'Review has expired or has an invalid expiry.');
  requireValue(Array.from(event.content).length<=PRODUCT_REVIEW_LIMITS.body,'Review is too large.');
  const ratings=new Map<string,number>();
  for(const tag of event.tags.filter(tag=>tag[0]==='rating')) {
    const score=Number(tag[1]),dimension=tag[2];
    requireValue(tag.length===3&&/^[a-z][a-z0-9_-]{0,47}$/.test(dimension)&&!ratings.has(dimension)&&/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(tag[1])&&Number.isFinite(score)&&score>=0&&score<=1,'Invalid product rating.');
    ratings.set(dimension,score);
  }
  requireValue(ratings.has('thumb'),'Product review has no primary rating.');
  return {scope:'product',format:fromD?(d[0][1].startsWith('a:')?'market-spec':'shopstr-legacy'):'shopstr-address',id:event.id,subject:d[0][1],author:event.pubkey,targetAddress,rating:ratings.get('thumb'),ratingMax:1,ratings:Object.fromEntries(ratings),body:event.content,updatedAt:event.created_at,event};
}
export function parseProductReview(input:Event,target?:string,now=seconds()):ProductReview {return project(checkedEvent(input,now),target,now);}

function projectVerified(events:VerifiedEvent[],target:string,now:number):ProductReview[] {
  const winners=new Map<string,VerifiedEvent>(),deletions=events.filter(event=>event.kind===5);
  for(const event of events)if(event.kind===PRODUCT_REVIEW_KIND) {
    const id=coordinate(event);if(!id)continue;
    const old=winners.get(id);if(!old||newer(event,old))winners.set(id,event);
  }
  // Select before semantic/expiry/deletion checks: an invalid or removed new version
  // must not resurrect an older rating, including a second legacy alias by that author.
  const authors=new Map<string,VerifiedEvent>();
  for(const event of winners.values())if(targetHint(event)===target) {
    const old=authors.get(event.pubkey);if(!old||newer(event,old))authors.set(event.pubkey,event);
  }
  const reviews:ProductReview[]=[];
  for(const event of authors.values()) {
    const removed=deletions.some(deletion=>deletion.pubkey===event.pubkey&&deletion.tags.some(tag=>tag[0]==='e'&&tag[1]===event.id||tag[0]==='a'&&tag[1]===coordinate(event)&&event.created_at<=deletion.created_at));
    if(removed)continue;
    try{reviews.push(project(event,target,now));}catch{/* A signed replacement can intentionally withdraw a previously valid review. */}
  }
  return reviews.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).slice(0,PRODUCT_REVIEW_LIMITS.reviews);
}
/** Signed, unordered snapshots; replacement controls may point away from the original product. */
export function productReviewsFromEvents(inputs:Event[],target:string,now=seconds()):ProductReview[] {
  productReviewTarget(target);const verified:VerifiedEvent[]=[];let bytes=0;
  for(const input of inputs.slice(0,PRODUCT_REVIEW_LIMITS.events))try {
    bytes+=encoder.encode(JSON.stringify(input)).length;if(bytes>PRODUCT_REVIEW_LIMITS.queryBytes)break;
    verified.push(checkedEvent(input,now));
  }catch{/* Untrusted input never enters projections. */}
  return projectVerified(verified,target,now);
}
/** Native dimensions, not stars or a claim of purchase verification. */
export function productReviewSummary(reviews:ProductReview[]) {
  requireValue(new Set(reviews.map(review=>review.targetAddress)).size<=1,'Keep reviews for different products separate.');
  const latest=new Map<string,ProductReview>();
  for(const review of reviews){const old=latest.get(review.author);if(!old||newer(review.event,old.event))latest.set(review.author,review);}
  const items=[...latest.values()];
  return {count:items.length,ratingMax:1 as const,averageThumb:items.length?items.reduce((sum,review)=>sum+review.rating,0)/items.length:null};
}

/** Bounded public reads: exact targets, current replacements, then their signed deletions. */
export async function loadProductReviews(target:string,{query,signal}:{query:ReviewQuery;signal?:AbortSignal}):Promise<{reviews:ProductReview[];partial:true;limited:boolean;incomplete:boolean}> {
  productReviewTarget(target);if(signal?.aborted)throw new DOMException('Review lookup cancelled.','AbortError');
  const controller=new AbortController(),abort=()=>controller.abort(new DOMException('Review lookup cancelled.','AbortError'));
  signal?.addEventListener('abort',abort,{once:true});let timer,bytes=0,limited=false,incomplete=false;
  const deadline=Date.now()+PRODUCT_REVIEW_LIMITS.timeoutMs,now=seconds();
  const cutoff=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Could not refresh reviews.'));controller.abort();},PRODUCT_REVIEW_LIMITS.timeoutMs);});
  const cancelled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
  async function read(filters:Filter[],limit:number) {
    const result=await Promise.race([query(filters,{signal:controller.signal,deadline,limit,cache:'network-only'}),cutoff,cancelled]);
    if(controller.signal.aborted)throw new DOMException('Review lookup cancelled.','AbortError');
    incomplete ||= result.complete!==true;limited ||= result.events.length>=limit;const events:VerifiedEvent[]=[];
    for(const input of result.events.slice(0,limit))try {
      bytes+=encoder.encode(JSON.stringify(input)).length;if(bytes>PRODUCT_REVIEW_LIMITS.queryBytes){limited=true;break;}
      events.push(checkedEvent(input,now));
    }catch{/* Invalid signed data consumes the read budget, not the review count. */}
    return events;
  }
  try {
    const initial=await read([{kinds:[PRODUCT_REVIEW_KIND],'#d':[`a:${target}`,target],limit:64},{kinds:[PRODUCT_REVIEW_KIND],'#a':[target],limit:64}],128);
    const known=initial.filter(event=>event.kind===PRODUCT_REVIEW_KIND&&targetHint(event)===target&&coordinate(event));
    const byCoordinate=new Map<string,VerifiedEvent>();for(const event of known){const id=coordinate(event),old=byCoordinate.get(id);if(!old||newer(event,old))byCoordinate.set(id,event);}
    const selected=[...byCoordinate.values()].sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id));
    if(!selected.length)return {reviews:[],partial:true,limited,incomplete};
    const authors=[...new Set(selected.map(event=>event.pubkey))],coordinates=selected.map(coordinate),identifiers=[...new Set(selected.map(subject))];
    const controls=await read([{kinds:[PRODUCT_REVIEW_KIND],authors,'#d':identifiers,limit:128}],128);
    // Extra relay results cannot inject a new product review through the control lookup.
    const allowed=new Set(coordinates),scoped=controls.filter(event=>event.kind===PRODUCT_REVIEW_KIND&&allowed.has(coordinate(event)));
    // Query the replacement's id too: e-only deletions must hide a newly discovered version.
    const ids=[...new Set([...selected,...scoped].map(event=>event.id))];
    const deletions=await read([{kinds:[5],authors,'#a':coordinates,limit:128},{kinds:[5],authors,'#e':ids,limit:128}],256);
    return {reviews:projectVerified([...selected,...scoped,...deletions.filter(event=>event.kind===5)],target,now),partial:true,limited,incomplete};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
