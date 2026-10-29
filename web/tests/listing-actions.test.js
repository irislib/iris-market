import test from 'node:test';
import assert from 'node:assert/strict';
import {listingEnquiry} from '../src/listing-actions.ts';
test('selling action prepares a purchase enquiry with its exact listing link and does not perform checkout',()=>{
 const result=listingEnquiry({id:'author:desk + 1',title:'Oak desk',side:'offer'},'https://market.iris.to');
 assert.equal(result.label,'Buy');assert.match(result.draft,/I’d like to buy “Oak desk”/);const url=new URL(result.draft.split('\n').at(-1));assert.equal(url.origin,'https://market.iris.to');assert.equal(url.searchParams.get('listing'),'author:desk + 1');assert.equal(url.searchParams.size,1);
});
test('buying listings prepare a response rather than a purchase of the request',()=>{
 const result=listingEnquiry({id:'author:help',title:'Moving help',side:'request'},'https://market.iris.to');assert.equal(result.label,'Respond');assert.ok(result.draft.startsWith('I can help with “Moving help”.'));
});
test('enquiry links preserve a Hashtree directory mount and exclude unrelated queries or capabilities',()=>{
 for(const href of ['https://files.iris.to/htree/npub-demo/market/?profile=someone&listing=old&invite=1#private-capability','https://files.iris.to/htree/npub-demo/market/index.html?preview=1#private-capability']){
  const result=listingEnquiry({id:'author:desk',title:'Desk',side:'offer'},href),url=new URL(result.draft.split('\n').at(-1));
  assert.equal(url.pathname,'/htree/npub-demo/market/');assert.equal(url.searchParams.get('listing'),'author:desk');assert.equal(url.searchParams.size,1);assert.equal(url.hash,'');assert.equal(result.draft.includes('private-capability'),false);
 }
});
