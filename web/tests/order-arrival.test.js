import test from 'node:test';
import assert from 'node:assert/strict';
import {orderArrival} from '../src/order-arrival.ts';
const order=(eta,status='accepted')=>({status,shipment:{eta}});
test('arrival countdown uses the supplied estimate and handles minute/hour/day boundaries',()=>{
  for(const [seconds,label] of [[1,'Less than a minute'],[59,'Less than a minute'],[60,'About 1 min'],[61,'About 2 min'],[120,'About 2 min'],[3600,'About 1 hr'],[3660,'About 1 hr 1 min'],[86401,'About 2 days']])assert.equal(orderArrival(order(1000+seconds),1000).headline,label);
  assert.equal(orderArrival(order(1000),1000).headline,'Taking longer than expected');
  assert.equal(orderArrival(order(999),1000).late,true);
});
test('missing, invalid and inactive estimates never imply arrival or start a countdown',()=>{
  for(const eta of [undefined,null,NaN,Infinity,0,-1,1.5,Number.MAX_SAFE_INTEGER])assert.equal(orderArrival(order(eta),1000),null);
  for(const status of ['requested','cancelled','delivered'])assert.equal(orderArrival(order(1120,status),1000),null);
  assert.equal(orderArrival(order(1120,'in-transit'),1000).headline,'About 2 min');
});
