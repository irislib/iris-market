import test from 'node:test';
import assert from 'node:assert/strict';
import { rankListings } from '../src/ranking.js';
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

import {ListingWindow} from '../src/listing-grid.js';
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
