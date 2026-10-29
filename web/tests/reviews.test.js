import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey,verifyEvent} from 'nostr-tools/pure';
import {REVIEW_KIND,REVIEW_LIMITS,buildReviewDraft,validateReviewDraft,parseReview,mergeReviews,effectiveReviews,reviewSummary,reviewTarget,cachedReviews,rememberReview,loadReviews} from '../src/reviews.ts';

const secrets=Array.from({length:6},(_,i)=>new Uint8Array(32).fill(i+1)),keys=secrets.map(getPublicKey);
const subject='bc24f90d-b8da-4441-8fe4-51af2178bd84',now=Math.floor(Date.now()/1000);
const draft=(options={})=>buildReviewDraft({target:keys[0],author:keys[1],rating:4,body:'Easy collection.',subject,now,...options});
const event=(options={},secret=secrets[1])=>finalizeEvent(draft({...options,author:getPublicKey(secret)}),secret);
const editTag=(value,name,update)=>{const copy=structuredClone(value);const index=copy.tags.findIndex(tag=>tag[0]===name);copy.tags[index]=update(copy.tags[index]);return copy;};

test('profile review uses the Iris Maps fact envelope and binds public reviewer to its signer',()=>{
  const value=event(),review=parseReview(value,keys[0],now);
  assert.equal(value.kind,7368);assert.equal(value.content,'');assert.deepEqual(value.tags[0],['i',subject,'subject']);
  assert(value.tags.some(tag=>JSON.stringify(tag)===JSON.stringify(['reviewer',keys[1]])));
  assert(value.tags.some(tag=>JSON.stringify(tag)===JSON.stringify(['review_of',keys[0]])));
  assert(value.tags.some(tag=>JSON.stringify(tag)===JSON.stringify(['rating','4','5'])));
  assert.deepEqual(value.tags.filter(tag=>tag[0]==='i').slice(1).map(tag=>tag[1]).sort(),[reviewTarget(keys[0]),`iris-market:review:${subject}`,keys[1]].sort());
  assert.deepEqual(value.tags.filter(tag=>tag[0]==='p').map(tag=>tag[1]).sort(),[keys[0],keys[1]].sort());
  assert.equal(review.author,keys[1]);assert.equal(review.target,keys[0]);assert.equal(review.rating,4);assert.equal(review.body,'Easy collection.');
  assert.equal(review.delivery,'published');assert.equal(review.createdAt,now);assert.equal(review.updatedAt,now);
  assert.equal(value.tags.some(tag=>['verified_purchase','order','order_id','address'].includes(tag[0])),false);
});

test('fresh signature verification rejects altered objects even after nostr-tools cached verification',()=>{
  const value=event();assert(verifyEvent(value));
  value.tags.find(tag=>tag[0]==='body')[1]='A forged review';
  // The library cache is intentionally bypassed at the imported event boundary.
  assert.throws(()=>parseReview(value),/signature/);
  const wrongTarget=event();assert.throws(()=>parseReview(wrongTarget,keys[2]),/another profile/);
});

test('signing boundary rejects spoofed authors, ambiguous fields, indexes, extra payload and invalid ratings',()=>{
  for(const bad of [
    editTag(draft(),'reviewer',()=>['reviewer',keys[2]]),
    {...draft(),tags:[...draft().tags,['rating','5','5']]},
    {...draft(),tags:[...draft().tags,['private_order','hidden']]},
    editTag(draft(),'source',()=>['source','other-app']),
    editTag(draft(),'rating',()=>['rating','0','5']),
    editTag(draft(),'rating',()=>['rating','6','5']),
    editTag(draft(),'rating',()=>['rating','4','10']),
    editTag(draft(),'i',()=>['i','not-a-uuid','subject']),
    {...draft(),tags:draft().tags.filter(tag=>!(tag[0]==='p'&&tag[1]===keys[0]))},
    {...draft(),content:'Unrelated public text'},
    {...draft(),created_at:now+301},
    editTag(draft(),'published_at',()=>['published_at',String(now+1)]),
  ])assert.throws(()=>validateReviewDraft(bad,keys[1],now));
  assert.throws(()=>draft({target:keys[1]}),/own profile/);
  assert.throws(()=>draft({body:'a'.repeat(3001)}),/3000/);
});

test('unsigned size budget reserves the signature before invoking an external signer',()=>{
  const value=draft({body:'x'}),body=value.tags.find(tag=>tag[0]==='body');
  const base=new TextEncoder().encode(JSON.stringify({...value,pubkey:keys[1]})).length;
  body[1]='€'.repeat(Math.floor((REVIEW_LIMITS.eventBytes-base-50)/3));
  assert(new TextEncoder().encode(JSON.stringify({...value,pubkey:keys[1]})).length<REVIEW_LIMITS.eventBytes);
  assert(body[1].length<REVIEW_LIMITS.body);
  assert.throws(()=>validateReviewDraft(value,keys[1],now),/too large/);
});

test('revisions converge by author and subject; averages count each author once',()=>{
  const initial=parseReview(event({rating:1,now:now-10})),edited=parseReview(event({rating:5,createdAt:now-10,now}));
  const duplicate=parseReview(event({subject:'c424f90d-b8da-4441-8fe4-51af2178bd84',rating:3,now:now-2}));
  const other=parseReview(event({rating:3,now:now-1},secrets[2]));
  const a=mergeReviews([initial,edited,duplicate,other]),b=mergeReviews([other,duplicate,edited,initial]);
  assert.deepEqual(a.map(review=>review.id),b.map(review=>review.id));assert.equal(a.length,3);
  assert.equal(effectiveReviews(a).length,2);assert.deepEqual(reviewSummary(a),{count:2,average:4});
  const tied=parseReview(event({rating:2,createdAt:now-10,now}));
  const expected=[edited.id,tied.id].sort()[0];assert.equal(mergeReviews([edited,tied])[0].id,expected);assert.equal(mergeReviews([tied,edited])[0].id,expected);
});

test('many identifiers from one author cannot crowd another author out of the bounded summary',()=>{
  const base=parseReview(event()),other=parseReview(event({now:now-1},secrets[2]));
  // These projections have already passed the signature boundary; avoid redundant crypto in the bound test.
  const repeated=Array.from({length:REVIEW_LIMITS.reviews+30},(_,i)=>({...base,subject:`subject-${i}`}));
  const result=mergeReviews(repeated,[other]);assert.equal(result.length,REVIEW_LIMITS.reviews);assert(result.some(review=>review.author===keys[2]));
  assert.equal(reviewSummary(result).count,2);
});

test('queued reviews remain visible locally and network observation replaces queued delivery',async()=>{
  const value=event({target:keys[3]}),queued=cachedReviews(keys[3],[value]);
  assert.equal(queued.length,1);assert.equal(queued[0].delivery,'queued');rememberReview(queued[0]);
  let call;
  const result=await loadReviews(keys[3],{pending:[value],query:async(filters,options)=>{call={filters,options};return {events:[value],complete:true};}});
  assert.deepEqual(call.filters,[{kinds:[REVIEW_KIND],'#i':[reviewTarget(keys[3])],limit:256}]);assert.equal(call.options.limit,REVIEW_LIMITS.events);
  assert(call.options.deadline>Date.now()-100);assert(call.options.deadline<=Date.now()+REVIEW_LIMITS.timeoutMs);
  assert.equal(result.reviews.length,1);assert.equal(result.reviews[0].delivery,'published');assert.equal(result.partial,true);
  assert.equal(cachedReviews(keys[3],[value])[0].delivery,'published');
});

test('bounded review reads ignore wrong targets and bad signatures, and flag truncated input',async()=>{
  const valid=event({target:keys[4]}),wrong=event(),forged=structuredClone(valid);forged.sig='0'.repeat(128);
  const result=await loadReviews(keys[4],{query:async()=>({events:[valid,wrong,forged,...Array(REVIEW_LIMITS.events).fill({})]})});
  assert.equal(result.reviews.length,1);assert.equal(result.reviews[0].id,valid.id);assert.equal(result.limited,true);
  const oversized=await loadReviews(keys[5],{query:async()=>({events:[{content:'x'.repeat(REVIEW_LIMITS.queryBytes+1)},event({target:keys[5]})]})});
  assert.equal(oversized.reviews.length,0);assert.equal(oversized.limited,true);
});

test('cancellation finishes promptly even when an injected query ignores its signal',{timeout:500},async()=>{
  const controller=new AbortController();let querySignal;
  const result=loadReviews(keys[0],{signal:controller.signal,query:(_filters,options)=>{querySignal=options.signal;return new Promise(()=>{});}});
  controller.abort();await assert.rejects(result,{name:'AbortError'});assert.equal(querySignal.aborted,true);
  await assert.rejects(loadReviews(keys[0],{signal:controller.signal,query:async()=>{throw Error('Must not be called');}}),{name:'AbortError'});
});
