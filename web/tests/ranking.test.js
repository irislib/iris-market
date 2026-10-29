import test from 'node:test';
import assert from 'node:assert/strict';
import { rankListings } from '../src/ranking.ts';
const now = 10000000;
const item = (id, author = id, extra = {}) => ({ id, author, title: 'Bicycle', category: 'Transport', createdAt: now, ...extra });
test('verified relationships help discovery without removing unknown authors', () => {
  const listings = [item('new'), item('friend', 'known', { createdAt: now - 86400 })];
  const ranked = rankListings(listings, { now, relationFor: key => key === 'known' ? { distance: 1, knownFollowerCount: 1 } : null });
  assert.deepEqual(ranked.map(x => x.id), ['friend', 'new']);
  assert.deepEqual(listings.map(x => x.id), ['new', 'friend']);
});
test('a large catalogue cannot occupy all first positions when other authors exist', () => {
  const listings = [...Array.from({ length: 20 }, (_, i) => item(`a${i}`, 'catalogue')), item('other1'), item('other2')];
  const first = rankListings(listings, { now }).slice(0, 3);
  assert.equal(new Set(first.map(x => x.author)).size, 3);
});
test('freshness and saved category interests help and are deterministic', () => {
  const listings = [item('old', 'old', { createdAt: now - 60 * 86400 }), item('fresh'), item('saved', 'saved', { category: 'Home' }), item('chair', 'chair', { category: 'Home' })];
  const ranked = rankListings(listings, { now, saved: new Set(['saved']) });
  assert.ok(ranked.findIndex(x => x.id === 'chair') < ranked.findIndex(x => x.id === 'fresh'));
  assert.ok(ranked.findIndex(x => x.id === 'fresh') < ranked.findIndex(x => x.id === 'old'));
  assert.deepEqual(ranked, rankListings([...listings].reverse(), { now, saved: new Set(['saved']) }));
});
test('prices and offer/request side do not buy rank; title relevance can help', () => {
  const listings = [item('a', 'a', { title: 'Table', price: '999999', side: 'offer' }), item('b', 'b', { title: 'Bicycle repair', price: '0', side: 'request' })];
  assert.equal(rankListings(listings, { now, query: 'bicycle' })[0].id, 'b');
  assert.deepEqual(rankListings(listings, { now }).map(x => x.id), rankListings(listings.map(x => ({ ...x, price: '1', side: 'offer' })), { now }).map(x => x.id));
});

test('strong query relevance outweighs friendship, freshness and saved category bias',()=>{
  const listings=[item('friend','known',{title:'Dining table',category:'Home'}),item('desk','stranger',{title:'Oak desk',category:'Furniture',createdAt:now-90*86400})];
  const options={now,query:'oak desk',saved:new Set(['friend']),relationFor:key=>key==='known'?{distance:1,knownFollowerCount:999}:null};
  assert.equal(rankListings(listings,options)[0].id,'desk');
  assert.equal(rankListings(listings,{...options,sort:'social'})[0].id,'friend','Social is an explicit alternative ordering');
});

test('current AI scores order semantic matches and outweigh unrelated familiar sellers',()=>{
  const listings=[item('friend','known',{title:'Bicycle magazine'}),item('repair','new',{title:'Wheel truing and brake adjustment'})];
  const ranked=rankListings(listings,{now,query:'bicycle repair',relationFor:key=>key==='known'?{distance:1,knownFollowerCount:99}:null,aiScoreFor:row=>row.id==='repair'?.98:.1});
  assert.equal(ranked[0].id,'repair');
  const ordinary=rankListings(listings,{now,query:'bicycle'});
  for(const invalid of [undefined,null,NaN,Infinity,-1,2])assert.deepEqual(rankListings(listings,{now,query:'bicycle',aiScoreFor:()=>invalid}),ordinary);
  assert.deepEqual(rankListings(listings,{now,query:'bicycle',aiScoreFor:()=>{throw Error('Unavailable')}}),ordinary);
});

test('known nearby coordinates can help; unknown and far locations remain neutral',()=>{
  const listings=[item('a-unknown'),item('b-far','b',{coordinates:[-74,40.7]}),item('c-near','c',{coordinates:[24.94,60.17]})];
  assert.deepEqual(rankListings(listings,{now,location:[24.94,60.17]}).map(row=>row.id),['c-near','a-unknown','b-far']);
  assert.deepEqual(rankListings(listings,{now}).map(row=>row.id),['a-unknown','b-far','c-near']);
  assert.deepEqual(rankListings(listings,{now,location:[NaN,60]}),rankListings(listings,{now}));
});

test('coarse geohash cells do not pretend to establish a precise nearby address',()=>{
  const listings=[item('a-unknown'),item('b-world','b',{coordinates:[0,0],locationBounds:[-180,-90,180,90]}),item('c-local','c',{coordinates:[24.94,60.17],locationBounds:[24.93,60.16,24.95,60.18]})];
  assert.deepEqual(rankListings(listings,{now,location:[24.94,60.17]}).map(row=>row.id),['c-local','a-unknown','b-world']);
});

test('newest is chronological, deterministic and independent of context callbacks',()=>{
  const listings=[item('older','friend',{createdAt:now-100}),item('b'),item('a')];
  const ranked=rankListings(listings,{sort:'newest',query:'older',relationFor:()=>{throw Error('must not query graph')},aiScoreFor:()=>{throw Error('must not infer')}});
  assert.deepEqual(ranked.map(row=>row.id),['a','b','older']);assert.equal(listings[0].id,'older');
});

test('seller diversity is bounded so relevant inventory is not buried beneath unrelated products',()=>{
  const listings=[...Array.from({length:30},(_,i)=>item('desk-'+i,'catalogue',{title:'Oak desk'})),item('table','friend',{title:'Dining table'})];
  let graphReads=0;const ranked=rankListings(listings,{now,query:'oak desk',relationFor:author=>{graphReads++;return author==='friend'?{distance:1}:null}});
  assert.equal(ranked.at(-1).id,'table');assert.equal(graphReads,2,'each author relation is read once');assert.equal(new Set(ranked.map(row=>row.id)).size,listings.length);
});

import {ListingWindow} from '../src/listing-grid.ts';
test('bookmarking keeps the current Browse page stable when saved interests change ranking',()=>{
 const listings=Array.from({length:60},(_,i)=>item(String(i).padStart(2,'0'),'author-'+i,{category:i===20?'Home':'Tech',createdAt:now-i*100}));
 const saved=new Set(),view=new ListingWindow(24),before=view.update(rankListings(listings,{saved,now}),'browse');
 assert.equal(before[20].id,'20');view.pin();saved.add('20');
 const ranked=rankListings(listings,{saved,now});assert.equal(ranked[0].id,'20');
 assert.deepEqual(view.update(ranked,'browse').map(x=>x.id),before.map(x=>x.id));
 assert.equal(view.update(listings.filter(x=>saved.has(x.id)),'saved')[0].id,'20');
});
test('unsaving from Saved removes that item while keeping surviving saved items in place',()=>{
 const listings=[item('a'),item('b'),item('c')],saved=new Set(['a','b','c']),view=new ListingWindow(24);
 view.update(listings,'saved');view.pin();saved.delete('b');
 assert.deepEqual(view.update(listings.filter(x=>saved.has(x.id)),'saved').map(x=>x.id),['a','c']);
 assert.equal(listings.length,3);
});
