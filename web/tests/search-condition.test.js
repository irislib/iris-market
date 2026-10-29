import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCondition, listingSearchText } from '../src/search-condition.ts';
test('ordinary words become topics and longer searches preserve intent',()=>{
 assert.equal(searchCondition('  bicycle  '),'This listing is about bicycle.');
 assert.equal(searchCondition('used chairs under 100 EUR'),'This listing matches this search: used chairs under 100 EUR');
 assert.equal(searchCondition('huonekalu'),'This listing is about huonekalu.');
});
test('the classifier receives bounded plain listing data and offer/request direction',()=>{
 const result=listingSearchText({side:'request',title:'Camera',description:'Looking for one',category:'Tech',location:'Helsinki',price:'100',currency:'EUR'});
 assert.ok(result.startsWith('Wanted: Camera'));
 assert.ok(result.includes('Looking for one'));
 assert.ok(listingSearchText({title:'x',description:'a'.repeat(12000)}).length<=2000);
});
