import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools';
import {validateDelivery,deliveryDraft} from '../src/delivery.ts';
import {signedListingPublication,revisedListingDraft} from '../src/composer.ts';
import {parseEvent} from '../src/market.ts';
import {createShippingResolver,matchesShippingDestination} from '../src/shipping.ts';
const values={title:'Desk',side:'offer',category:'home',currency:'EUR',shipping:{countries:['SE','FI'],price:'5.50'}};
const key=generateSecretKey(),signEvent=draft=>finalizeEvent(draft,key);
test('delivery validates explicit destinations and cost without inferring a country or free shipping',()=>{
  assert.equal(validateDelivery(undefined),undefined);assert.equal(validateDelivery(null),null);
  assert.deepEqual(validateDelivery({countries:['fi','FI'],price:'0'}),{countries:['FI'],price:'0'});
  for(const shipping of [{countries:[],price:'5'},{countries:['Worldwide'],price:'5'},{countries:['FI'],price:''},{countries:['FI'],price:'-1'}])assert.throws(()=>validateDelivery(shipping));
  assert.throws(()=>deliveryDraft(values.shipping,'?'));
});
test('signed delivery pair uses draft references accepted by the existing Ships to resolver',async()=>{
  const pair=await signedListingPublication(values,{identifier:'desk',signEvent});
  assert.equal(pair.shipping.kind,30406);assert.deepEqual(pair.shipping.tags.find(tag=>tag[0]==='price'),['price','5.50','EUR']);
  const listing=parseEvent(pair.event),resolver=createShippingResolver({query:async()=>({events:[pair.shipping],complete:true})});
  const info=(await resolver.load([listing])).byListing.get(listing.id);
  assert(matchesShippingDestination(info,'FI'));assert(matchesShippingDestination(info,'SE'));assert(!matchesShippingDestination(info,'US'));assert.equal(info.pickupAvailable,false);
});
test('pair and a partially signed option survive retries without resigning or moving timestamps',async()=>{
  let shipping,calls=0;
  await assert.rejects(signedListingPublication(values,{identifier:'desk',onShipping:event=>shipping=event,signEvent:draft=>{calls++;if(draft.kind===30402)throw Error('Signer declined');return signEvent(draft);}}));
  const pair=await signedListingPublication(values,{identifier:'desk',pendingShipping:shipping,signEvent:draft=>{assert.equal(draft.kind,30402);return signEvent(draft);}});
  assert.equal(pair.shipping,shipping);assert.equal(calls,2);
  const retry=await signedListingPublication(values,{pendingEvent:pair.event,pendingShipping:pair.shipping,signEvent:()=>{throw Error('must not sign');}});
  assert.equal(retry.event,pair.event);assert.equal(retry.shipping,pair.shipping);
});
test('unchanged listing edits keep delivery references; explicit remove or replace clears old references',async()=>{
  const pair=await signedListingPublication(values,{identifier:'desk',signEvent}),previous=parseEvent(pair.event);
  const {shipping,...unchanged}=values;
  assert.deepEqual(revisedListingDraft(unchanged,previous).tags.filter(tag=>tag[0]==='shipping_option'),previous.originalTags.filter(tag=>tag[0]==='shipping_option'));
  for(const shipping of [null,values.shipping])assert.equal(revisedListingDraft({...values,shipping},previous).tags.filter(tag=>tag[0]==='shipping_option').length,0);
  let signed=0;await assert.rejects(signedListingPublication({...values,shipping:{countries:[],price:'1'}},{signEvent:()=>signed++}));assert.equal(signed,0);
  await assert.rejects(signedListingPublication({...values,title:''},{signEvent:()=>signed++}));assert.equal(signed,0,'invalid listing fields must fail before the delivery signature');
});

test('delivery preview uses country names and formatted prices, including free delivery',async()=>{
  const {deliveryPreviewLabel}=await import('../src/composer.ts');
  assert.equal(deliveryPreviewLabel({countries:['FI'],price:'0'},'EUR','en-US'),'Free delivery to Finland');
  assert.equal(deliveryPreviewLabel({countries:['FI'],price:'5.50'},'EUR','en-US'),'Delivery to Finland · €5.50');
  assert.equal(deliveryPreviewLabel({countries:['FI','SE'],price:'0'},'EUR','en-US'),'Free delivery to Finland and Sweden');
  assert.equal(deliveryPreviewLabel(undefined,'EUR','en-US'),null);
});

test('unlock restores contextual control restrictions instead of enabling hidden draft fields',async()=>{
  const {composerControlState}=await import('../src/composer.ts');
  assert.deepEqual(composerControlState({busy:true,editing:true,shippingEnabled:true,category:'transport'}),{deliveryDisabled:true,transportDisabled:true,keepDisabled:true});
  assert.deepEqual(composerControlState({busy:false}),{deliveryDisabled:true,transportDisabled:true,keepDisabled:true});
  assert.deepEqual(composerControlState({busy:false,editing:true,shippingEnabled:true,category:'transport'}),{deliveryDisabled:false,transportDisabled:false,keepDisabled:false});
});
