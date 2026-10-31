import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../../crates/market-core/tests/fixtures/reviews-interop.json' with {type:'json'};
import {parseReview,effectiveReviews} from '../src/reviews.ts';
import {parseProductReview,productReviewsFromEvents} from '../src/product-reviews.ts';
const {events,now}=fixture;
test('signed shared review fixtures reproduce browser winners, deletions and separate native scales',()=>{
 assert.equal(fixture.version,1);assert(fixture.cases.length>=16);
 for(const scenario of fixture.cases){const inputs=scenario.events.map(name=>events[name]);const reviews=scenario.product?productReviewsFromEvents(inputs,scenario.target,now):effectiveReviews(inputs.flatMap(event=>{try{return[parseReview(event,scenario.target,now)];}catch{return[];}}));
 const actual=reviews.map(review=>({event:Object.keys(events).find(name=>events[name].id===review.id),rating:review.rating,ratingMax:scenario.product?review.ratingMax:5,body:review.body})).sort((a,b)=>events[a.event].id.localeCompare(events[b.event].id));assert.deepEqual(actual,scenario.expected,scenario.name);}
 assert.equal(parseProductReview(events.market_spec,fixture.productTarget,now).format,'market-spec');assert.equal(parseProductReview(events.shopstr_legacy,fixture.productTarget,now).format,'shopstr-legacy');assert.equal(parseProductReview(events.shopstr_address,fixture.productTarget,now).format,'shopstr-address');
});
test('shared signed invalid fixtures reject forged authorship, self reviews and malformed rating/time fields',()=>{
 for(const invalid of fixture.invalid)assert.throws(()=>invalid.product?parseProductReview(events[invalid.event],invalid.target,now):parseReview(events[invalid.event],invalid.target,now),undefined,invalid.event);
});
