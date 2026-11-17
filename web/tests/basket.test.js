import test from 'node:test';
import assert from 'node:assert/strict';
import {createBasket} from '../src/basket.ts';

test('the basket groups listings by seller per profile and stays local',()=>{
  const rows=new Map(),storage={getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)};
  let owner='me';const basket=createBasket(storage,()=>owner);
  const a={id:'s1:pie',author:'s1',title:'Pie',price:'20',currency:'EUR',side:'offer'},b={id:'s1:jam',author:'s1',title:'Jam',price:'5',currency:'EUR',side:'offer'},c={id:'s2:hat',author:'s2',title:'Hat',price:'9',currency:'EUR',side:'offer'};
  a.category='transport';a.escrow={trade:'goods'};
  basket.add(a);basket.add(a);basket.add(b);basket.add(c);
  assert.deepEqual(basket.groups().map(g=>[g.seller,g.items.map(i=>[i.listing.title,i.quantity])]),[['s1',[['Pie',2],['Jam',1]]],['s2',[['Hat',1]]]]);
  assert.equal(basket.items()[0].listing.category,'transport');assert.deepEqual(basket.items()[0].listing.escrow,{trade:'goods'});
  basket.setQuantity('s1:pie',0);assert.equal(basket.count(),2);
  basket.consume([{id:b.id,quantity:1}],owner);assert.deepEqual(basket.groups().map(g=>g.seller),['s2']);
  owner='other';assert.equal(basket.count(),0,'another profile has its own basket');
});
