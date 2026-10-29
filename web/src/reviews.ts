// Fact-envelope layout reused from Iris Maps src/lib/mapFactEvents.ts (MIT).
// Reviews are public statements by their signer, never purchase verification.
import {verifyEvent} from 'nostr-tools/pure';
import type {Event,EventTemplate,Filter,UnsignedEvent,VerifiedEvent} from 'nostr-tools';
export {PRODUCT_REVIEW_KIND,PRODUCT_REVIEW_LIMITS,productReviewTarget,parseProductReview,productReviewsFromEvents,productReviewSummary,loadProductReviews} from './product-reviews.ts';
export type {ProductReview} from './product-reviews.ts';

export const REVIEW_KIND=7368;
export const REVIEW_LIMITS=Object.freeze({reviews:128,events:512,eventBytes:8192,queryBytes:1024*1024,timeoutMs:6000,body:3000});
export interface Review {id:string;subject:string;author:string;target:string;rating:number;body:string;createdAt:number;updatedAt:number;event:VerifiedEvent;delivery:'queued'|'published'}
export interface ReviewDraftInput {target:string;author:string;rating:number;body?:string;subject?:string;createdAt?:number;now?:number}
export type ReviewQuery=(filters:Filter[],options?:{signal?:AbortSignal;deadline?:number;limit?:number;cache?:'cache-first'|'network-only'|'cache-only'})=>Promise<{events:Event[];complete?:boolean;reason?:string}>;
export interface ReviewAccount {owner?:string;canSign:boolean;pending?:Event[]}
export type PublishReview=(draft:EventTemplate)=>Promise<{event:Event;delivery:string}>;
const key=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder=new TextEncoder(),seconds=()=>Math.floor(Date.now()/1000);
const cache=new Map<string,Review[]>();
const assert=(condition:unknown,message:string):void=>{if(!condition)throw new Error(message);};
export function reviewTarget(pubkey:string):string {assert(key.test(pubkey),'Invalid profile.');return `iris-market:profile:${pubkey}`;}
function single(tags:string[][],name:string,required=true):string[]|undefined {
  const found=tags.filter(tag=>tag[0]===name);assert(found.length<=1&&(!required||found.length===1),'Invalid review fields.');return found[0];
}
function timestamp(tag:string[]|undefined):number {assert(tag?.length===2&&/^\d{1,16}$/.test(tag[1]),'Invalid review time.');const value=Number(tag[1]);assert(Number.isSafeInteger(value),'Invalid review time.');return value;}
function fields(event:UnsignedEvent,now:number) {
  assert(event&&event.kind===REVIEW_KIND&&event.content===''&&key.test(event.pubkey),'Invalid review.');
  assert(Number.isSafeInteger(event.created_at)&&event.created_at>=0&&event.created_at<=now+300,'Invalid review time.');
  assert(Array.isArray(event.tags)&&event.tags.length<=24&&event.tags.every(tag=>Array.isArray(tag)&&tag.length>=2&&tag.length<=4&&tag.every(value=>typeof value==='string'&&value.length<=12000)),'Invalid review fields.');
  assert(encoder.encode(JSON.stringify(event)).length<=REVIEW_LIMITS.eventBytes,'Review is too large.');
  const subjectTags=event.tags.filter(tag=>tag[0]==='i'&&tag[2]==='subject');
  assert(subjectTags.length===1&&subjectTags[0].length===3&&uuid.test(subjectTags[0][1]),'Invalid review identifier.');
  const subject=subjectTags[0][1],targetTag=single(event.tags,'review_of'),reviewer=single(event.tags,'reviewer');
  assert(targetTag.length===2&&key.test(targetTag[1])&&reviewer.length===2&&reviewer[1]===event.pubkey,'Review author does not match its signer.');
  const target=targetTag[1];assert(target!==event.pubkey,'You cannot review your own profile.');
  const type=single(event.tags,'type'),ratingTag=single(event.tags,'rating'),source=single(event.tags,'source'),sourceId=single(event.tags,'source_id'),bodyTag=single(event.tags,'body',false);
  assert(type.length===2&&type[1]==='review'&&source.length===2&&source[1]==='iris-market'&&sourceId.length===2&&sourceId[1]===`iris-market:review:${subject}`,'Invalid review fields.');
  assert(ratingTag.length===3&&/^[1-5]$/.test(ratingTag[1])&&ratingTag[2]==='5','Choose a rating from 1 to 5.');
  assert(!bodyTag||bodyTag.length===2&&Array.from(bodyTag[1]).length<=REVIEW_LIMITS.body,'Review must be up to 3000 characters.');
  const allowed=new Set(['i','p','type','reviewer','review_of','rating','body','source','source_id','published_at','updated_at']);
  assert(event.tags.every(tag=>allowed.has(tag[0])),'Unsupported review fields.');
  const indexes=event.tags.filter(tag=>tag[0]==='i'&&tag[2]!=='subject');
  const expectedIndexes=new Set([reviewTarget(target),`iris-market:review:${subject}`,event.pubkey]);
  assert(indexes.length===3&&indexes.every(tag=>tag.length===2&&expectedIndexes.delete(tag[1]))&&expectedIndexes.size===0,'Invalid review target indexes.');
  const people=event.tags.filter(tag=>tag[0]==='p'),expectedPeople=new Set([target,event.pubkey]);
  assert(people.length===2&&people.every(tag=>tag.length===2&&expectedPeople.delete(tag[1]))&&expectedPeople.size===0,'Invalid review people.');
  const createdAt=timestamp(single(event.tags,'published_at')),updatedAt=timestamp(single(event.tags,'updated_at'));
  assert(createdAt<=updatedAt&&updatedAt<=event.created_at&&event.created_at-updatedAt<=300,'Invalid review time.');
  return {subject,author:event.pubkey,target,rating:Number(ratingTag[1]),body:bodyTag?.[1]??'',createdAt,updatedAt};
}
/** Public signer boundary: validates only the supported profile-review facts. */
export function validateReviewDraft(draft:EventTemplate,author:string,now=seconds()):EventTemplate {
  // Include the eventual signature and identifier in the budget before invoking a signer.
  const signedSize={...draft,pubkey:author,id:'0'.repeat(64),sig:'0'.repeat(128)};
  fields(signedSize,now);return draft;
}
export function buildReviewDraft({target,author,rating,body='',subject=crypto.randomUUID(),createdAt,now=seconds()}:ReviewDraftInput):EventTemplate {
  const published=createdAt??now;
  const facts=[['type','review'],['reviewer',author],['review_of',target],['rating',String(rating),'5'],...(body.trim()?[['body',body.trim()]]:[]),['published_at',String(published)],['source','iris-market'],['source_id',`iris-market:review:${subject}`],['updated_at',String(now)]];
  facts.sort((a,b)=>a[0].localeCompare(b[0])||JSON.stringify(a.slice(1)).localeCompare(JSON.stringify(b.slice(1))));
  const indexes=[reviewTarget(target),`iris-market:review:${subject}`,author].sort().map(value=>['i',value]);
  const draft={kind:REVIEW_KIND,content:'',created_at:now,tags:[['i',subject,'subject'],...indexes,...[target,author].sort().map(value=>['p',value]),...facts]};
  return validateReviewDraft(draft,author,now);
}
export function parseReview(input:Event,target?:string,now=seconds()):Review {
  assert(input&&key.test(input.id)&&typeof input.sig==='string'&&/^[a-f0-9]{128}$/.test(input.sig),'Invalid review signature.');
  // Never trust nostr-tools' cached verification symbol on mutable input.
  const event={id:input.id,pubkey:input.pubkey,created_at:input.created_at,kind:input.kind,content:input.content,tags:input.tags?.map(tag=>Array.isArray(tag)?[...tag]:tag),sig:input.sig};
  const review=fields(event,now);assert(!target||review.target===target,'Review belongs to another profile.');
  assert(verifyEvent(event),'Invalid review signature.');
  return {...review,id:event.id,event:event as VerifiedEvent,delivery:'published'};
}
const newer=(a:Review,b:Review)=>a.event.created_at>b.event.created_at||a.event.created_at===b.event.created_at&&a.id<b.id;
export function mergeReviews(...groups:Review[][]):Review[] {
  const winners=new Map<string,Review>();
  for(const review of groups.flat()){const id=`${review.author}:${review.subject}`,previous=winners.get(id);if(!previous||newer(review,previous)||review.id===previous.id&&review.delivery==='published')winners.set(id,review);}
  const sorted=[...winners.values()].sort((a,b)=>b.event.created_at-a.event.created_at||a.id.localeCompare(b.id));
  // Creating many review identifiers must not crowd other authors out of the local cache.
  const authors=new Set<string>(),latest:Review[]=[],older:Review[]=[];
  for(const review of sorted){if(authors.has(review.author))older.push(review);else{authors.add(review.author);latest.push(review);}}
  return [...latest.slice(0,REVIEW_LIMITS.reviews),...older.slice(0,Math.max(0,REVIEW_LIMITS.reviews-latest.length))]
    .sort((a,b)=>b.event.created_at-a.event.created_at||a.id.localeCompare(b.id));
}
/** One voice per signed author, even when that author creates several subjects. */
export function effectiveReviews(reviews:Review[]):Review[] {const authors=new Map<string,Review>();for(const review of mergeReviews(reviews)){const old=authors.get(review.author);if(!old||newer(review,old))authors.set(review.author,review);}return [...authors.values()];}
export function reviewSummary(reviews:Review[]) {const effective=effectiveReviews(reviews);return {count:effective.length,average:effective.length?effective.reduce((sum,review)=>sum+review.rating,0)/effective.length:0};}
export function cachedReviews(target:string,pending:Event[]=[]):Review[] {
  reviewTarget(target);const queued:Review[]=[];
  for(const event of pending.slice(0,128))try{queued.push({...parseReview(event,target),delivery:'queued'});}catch{}
  return mergeReviews(cache.get(target)??[],queued);
}
export function rememberReview(review:Review):void {if(!cache.has(review.target)&&cache.size>=16)cache.delete(cache.keys().next().value);cache.set(review.target,mergeReviews(cache.get(review.target)??[],[review]));}
export async function loadReviews(target:string,{query,signal,pending=[]}:{query:ReviewQuery;signal?:AbortSignal;pending?:Event[]}):Promise<{reviews:Review[];partial:true;limited:boolean;incomplete:boolean}> {
  const index=reviewTarget(target);if(signal?.aborted)throw new DOMException('Review lookup cancelled.','AbortError');
  const controller=new AbortController(),abort=()=>controller.abort(new DOMException('Review lookup cancelled.','AbortError'));signal?.addEventListener('abort',abort,{once:true});
  let timer;const deadline=Date.now()+REVIEW_LIMITS.timeoutMs;
  const cutoff=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Could not refresh reviews.'));controller.abort();},REVIEW_LIMITS.timeoutMs);});
  const cancelled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
  try {
    const result=await Promise.race([query([{kinds:[REVIEW_KIND],'#i':[index],limit:256}],{signal:controller.signal,deadline,limit:REVIEW_LIMITS.events,cache:'cache-first'}),cutoff,cancelled]);
    if(controller.signal.aborted)throw new DOMException('Review lookup cancelled.','AbortError');
    let bytes=0,limited=result.events.length>REVIEW_LIMITS.events;const observed:Review[]=[];
    for(const event of result.events.slice(0,REVIEW_LIMITS.events)){
      bytes+=encoder.encode(JSON.stringify(event)).length;if(bytes>REVIEW_LIMITS.queryBytes){limited=true;break;}
      try{observed.push(parseReview(event,target));}catch{/* Untrusted reviews do not enter projections. */}
    }
    const reviews=mergeReviews(cachedReviews(target,pending),observed);for(const review of reviews)rememberReview(review);
    return {reviews,partial:true,limited,incomplete:result.complete===false};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
