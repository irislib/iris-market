import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey,verifyEvent} from 'nostr-tools/pure';
import {PRODUCT_REVIEW_KIND,PRODUCT_REVIEW_LIMITS,parseProductReview,productReviewsFromEvents,productReviewSummary,loadProductReviews,parseReview,productReviewTarget} from '../src/reviews.ts';

const secrets=Array.from({length:4},(_,i)=>new Uint8Array(32).fill(i+11)),keys=secrets.map(getPublicKey),now=Math.floor(Date.now()/1000);
const target=`30402:${keys[0]}:wooden:table`,other=`30402:${keys[0]}:wooden:chair`;
const review=(options={},secret=secrets[1])=>finalizeEvent({kind:31555,created_at:now,content:'Sturdy table.',tags:[['d',`a:${target}`],['rating','1','thumb'],['rating','0.8','quality']],...options},secret);
const deletion=(tags,created_at=now,secret=secrets[1])=>finalizeEvent({kind:5,created_at,content:'',tags},secret);
const tags=(d=`a:${target}`,rating='1',extra=[])=>[['d',d],['rating',rating,'thumb'],...extra];

test('market-spec product ratings keep their exact target, native dimensions and signed revision time',()=>{
  const value=review(),parsed=parseProductReview(value,target,now);
  assert.equal(value.kind,PRODUCT_REVIEW_KIND);assert.equal(parsed.scope,'product');assert.equal(parsed.format,'market-spec');
  assert.equal(parsed.targetAddress,target);assert.equal(parsed.author,keys[1]);assert.equal(parsed.rating,1);assert.equal(parsed.ratingMax,1);
  assert.deepEqual(parsed.ratings,{thumb:1,quality:0.8});assert.equal(parsed.updatedAt,now);assert.equal(parsed.body,value.content);
  assert.throws(()=>parseReview(value),/Invalid review/);assert.throws(()=>parseProductReview(value,other),/another product/);
  assert.equal(productReviewTarget(target),target);assert.throws(()=>productReviewTarget(keys[0]),/address/);
  assert.throws(()=>productReviewSummary([parsed,parseProductReview(review({tags:tags(`a:${other}`)}),other)]),/separate/);
});

test('Shopstr raw d and explicit a-address variants are exact product matches, never fuzzy seller targets',()=>{
  assert.equal(parseProductReview(review({tags:tags(target)}),target).format,'shopstr-legacy');
  assert.equal(parseProductReview(review({tags:tags('review-id','0',[['a',target]])}),target).format,'shopstr-address');
  for(const value of [review({tags:tags(`seller-${keys[0]}`)}),review({tags:tags('review-id','1',[['p',keys[0]]])}),review({tags:tags(`a:${target}`,'1',[['a',other]])}),review({tags:tags('review-id','1',[['a',target],['a',other]])})])assert.throws(()=>parseProductReview(value,target));
});

test('invalid scales, missing/duplicate primary ratings, future times, signatures and self-reviews are rejected',()=>{
  const invalid=[tags(`a:${target}`,'5'),tags(`a:${target}`,'-1'),tags(`a:${target}`,'Infinity'),tags(`a:${target}`,'NaN'),[['d',`a:${target}`],['rating','0.9','quality']],tags(`a:${target}`,'1',[['rating','0','thumb']]),tags(`a:${target}`,'1',[['d','another']]),tags(`a:${target}`,'1',[['rating','0.8junk','quality']])];
  for(const value of invalid)assert.throws(()=>parseProductReview(review({tags:value}),target));
  assert.throws(()=>parseProductReview(review({created_at:now+301}),target,now),/time/);
  assert.throws(()=>parseProductReview(review({},secrets[0]),target),/Self-review/);
  const mutated=review();assert(verifyEvent(mutated));mutated.content='Forged';assert.throws(()=>parseProductReview(mutated),/signature/);
  for(const kind of [7,1985,30382,38000])assert.throws(()=>parseProductReview(review({kind}),target));
});

test('addressable replacement ordering is stable, including same-second lower-id ties and one voice across aliases',()=>{
  const old=review({created_at:now-10,tags:tags(`a:${target}`,'0')}),latest=review(),legacy=review({created_at:now-1,tags:tags(target,'0')}),second=review({tags:tags(`a:${target}`,'0.5')},secrets[2]);
  assert.deepEqual(productReviewsFromEvents([old,latest,legacy,second],target).map(value=>value.id),productReviewsFromEvents([second,legacy,latest,old],target).map(value=>value.id));
  assert.deepEqual(productReviewSummary(productReviewsFromEvents([old,latest,legacy,second],target)),{count:2,ratingMax:1,averageThumb:0.75});
  const tie=review({content:'Same-second revision.'}),winner=[latest,tie].sort((a,b)=>a.id.localeCompare(b.id))[0];
  assert.equal(productReviewsFromEvents([latest,tie],target)[0].id,winner.id);
  assert.equal(productReviewsFromEvents([tie,latest],target)[0].id,winner.id);
});

test('expired, malformed and retargeted new versions never revive older visible scores',()=>{
  const old=review({created_at:now-10});
  for(const latest of [review({tags:tags(`a:${target}`,'1',[['expiration',String(now)]])}),review({tags:tags(`a:${target}`,'9')}),review({tags:tags(`a:${target}`,'1',[['a',other]])})])assert.deepEqual(productReviewsFromEvents([latest,old],target,now),[]);
  const initial=review({created_at:now-10,tags:tags('review-id','1',[['a',target]])}),retargeted=review({tags:tags('review-id','1',[['a',other]])});
  assert.deepEqual(productReviewsFromEvents([initial,retargeted],target),[]);
  assert.equal(productReviewsFromEvents([initial,retargeted],other)[0].id,retargeted.id);
});

test('NIP-09 deletions require the same signer; a deletes only earlier versions and e deletes the exact event',()=>{
  const old=review({created_at:now-20}),current=review(),coordinate=`31555:${keys[1]}:a:${target}`;
  assert.deepEqual(productReviewsFromEvents([old,deletion([['a',coordinate]],now-10)],target),[]);
  assert.equal(productReviewsFromEvents([old,current,deletion([['a',coordinate]],now-10)],target)[0].id,current.id);
  assert.equal(productReviewsFromEvents([current,deletion([['e',current.id]],now,secrets[2])],target).length,1);
  assert.deepEqual(productReviewsFromEvents([old,current,deletion([['e',current.id]])],target),[]);
  assert.deepEqual(productReviewsFromEvents([current,deletion([['a',coordinate]])],target),[]);
});

test('loader issues only exact bounded public queries and checks deletions of a newly discovered replacement',async()=>{
  const old=review({created_at:now-10}),latest=review(),removed=deletion([['e',latest.id]]),calls=[];
  const result=await loadProductReviews(target,{query:async(filters,options)=>{calls.push({filters,options});return {events:calls.length===1?[old]:calls.length===2?[latest]:[removed],complete:true};}});
  assert.equal(calls.length,3);assert.deepEqual(calls[0].filters,[{kinds:[31555],'#d':[`a:${target}`,target],limit:64},{kinds:[31555],'#a':[target],limit:64}]);
  assert.deepEqual(calls.map(call=>call.options.limit),[128,128,256]);assert(calls.every(call=>call.options.cache==='network-only'&&call.options.deadline<=Date.now()+PRODUCT_REVIEW_LIMITS.timeoutMs));
  assert(calls[2].filters.some(filter=>filter['#e']?.includes(latest.id)));assert.deepEqual(result.reviews,[]);assert.equal(result.incomplete,false);assert.equal(result.partial,true);
});

test('loader rejects unrelated injected results and handles complete/incomplete/oversized snapshots',async()=>{
  const value=review(),injected=review({tags:tags('unrequested','0',[['a',target]])},secrets[2]);let calls=0;
  const result=await loadProductReviews(target,{query:async()=>({events:++calls===1?[value]:calls===2?[injected]:[],complete:false})});
  assert.deepEqual(result.reviews.map(review=>review.id),[value.id]);assert.equal(result.incomplete,true);
  const oversized=await loadProductReviews(target,{query:async()=>({events:[{content:'x'.repeat(PRODUCT_REVIEW_LIMITS.queryBytes+1)},value],complete:true})});
  assert.deepEqual(oversized.reviews,[]);assert.equal(oversized.limited,true);
  const empty=await loadProductReviews(target,{query:async()=>({events:[],complete:true})});assert.equal(empty.incomplete,false);assert.deepEqual(empty.reviews,[]);
});

test('reader enforces cancellation even when an injected public query ignores the signal',{timeout:500},async()=>{
  const controller=new AbortController();let querySignal;
  const result=loadProductReviews(target,{signal:controller.signal,query:(_filters,options)=>{querySignal=options.signal;return new Promise(()=>{});}});
  controller.abort();await assert.rejects(result,{name:'AbortError'});assert.equal(querySignal.aborted,true);
});
