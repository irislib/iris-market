import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCondition, listingSearchText, listingSearchEvidence, scoreSearchListing } from '../src/search-condition.ts';
test('ordinary words become topics and longer searches preserve intent',()=>{
 assert.equal(searchCondition('  bicycle  '),'The item being offered is bicycle.');
 assert.equal(searchCondition('used chairs under 100 EUR'),'This listing offers used chairs under 100 EUR.');
 assert.equal(searchCondition('huonekalu'),'The item being offered is huonekalu.');
});
test('the classifier receives bounded plain listing data and offer/request direction',()=>{
 const result=listingSearchText({side:'request',title:'Camera',description:'Looking for one',category:'Tech',location:'Helsinki',price:'100',currency:'EUR'});
 assert.ok(result.startsWith('Wanted: Camera'));
 assert.ok(result.includes('Looking for one'));
 assert.ok(listingSearchText({title:'x',description:'a'.repeat(12000)}).length<=2000);
});


test('topic decisions combine product identity and details, including seller categories',async()=>{
 const item={side:'offer',title:"Pen Wrap: 'Kites'",description:'Pen wrap for pen. Pen included.',tags:['Crafts']};
 const inputs=listingSearchEvidence(item,'meat');
 assert.deepEqual(inputs.map(p=>p.condition),['This item is meat.','This listing offers meat.']);
 assert(inputs.every(p=>p.text.includes(item.title)&&p.text.includes('Category: Crafts.')));
 assert(!inputs[0].text.includes(item.description));assert(inputs[1].text.includes(item.description));
 for(const scores of [[.92,.01],[.01,.92],[.92,.91]]){
   const calls=[];const result=await scoreSearchListing(item,'meat','deberta',async(condition,text)=>{
     calls.push({condition,text});return {score:scores[calls.length-1],cached:true};
   });
   assert.deepEqual(calls,inputs);assert.equal(result.score,Math.sqrt(scores[0]*scores[1]));assert(result.cached);
 }
 const wanted={title:'Family box',side:'request',category:'Meat',tags:[],description:'Pasture-raised beef.'};
 assert.deepEqual(listingSearchEvidence(wanted,'meat').map(p=>p.condition),['The item being requested is meat.','This listing requests meat.']);
 assert(listingSearchEvidence(wanted,'meat').every(p=>p.text.startsWith('Item wanted:')));
 const bounded=listingSearchEvidence({...item,description:'x'.repeat(5000),tags:Array(30).fill('y'.repeat(200))},'meat');
 assert(bounded.every(p=>p.text.length<=2000));
 assert.deepEqual(listingSearchEvidence(item,'blue pen')[0].text,listingSearchText(item));
 assert.equal(listingSearchEvidence(item,'pen','browser').length,1);
});

test('only DeBERTa compound queries use the evaluated concrete proposition; topics and other backends retain their templates',()=>{
  for(const query of ['fresh apples','human edible products','red bicycle','waterproof hiking jacket','USB-C laptop charger','I want a repair service under 50 EUR in Helsinki, please?']){
    assert.equal(searchCondition(query,'deberta'),`This listing offers ${query}.`);
    for(const model of ['browser','qwen35'])assert.equal(searchCondition(query,model),`This listing matches this search: ${query}`);
  }
  for(const query of ['apples','food','huonekalu','USB-C'])for(const model of ['deberta','browser','qwen35'])assert.equal(searchCondition(query,model),model==='deberta'?`The item being offered is ${query}.`:`This text is about ${query}.`);
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

test('skip a topic detail only when its best possible score is below every selectable cutoff',async()=>{
  const run=async(first,second,minimum=.1,query='meat')=>{
    let calls=0;
    const result=await scoreSearchListing({title:'Example'},query,'deberta',async()=>({score:++calls===1?first:second,cached:true}),undefined,minimum);
    return {...result,calls};
  };
  assert.deepEqual(await run(.009,1),{score:null,cached:true,calls:1});
  assert.deepEqual(await run(.01,1),{score:.1,cached:true,calls:2});
  assert.deepEqual(await run(.04,1),{score:.2,cached:true,calls:2});
  assert.deepEqual(await run(.009,.5,0),{score:Math.sqrt(.009*.5),cached:true,calls:2});
  assert.deepEqual(await run(.009,.5,.1,'fresh meat'),{score:.009,cached:true,calls:1});
  await assert.rejects(run(-1,1),/invalid decision/);
});
