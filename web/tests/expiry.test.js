import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools/pure';
import {EXPIRY_CHOICES,expiryFromChoice,relativeExpiry} from '../src/expiry.ts';
import {listingDraft,revisedListingDraft,signedListingForPublish} from '../src/composer.ts';
import {parseEvent,applyEvent,visibleListings} from '../src/market.ts';
const values={title:'Desk',description:'Oak',price:'95',currency:'EUR',side:'offer',category:'home'};
const expiration=draft=>draft.tags.find(tag=>tag[0]==='expiration')?.[1];

test('Never is the optional default and duration presets resolve to absolute seconds at event creation',()=>{
  const anchor=1_700_000_007;
  assert.equal(EXPIRY_CHOICES[0].value,'');assert.equal(EXPIRY_CHOICES[0].label,'Never');
  assert.equal(expiration(listingDraft(values,{createdAt:anchor})),undefined);
  for(const option of EXPIRY_CHOICES.slice(1))assert.equal(expiration(listingDraft({...values,expiration:option.value},{createdAt:anchor})),String(anchor+option.seconds));
  assert.equal(expiryFromChoice('',anchor),undefined);assert.throws(()=>expiryFromChoice('tomorrow',anchor));
  assert.throws(()=>expiryFromChoice('1d',NaN));
});

test('publish anchors a relative choice after preview and signed retries retain exact event, deadline and signature',async t=>{
  const previewAt=1_700_000_000,publishAt=previewAt+600,key=generateSecretKey();let signing=0;
  const preview=listingDraft({...values,expiration:'1w'},{identifier:'desk',createdAt:previewAt});
  t.mock.method(Date,'now',()=>publishAt*1000);
  const signed=await signedListingForPublish({...values,expiration:'1w'},{identifier:'desk',signEvent:draft=>{signing++;return finalizeEvent(draft,key);}});
  assert.equal(signed.created_at,publishAt);assert.equal(expiration(preview),String(previewAt+604800));assert.equal(expiration(signed),String(publishAt+604800));
  t.mock.method(Date,'now',()=>(publishAt+7200)*1000);
  const retry=await signedListingForPublish({...values,expiration:'1w'},{identifier:'desk',pendingEvent:signed,signEvent:()=>{throw Error('must not sign a retry');}});
  assert.equal(retry,signed);assert.equal(retry.created_at,publishAt);assert.equal(retry.sig,signed.sig);assert.equal(signing,1);
});

test('editing keeps the exact signed expiry unless a replacement duration or Never is explicitly chosen',t=>{
  const now=1_700_000_007,deadline=now-100+604800,key=generateSecretKey();t.mock.method(Date,'now',()=>now*1000);
  const signed=finalizeEvent(listingDraft({...values,expiration:'1w'},{identifier:'desk',createdAt:now-100}),key);
  const previous=parseEvent(signed);assert.equal(previous.expiration,deadline);
  for(const choice of [undefined,'keep'])assert.equal(expiration(revisedListingDraft({...values,title:'New title',...(choice===undefined?{}:{expiration:choice})},previous)),String(deadline));
  assert.equal(expiration(revisedListingDraft({...values,expiration:'1d'},previous)),String(now+86400));
  assert.equal(expiration(revisedListingDraft({...values,expiration:''},previous)),undefined);
  assert.equal(expiryFromChoice('keep',now,now-1),now-1,'keeping an expired deadline cannot revive it');
});

test('relative expiry labels are concise and absent deadlines have no label',()=>{
  const now=1_700_000_000;
  for(const value of [undefined,null,NaN,0])assert.equal(relativeExpiry(value,now),null);
  for(const [seconds,label] of [[30,'Expires in less than a minute'],[60,'Expires in 1 minute'],[3600,'Expires in 1 hour'],[86400,'Expires in 1 day'],[604800,'Expires in 1 week'],[2592000,'Expires in 1 month'],[7776000,'Expires in 3 months'],[31536000,'Expires in 1 year']])assert.equal(relativeExpiry(now+seconds,now),label);
  assert.equal(relativeExpiry(now,now),'Expired');
});

test('a duration-expired signed winner remains hidden and an older event cannot resurrect it',()=>{
  const key=generateSecretKey(),createdAt=1_700_000_000;
  const event=finalizeEvent(listingDraft({...values,expiration:'1d'},{identifier:'desk',createdAt}),key);
  const records=new Map();applyEvent(records,event);assert.equal(visibleListings(records,{now:createdAt+86400}).length,0);
  const older=finalizeEvent(listingDraft(values,{identifier:'desk',createdAt:createdAt-1}),key);applyEvent(records,older);assert.equal(visibleListings(records,{now:createdAt+86401}).length,0);
});
