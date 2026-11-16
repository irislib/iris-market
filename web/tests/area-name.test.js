import test from 'node:test';
import assert from 'node:assert/strict';
import {areaName} from '../src/places/area-name.ts';
import {decodeGeohash,encodeLocationHash} from '../src/map/geohash.ts';

test('a public area is named after its largest town, never a country, and open sea has no name',()=>{
  assert.equal(areaName(decodeGeohash('ud9w').bounds),'Helsinki');
  assert.equal(areaName(decodeGeohash(encodeLocationHash(-30,30,4)).bounds),null);
  assert.notEqual(areaName(decodeGeohash(encodeLocationHash(26,64,4)).bounds),'Finland');
});
