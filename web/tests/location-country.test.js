import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {countryForCoordinates, createCountryLookup, COUNTRY_BOUNDARY_GUARD_METERS} from '../src/location-country.ts';
import {COUNTRY_CODES} from '../src/shipping.ts';

const square = (west, south, east, north) => [[west,south],[east,south],[east,north],[west,north],[west,south]];
const lookup = countries => createCountryLookup({version:1,countries});

test('bundled countries resolve interiors and separate overseas shipping destinations', async () => {
  const cases = [
    [[24.9384,60.1699],'FI'], [[23.761,61.499],'FI'], [[13.405,52.52],'DE'],
    [[2.35,48.86],'FR'], [[-.1276,51.5072],'GB'], [[139.76,35.68],'JP'],
    [[151.21,-33.87],'AU'], [[174.76,-36.85],'NZ'], [[-53.1,4],'GF'],
    [[55.5,-21.1],'RE'], [[57.55,-20.3],'MU'], [[14.43,35.9],'MT'],
    [[103.82,1.35],'SG'], [[-157.86,21.31],'US'], [[-40,72],'GL'],
    [[16,78.2],'SJ'], [[20,60.2],'AX'],
  ];
  for (const [point,expected] of cases) assert.equal(await countryForCoordinates(point),expected,`${point}`);
});

test('holes keep an enclave separate from its surrounding country', async () => {
  const find = lookup([['ZA',[[square(0,0,10,10),square(3,3,7,7)]]],['LS',[[square(3,3,7,7)]]]]);
  assert.equal(find([1,1]),'ZA');
  assert.equal(find([5,5]),'LS');
  assert.equal(find([3,5]),null);
  assert.equal(lookup([['ZA',[[square(0,0,10,10),square(3,3,7,7)]]]])([5,5]),null);
  assert.equal(await countryForCoordinates([28.2,-29.6]),'LS');
  assert.equal(await countryForCoordinates([27,-30]),'ZA');
});

test('date-line polygons and holes work on either longitude spelling without covering Greenwich', () => {
  const find = lookup([['FJ',[[square(170,-20,-170,0),square(178,-12,-178,-8)]]]]);
  for (const point of [[175,-5],[-175,-5],[180,-5],[-180,-5]]) assert.equal(find(point),'FJ');
  for (const point of [[0,-5],[180,-10],[-179,-10],[170,-5]]) assert.equal(find(point),null);
});

test('multiple islands with the same code are allowed, overlapping different countries are unknown', () => {
  const find = lookup([['FI',[[square(0,0,5,5)],[square(10,0,15,5)]]],['FI',[[square(1,1,4,4)]]]]);
  assert.equal(find([2,2]),'FI');assert.equal(find([12,2]),'FI');assert.equal(find([7,2]),null);
  assert.equal(lookup([['FI',[[square(0,0,5,5)]]],['SE',[[square(1,1,4,4)]]]])([2,2]),null);
  assert.equal(lookup([['FI',[[square(0,0,5,5)]]],[null,[[square(1,1,4,4)]]]])([2,2]),null);
});

test('border guard includes geolocation uncertainty and never snaps offshore points to land', () => {
  const find = lookup([['FI',[[square(0,0,5,5)]]]]);
  assert.equal(COUNTRY_BOUNDARY_GUARD_METERS,250);
  for (const point of [[0,2],[5,2],[2,0],[2,5],[0,0],[.001,2],[-.001,2]]) assert.equal(find(point),null);
  assert.equal(find([.01,2]),'FI');
  assert.equal(find([.01,2],{accuracyMeters:1000}),null);
  assert.equal(find([2,2],{accuracyMeters:1000}),'FI');
  assert.equal(find([10,2]),null);
});

test('invalid coordinates, uncertainty, open ocean and unsupported regions fail gracefully', async () => {
  for (const value of [null,undefined,[],[1],[1,2,3],['1',2],[NaN,0],[0,Infinity],[181,0],[0,91],[0,90]]) assert.equal(await countryForCoordinates(value),null);
  for (const accuracyMeters of [-1,NaN,Infinity,100001]) assert.equal(await countryForCoordinates([24.9384,60.1699],{accuracyMeters}),null);
  for (const value of [[0,0],[-140,0],[44.06,9.56],[21.16,42.66]]) assert.equal(await countryForCoordinates(value),null);
});

test('bundled source is pinned, bounded and retains closed rings and supported ISO codes', async () => {
  const raw = await readFile(new URL('../src/location-country-data.json',import.meta.url));
  assert(raw.length<2_000_000);
  assert.equal(createHash('sha256').update(raw).digest('hex'),'07ad2d9dfe315c2a1d00a93c59994966593ec1bda80de475104a1bd10a078c5b');
  const data=JSON.parse(raw),codes=new Set(COUNTRY_CODES);
  assert.equal(data.sourceCommit,'9380cca83db5f9aef52d5e762765100745f84b27');
  assert.equal(data.sourceSha256,'b8d421aca6e9e08e8cdf09cc26af111cc3e0deba4fe915611d58ade71e8a4db0');
  let vertices=0,rings=0,polygons=0;
  for (const [code,shapes] of data.countries) {
    assert(code===null||codes.has(code));
    for (const shape of shapes) {
      polygons++;assert(shape.length>0);
      for (const ring of shape) {
        rings++;vertices+=ring.length;assert(ring.length>=4);assert.deepEqual(ring[0],ring.at(-1));
        for (const [x,y] of ring) assert(Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x)<=180&&Math.abs(y)<=90);
      }
    }
  }
  assert.equal(data.countries.length,265);assert.equal(polygons,1628);assert.equal(rings,1641);assert.equal(vertices,100218);
});
