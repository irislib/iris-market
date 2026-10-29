import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCondition, listingSearchText, listingSearchTexts } from '../src/search-condition.ts';
test('ordinary words become topics and longer searches preserve intent',()=>{
 assert.equal(searchCondition('  bicycle  '),'This text is about bicycle.');
 assert.equal(searchCondition('used chairs under 100 EUR'),'This listing matches this search: used chairs under 100 EUR');
 assert.equal(searchCondition('huonekalu'),'This text is about huonekalu.');
});
test('the classifier receives bounded plain listing data and offer/request direction',()=>{
 const result=listingSearchText({side:'request',title:'Camera',description:'Looking for one',category:'Tech',location:'Helsinki',price:'100',currency:'EUR'});
 assert.ok(result.startsWith('Wanted: Camera'));
 assert.ok(result.includes('Looking for one'));
 assert.ok(listingSearchText({title:'x',description:'a'.repeat(12000)}).length<=2000);
});


test('topic evidence separates the item title from lengthy sales copy; constraints retain full context',()=>{
 const item={title:'Cotton hoodie',description:'Marketing '.repeat(300),tags:['Clothing'],price:'45',currency:'EUR',location:'Helsinki'};
 const topics=listingSearchTexts(item,'clothing');assert.equal(topics[0],'Cotton hoodie');assert.match(topics[1],/Categories: Clothing/);assert(topics[1].length<800);
 const constrained=listingSearchTexts(item,'clothing under 50 EUR in Helsinki');assert.equal(constrained.length,1);assert.equal(constrained[0],listingSearchText(item));
 assert.equal(listingSearchTexts(item,'clothing','qwen35').length,1);
});
