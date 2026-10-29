import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCondition, listingSearchText, listingSearchTexts } from '../src/search-condition.ts';
test('ordinary words become topics and longer searches preserve intent',()=>{
 assert.equal(searchCondition('  bicycle  '),'This text is about bicycle.');
 assert.equal(searchCondition('used chairs under 100 EUR'),'This listing offers used chairs under 100 EUR.');
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


test('only DeBERTa compound queries use the evaluated concrete proposition; topics and other backends retain their templates',()=>{
  for(const query of ['fresh apples','human edible products','red bicycle','waterproof hiking jacket','USB-C laptop charger','I want a repair service under 50 EUR in Helsinki, please?']){
    assert.equal(searchCondition(query,'deberta'),`This listing offers ${query}.`);
    for(const model of ['browser','qwen35'])assert.equal(searchCondition(query,model),`This listing matches this search: ${query}`);
  }
  for(const query of ['apples','food','huonekalu','USB-C'])for(const model of ['deberta','browser','qwen35'])assert.equal(searchCondition(query,model),`This text is about ${query}.`);
  assert.equal(searchCondition('  Red bicycle, under 100 EUR?!  ','deberta'),'This listing offers Red bicycle, under 100 EUR?!.');
});

test('projection omits unknown metadata and a currency without an actual price',()=>{
 const input={side:'offer',title:'Fresh apples',description:'Fresh eating apples from our orchard. Sold by the kilogram.'};
 const expected='Offered: Fresh apples\nFresh eating apples from our orchard. Sold by the kilogram.';
 assert.equal(listingSearchText(input),expected);assert.equal(listingSearchText({...input,price:'',currency:'EUR',category:' ',location:''}),expected);
 assert.equal(listingSearchText({title:'Example'}),'Example','unprovided direction is not invented');
 assert.doesNotMatch(expected,/Category:|Location:|Price:/);
});
test('real metadata constraints, including zero price, survive long-description truncation',()=>{
 const input={side:'offer',title:'Red bicycle',description:'Long description '.repeat(400),category:'transport',location:'Helsinki',price:'80',currency:'EUR'};
 const result=listingSearchText(input);assert(result.length<=2000);for(const field of ['Category: transport','Location: Helsinki','Price: 80 EUR'])assert(result.includes(field));
 assert(listingSearchText({...input,description:'',price:0}).includes('Price: 0 EUR'));assert(listingSearchText({...input,description:'',currency:''}).includes('Price: 80'));assert(!listingSearchText({...input,description:'',currency:''}).includes('EUR'));
});
