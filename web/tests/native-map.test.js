import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanShipmentProjection, createNativeMapController } from '../src/native-map.ts';

const route = () => ({ stops: [
  { id: 'pickup', label: 'Pickup', address: 'Shop', coordinates: [24.94, 60.17], status: 'completed' },
  { id: 'dropoff', label: 'Delivery', coordinates: [25, 60.2], status: 'pending' },
], location: { coordinates: [24.97, 60.18], at: 1000 } });
function renderer() {
  const calls = [];
  return { calls, setShipment(value) { calls.push(['shipment', structuredClone(value)]); }, setListings(value) { calls.push(['listings', structuredClone(value)]); }, async setDark(value) { calls.push(['dark', value]); }, async destroy() { calls.push(['destroy']); } };
}

test('native route accepts only bounded presentation fields and copies coordinates', () => {
  const value = route(), clean = cleanShipmentProjection(value, 1000);
  assert.equal(clean.stops.length, 2);
  assert.equal(clean.stops[1].address, '');
  assert.deepEqual(clean.location.coordinates, [24.97, 60.18]);
  value.stops[0].coordinates[0] = 0; value.location.coordinates[0] = 0;
  assert.equal(clean.stops[0].coordinates[0], 24.94);
  assert.equal(clean.location.coordinates[0], 24.97);
  assert.deepEqual(cleanShipmentProjection({ stops: [] }, 1000), { stops: [] });
});

test('native route rejects identities, bearer data and unrelated order fields instead of forwarding them', () => {
  for (const key of ['buyer', 'seller', 'token', 'items', 'routeId']) {
    assert.throws(() => cleanShipmentProjection({ ...route(), [key]: 'private' }, 1000), /invalid/);
  }
  for (const key of ['courierPubkey', 'token', 'owner']) {
    const value = route(); value.stops[0][key] = 'private';
    assert.throws(() => cleanShipmentProjection(value, 1000), /invalid/);
  }
  const value = route(); value.location.courierPubkey = 'private';
  assert.throws(() => cleanShipmentProjection(value, 1000), /invalid/);
});

test('malformed, excessive or duplicate stops fail the projection as a whole', () => {
  const cases = [null, [], {}, {stops: null}, {stops: Array.from({length:13}, (_, i) => ({id:String(i)}))}, {stops:[{id:'a'},{id:'a'}]}, {stops:[{id:''}]}, {stops:[{id:'x'.repeat(81)}]}, {stops:[{id:'a',label:'x'.repeat(121)}]}, {stops:[{id:'a',address:'x'.repeat(501)}]}, {stops:[{id:'a',status:{toString:()=> 'pending'}}]}];
  for (const point of [[181,0],[0,91],[NaN,0],[Infinity,0],['24',60],[1,2,3],null]) cases.push({stops:[{id:'a',coordinates:point}]});
  for (const value of cases) assert.throws(() => cleanShipmentProjection(value, 1000), /invalid/);
});

test('native positions use Unix seconds and expired/future samples never appear', () => {
  for (const at of [-1, 1000.5, NaN, Infinity, '1000']) assert.throws(() => cleanShipmentProjection({stops:[],location:{coordinates:[0,0],at}},1000), /invalid/);
  for (const [at, now, shown] of [[1000,1000,true],[1000,1119.9,true],[1000,1120,false],[1001,1000,false]]) {
    const clean=cleanShipmentProjection({stops:[],location:{coordinates:[0,0],at}},now);
    assert.equal(Boolean(clean.location),shown);
  }
});

test('shipment controller buffers only latest projection and exposes no public listing input', async () => {
  const control=createNativeMapController({shipmentMode:true,now:()=>1000}), map=renderer();
  assert.equal(control.api.setListings,undefined);
  assert.equal(control.api.setShipment(route()),true);
  const updated=route(); updated.stops[1].label='Latest stop';control.api.setShipment(updated);
  control.api.setDark(true);
  await control.attach(map);
  assert.equal(map.calls[0][0],'shipment');assert.equal(map.calls[0][1].stops[1].label,'Latest stop');
  assert.deepEqual(map.calls[1],['dark',true]);assert(!map.calls.some(call=>call[0]==='listings'));
  await control.close();
});

test('invalid bridge input clears private route and reports a generic non-sensitive error', async () => {
  const errors=[], control=createNativeMapController({shipmentMode:true,now:()=>1000,onError:error=>errors.push(error.message)}), map=renderer();
  await control.attach(map);control.api.setShipment(route());
  assert.equal(control.api.setShipment({...route(),token:'sensitive-bearer'}),false);
  assert.deepEqual(map.calls.at(-1),['shipment',{stops:[]}]);
  assert.deepEqual(errors,['Delivery map data is invalid.']);
  await control.close();
});

test('closing forgets route and rejects late updates or late renderer initialization', async () => {
  const control=createNativeMapController({shipmentMode:true,now:()=>1000}), map=renderer();
  await control.attach(map);control.api.setShipment(route());await control.close();
  assert.deepEqual(map.calls.slice(-2),[['shipment',{stops:[]}],['destroy']]);
  const count=map.calls.length;assert.equal(control.api.setShipment(route()),false);control.api.setDark(true);assert.equal(map.calls.length,count);
  const late=renderer();await control.attach(late);assert.deepEqual(late.calls,[['destroy']]);
});

test('listing mode remains separate and preserves valid marker interaction data', async () => {
  const control=createNativeMapController(), map=renderer();
  assert.equal(control.api.setShipment,undefined);
  control.api.setListings([{id:'listing',title:'Chair',coordinates:[24,60],author:'not-forwarded'}]);
  await control.attach(map);
  assert.deepEqual(map.calls[0],['listings',[{id:'listing',title:'Chair',coordinates:[24,60]}]]);
  assert(!map.calls.some(call=>call[0]==='shipment'));await control.close();
});
