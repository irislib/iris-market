import test from 'node:test';
import assert from 'node:assert/strict';
import {npubEncode,naddrEncode} from 'nostr-tools/nip19';
import {parseMarketRoute,listingURL,profileURL,pageURL,listingAddress} from '../src/routes.ts';
import {routeBase} from '../src/route-base.ts';
const key='12'.repeat(32),npub=npubEncode(key),id=key+':oak-desk';
test('public listing addresses are stable author and d-tag routes',()=>{
 const url=listingURL(id,'https://market.iris.to/?profile=other#private');
 assert.equal(url,`https://market.iris.to/${npub}/oak-desk`);
 assert.deepEqual(parseMarketRoute(url),{type:'listing',id});
 assert.equal(routeBase(url).href,'https://market.iris.to/');
 assert.deepEqual(parseMarketRoute(`https://market.iris.to/${listingAddress(id)}`),{type:'listing',id});
 for(const name of ['a/b + % ? #','..','.','木の机'])assert.deepEqual(parseMarketRoute(listingURL(`${key}:${name}`,'https://market.iris.to/')),{type:'listing',id:`${key}:${name}`});
});
test('profiles and main sections cold-load independently',()=>{
 assert.equal(profileURL(key,'https://market.iris.to/'+npub+'/old'),`https://market.iris.to/${npub}`);
 assert.deepEqual(parseMarketRoute(profileURL(key,'https://market.iris.to/')),{type:'profile',pubkey:key});
 for(const name of ['saved','post','wallet','settings','orders','messages']){
  const url=pageURL(name,'https://market.iris.to/'+npub+'/old');assert.equal(url,`https://market.iris.to/${name}`);assert.equal(parseMarketRoute(url).type,name);assert.equal(routeBase(url).href,'https://market.iris.to/');
 }
 assert.deepEqual(parseMarketRoute(`https://market.iris.to/messages/${npub}`),{type:'messages',pubkey:key});
});
test('static directory links preserve mount and do not leak query or invitation fragments',()=>{
 const base='https://gateway.example/htree/owner/market/';
 for(const href of [base,base+'index.html?invite=1#capability']){
  const listing=listingURL(id,href),profile=profileURL(key,href);
  assert.equal(new URL(listing).pathname,new URL(base).pathname);assert.equal(new URL(listing).searchParams.size,1);assert.equal(new URL(listing).hash,'');
  assert.deepEqual(parseMarketRoute(listing),{type:'listing',id});assert.deepEqual(parseMarketRoute(profile),{type:'profile',pubkey:key});
  assert.deepEqual(parseMarketRoute(pageURL('post',href)),{type:'post'});
 }
});
test('legacy links resolve and unrelated or secret identifiers do not',()=>{
 assert.deepEqual(parseMarketRoute(`https://market.iris.to/?listing=${id}`),{type:'listing',id});
 for(const href of ['https://market.iris.to/?listing=bad','https://market.iris.to/?profile=nsec1bad',`https://market.iris.to/${naddrEncode({pubkey:key,kind:30023,identifier:'article'})}`])assert.equal(parseMarketRoute(href).type,'missing');
});
