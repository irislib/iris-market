import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSecretKey,finalizeEvent} from 'nostr-tools';
import {courierListingType,transportTypeTags} from '../src/transport-type.ts';
import {listingDraft,revisedListingDraft} from '../src/composer.ts';
import {parseEvent} from '../src/market.ts';
const values={title:'Transport',side:'offer',category:'transport',currency:'EUR'},tags=draft=>draft.tags.filter(tag=>tag[0]==='t').map(tag=>tag[1]);
test('explicit transport choices produce existing searchable tags without parcel bias',()=>{
  for(const type of ['parcel','passenger','both']){const draft=listingDraft({...values,transportType:type});assert.deepEqual(tags(draft),['transport',...transportTypeTags(type)]);assert.equal(courierListingType({tags:tags(draft)}),type);}
  assert.deepEqual(tags(listingDraft(values)),['transport']);assert.deepEqual(tags(listingDraft({...values,category:'home',transportType:'parcel'})),['home']);assert.throws(()=>listingDraft({...values,transportType:'spaceship'}));
});
test('transport aliases and unknown extras survive unchanged edits; explicit mode changes replace only known mode tags',()=>{
  const previous=parseEvent(finalizeEvent(listingDraft({...values,tags:['deliveries','fragile','local']}),generateSecretKey()));
  assert.equal(courierListingType(previous),'parcel');
  assert(tags(revisedListingDraft({...values,title:'Updated'},previous)).includes('deliveries'));
  const next=revisedListingDraft({...values,transportType:'passenger',tags:['deliveries','fragile','local']},previous);
  assert.deepEqual(tags(next),['transport','fragile','local','courier','passenger']);
  const clear=revisedListingDraft({...values,transportType:'none',tags:['deliveries','fragile']},previous);assert.deepEqual(tags(clear),['transport','fragile']);
  assert.equal(courierListingType({tags:['ride','parcels']}),'both');assert.equal(courierListingType({tags:['car']}),null);
});
