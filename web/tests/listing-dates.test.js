import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools/pure';
import {listingPublishedAt,expirationFromInput,expirationInput} from '../src/listing-dates.ts';
import {listingDraft,revisedListingDraft} from '../src/composer.ts';
import {parseEvent,applyEvent,visibleListings} from '../src/market.ts';
const values={title:'Desk',description:'Oak',price:'95',currency:'EUR',side:'offer',category:'home'};
test('publication dates use the original signed date and safely fall back for missing or invalid tags',()=>{
 assert.equal(listingPublishedAt({createdAt:200,originalTags:[['published_at','100']]}),100);
 for(const value of ['-1','NaN','201','1e2','999999999999999999999'])assert.equal(listingPublishedAt({createdAt:200,originalTags:[['published_at',value]]}),200);
 assert.equal(listingPublishedAt({createdAt:200}),200);assert.equal(listingPublishedAt({}),undefined);
});
test('expiry is optional, validates local calendar times and requires a future instant',()=>{
 const now=Math.floor(Date.now()/60000)*60,expiry=now+3600;
 assert.equal(expirationFromInput(''),undefined);assert.equal(expirationFromInput(expirationInput(expiry),now),expiry);
 for(const value of ['bad','2027-02-31T10:00','2027-13-01T10:00',expirationInput(now)])assert.throws(()=>expirationFromInput(value,now),/expiry/);
});
test('editing preserves the original added date, can change or remove expiry, and expired winners never resurrect',()=>{
 const secret=generateSecretKey(),now=Math.floor(Date.now()/60000)*60,expires=now+3600;
 const initial=finalizeEvent(listingDraft({...values,expiration:expirationInput(expires)},{createdAt:now-100,identifier:'desk'}),secret),previous=parseEvent(initial);
 const edited=finalizeEvent(revisedListingDraft({...values,title:'Oak desk',expiration:expirationInput(expires+3600)},previous),secret),next=parseEvent(edited);
 assert.equal(listingPublishedAt(next),now-100);assert.equal(next.expiration,expires+3600);
 const noExpiry=parseEvent(finalizeEvent(revisedListingDraft({...values,expiration:''},next),secret));assert.equal(noExpiry.expiration,null);assert.equal(listingPublishedAt(noExpiry),now-100);
 const records=new Map();applyEvent(records,edited);assert.equal(visibleListings(records,{now:expires+3600}).length,0);applyEvent(records,initial);assert.equal(visibleListings(records,{now:expires+3601}).length,0);
});
