import test from 'node:test';
import assert from 'node:assert/strict';
import {filterOrders,orderTotals,ordersCsv} from '../src/orders-view/summary.ts';

const me='a'.repeat(64),you='b'.repeat(64),now=Date.UTC(2026,10,16)/1000;
const order=(id,{status='delivered',days=1,price='20',currency='EUR',quantity=1,seller=me,title='Mittens'}={})=>({id:`${you}:${id}`,buyer:seller===me?you:me,seller,status,createdAt:now-days*86400,items:[{id:`${seller}:item`,title,price,currency,quantity,eventId:'c'.repeat(64)}]});

test('history filters by period and status',()=>{
  const orders=[order('1'),order('2',{status:'cancelled',days:40}),order('3',{status:'accepted',days:400})];
  assert.deepEqual(filterOrders(orders,{period:'30d',now}).map(o=>o.id.slice(65)),['1']);
  assert.deepEqual(filterOrders(orders,{status:'open',now}).map(o=>o.id.slice(65)),['3']);
  assert.deepEqual(filterOrders(orders,{period:'last-year',now}).map(o=>o.id.slice(65)),['3']);
  assert.equal(filterOrders(orders,{now}).length,3);
});

test('totals stay per currency and leave out cancelled and negotiable orders',()=>{
  const totals=orderTotals([order('1',{quantity:2}),order('2',{status:'cancelled'}),order('3',{price:'2000',currency:'SATS'}),order('4',{price:''})]);
  assert.deepEqual(totals,[{currency:'EUR',amount:40},{currency:'SATS',amount:2000}]);
});

test('CSV export is spreadsheet-safe and names the listing revision',()=>{
  const csv=ordersCsv([order('1',{title:'=HYPERLINK("x")',quantity:3}),order('2',{seller:you,title:'Pie, blueberry'})],me,key=>key===you?'Helmi':'');
  const lines=csv.trim().split('\r\n');
  assert.equal(lines.length,3);assert.match(lines[0],/^Date,Order,Type,Item/);
  assert.match(lines[1],/,Sale,"'=HYPERLINK\(""x""\)",3,20,EUR,60,delivered,Helmi,npub1/);
  assert.match(lines[2],/,Purchase,"Pie, blueberry",/);assert.ok(lines[1].endsWith(','+'c'.repeat(64)));
});
