import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent, generateSecretKey} from 'nostr-tools/pure';
import {listingDraft, revisedListingDraft, closedBitcoinDraft} from '../src/composer.ts';
import {parseEvent, applyEvent, visibleListings, MarketRelayClient} from '../src/market.ts';
import {fiatQuoteLabel} from '../src/escrow-offer.ts';
import {parseMarketRoute, listingURL} from '../src/routes.ts';
import {createPublicListingCache} from '../src/offline-listings.ts';

const now=Math.floor(Date.now()/1000),key=generateSecretKey();
const values={side:'offer',title:'Bitcoin for euros',description:'Fixed amount',price:'61.15',currency:'EUR',category:'other',
  expiration:'1w',escrow:{trade:'bitcoin_fiat',sats:62000,method:'bank_transfer'}};
const signed=(fields=values,id='same:id',at=now-160)=>finalizeEvent(listingDraft(fields,{identifier:id,createdAt:at}),key);
test('both bitcoin sides and ordinary classifieds retain distinct coordinates through edit, links, close and offline replay',async()=>{
  const records=new Map(), events=new Map();
  const backend={read:async()=>[...events.values()],write:async(batch)=>{for(const e of batch)events.set(parseEvent(e).id,e);}};
  const offline=()=>createPublicListingCache({backend,validate:parseEvent,storage:null});
  const cache=offline(),goods=signed({...values,escrow:undefined}),btc=signed();
  for(const event of [goods,btc]){applyEvent(records,event);cache.save(event);}
  const listing=parseEvent(btc);
  assert.match(fiatQuoteLabel('61.15','CAD','en-US'),/CAD\s*61\.15/);
  assert.equal(btc.kind,38383);assert.equal(listing.price,'61.15');
  assert.equal(records.size,2);assert.notEqual(listing.id,parseEvent(goods).id);
  for(const base of ['https://example.com/','https://example.com/market/']){
    assert.deepEqual(parseMarketRoute(listingURL(listing.id,base)),{type:'listing',id:listing.id});
  }
  const edited=finalizeEvent(revisedListingDraft({...values,side:'request',escrow:undefined,price:'65',expiration:'keep'},listing),key);
  assert.equal(edited.kind,38383);
  const next=parseEvent(edited);
  assert.deepEqual([next.id,next.side,next.price,next.expiration],[listing.id,'request','65',listing.expiration]);
  assert.deepEqual(edited.tags.filter(t=>t[0]==='fa'),[['fa','65']]);
  const tombstone=finalizeEvent(closedBitcoinDraft(next),key);
  assert.equal(parseEvent(tombstone).id,listing.id);
  for(const event of [edited,tombstone,btc]){applyEvent(records,event);cache.save(event);}
  assert.deepEqual(visibleListings(records).map(l=>l.id),[parseEvent(goods).id]);
  await cache.flush();
  assert.deepEqual((await offline().load()).map(e=>e.id).sort(),[tombstone.id,goods.id].sort());
  const outside=finalizeEvent({...btc,tags:btc.tags.map(t=>t[0]==='y'?['y','Mostro']:t)},key);
  assert.throws(()=>parseEvent(outside),/Unsupported bitcoin/);
});
test('live, older and shared bitcoin queries retain platform and independent revision boundaries',async()=>{
  class Socket {
    static all=[];
    constructor(){this.sent=[];Socket.all.push(this);}
    open(){this.readyState=1;this.onopen();}
    send(text){this.sent.push(JSON.parse(text));}
    frame(msg){this.onmessage({data:JSON.stringify(msg)});}
    close(){this.readyState=3;}
  }
  const goods=signed({...values,escrow:undefined},'goods',now-10),btc=signed(values,'btc',now-100),older=signed({...values,side:'request'},'older',now-300);
  const client=new MarketRelayClient({relays:['wss://example.com'],WebSocketImpl:Socket,historyPageSize:10,indexQuery:null,
    targetId:parseEvent(btc).id,authors:[btc.pubkey],tags:['other']}).start();
  try{
    const live=Socket.all[0];live.open();
    const [,sub,...filters]=live.sent[0];
    assert.ok(filters.find(f=>f.kinds[0]===38383&&f['#d']?.includes('btc')&&f['#y']?.includes('iris-market')));
    assert.ok(filters.find(f=>f.kinds[0]===38383&&f['#t']?.includes('other')&&f['#y']?.includes('iris-market')));
    live.frame(['EVENT',sub,goods]);live.frame(['EVENT',sub,btc]);live.frame(['EVENT',sub,signed(values,'another',now-65)]);
    live.frame(['EOSE',sub]);const loading=client.loadOlder();await new Promise(r=>setTimeout(r,0));
    assert.equal(Socket.all.length,3);
    for(const socket of Socket.all.slice(1)){
      socket.open();
      const [,id,filter]=socket.sent[0];
      if(filter.kinds[0]===38383){
        assert.equal(filter.until,now-65);
        assert.deepEqual(filter['#y'],['iris-market']);socket.frame(['EVENT',id,older]);
      }else assert.equal(filter.until,now-10);
      socket.frame(['EOSE',id]);
    }
    const page=await loading;assert.equal(page.error,'');
    assert.equal(client.records.get(parseEvent(older).id).side,'request');
  }finally{client.close();}
});
