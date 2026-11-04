import test from 'node:test';
import {canNotifySeller} from '../src/merchant-notice-ui.ts';
import assert from 'node:assert/strict';
import {generateSecretKey,getPublicKey,verifyEvent,finalizeEvent} from 'nostr-tools';
import {unwrapEvent} from 'nostr-tools/nip17';
import {AppKeys, Invite} from 'nostr-double-ratchet';
import {merchantNotices,noticeDestinations,noticeMessage,noticeEnvelope} from '../src/messaging/merchant-notice.ts';

const seller=generateSecretKey(), key=getPublicKey(seller), now=Math.floor(Date.now()/1000);
const inbox=(tags,at=now,signer=seller)=>finalizeEvent({kind:10050,tags,created_at:at,content:''},signer);
const address='wss://inbox.example/';
const advertised=inbox([['relay',address]]);
const local=['wss://market.example/'];
const roster=finalizeEvent(new AppKeys([{identityPubkey:getPublicKey(generateSecretKey()),createdAt:now}]).getEvent({ownerPubkey:key,createdAt:now}),seller);

test('only the merchant can open the fixed message, and each notice has independent sender and wrapper keys',()=>{
  const wraps=[noticeEnvelope(key),noticeEnvelope(key)];
  const identities=new Set();
  for(const e of wraps){
    assert.equal(e.kind,1059);assert.ok(verifyEvent(e));assert.deepEqual(e.tags,[['p',key]]);
    assert.ok(!e.content.includes('market.iris.to'));
    assert.throws(()=>unwrapEvent(e,generateSecretKey()));
    const rumor=unwrapEvent(e,seller);
    assert.equal(rumor.kind,14);assert.equal(rumor.content,noticeMessage);
    assert.deepEqual(rumor.tags,[['p',key]]);assert.equal(rumor.sig,undefined);
    identities.add(rumor.pubkey);identities.add(e.pubkey);
  }
  assert.equal(identities.size,4);
});

test('only current signed inbox relays count; active rosters and legacy invites suppress the fallback',()=>{
  const withdrawn=inbox([],now+1);
  assert.deepEqual(noticeDestinations(key,[advertised,withdrawn],local),[]);
  assert.deepEqual(noticeDestinations(key,[advertised,inbox([['relay','wss://other.example']],now+2,generateSecretKey())],local),[address]);
  assert.deepEqual(noticeDestinations(key,[inbox([['relay','ws://localhost:1234'],['relay','wss://x:y@inbox.example'],['relay','https://example.org']])],local),[]);
  assert.equal(noticeDestinations(key,[roster,advertised],local),null);
  const invite=Invite.createNew(key,key);
  assert.equal(noticeDestinations(key,[finalizeEvent(invite.getEvent(),seller),advertised],local),null);
});

function fixture(){
  let stored,records=[advertised],accept=false,complete=true;
  const sent=[],queries=[];
  const backend={async read(){return structuredClone(stored);},async write(row,version){assert.equal(version,stored?.version??0);stored=structuredClone(row);}};
  const transport={async query(filters,options){queries.push(options.relays);assert.deepEqual(filters,[{kinds:[37368,30078,10050],authors:[key],limit:1024}]);return {events:records,complete,sources:[{complete}]};},
    async publish(event,options){sent.push({event,relays:options.relays});return {remoteAccepted:accept};}};
  const app=()=>merchantNotices({getRelays:()=>local,transport,backend});
  return {sent,queries,app,records(value){records=value;},accept(){accept=true;},incomplete(){complete=false;}};
}
test('viewing sends nothing; retries after reopening publish identical ciphertext only to the advertised inbox',async()=>{
  const f=fixture(),first=f.app();
  assert.equal(await first.status(key),'available');assert.equal(f.sent.length,0);
  assert.equal(await first.queue(key),'queued');await first.flush();
  assert.equal(await first.queue(key),'queued');
  const reopened=f.app();assert.equal(await reopened.status(key),'queued');
  f.accept();await reopened.flush();
  assert.equal(await reopened.status(key),'sent');assert.equal(await reopened.queue(key),'sent');
  assert.equal(f.sent.length,2);assert.equal(f.sent[0].event.id,f.sent[1].event.id);
  assert.deepEqual(f.sent.map(p=>p.relays),[[address],[address]]);
  assert.equal(unwrapEvent(f.sent[1].event,seller).content,noticeMessage);
});
test('no inbox, inconclusive discovery, and a newly enabled device never trigger fallback publication',async()=>{
  const f=fixture(),app=f.app();
  f.records([]);assert.equal(await app.status(key),'no-inbox');
  f.records([advertised]);f.incomplete();await assert.rejects(app.status(key));assert.equal(f.sent.length,0);
  const next=fixture(),other=next.app();
  await other.queue(key);await other.flush();const tried=next.sent.length;
  next.records([advertised,roster]);await other.flush();assert.equal(await other.status(key),'unavailable');
  assert.equal(next.sent.length,tried);
});

test('the button is limited to a current third-party signed offer',()=>{
  const live={author:key,side:'offer',status:'active',rawEvent:{pubkey:key}};
  assert.ok(canNotifySeller(live,false));
  for(const extra of [{side:'request'},{status:'sold'},{externalOrder:{}},{expiration:now},{rawEvent:undefined},{rawEvent:{pubkey:'wrong'}}])
    assert.equal(canNotifySeller({...live,...extra},false),false);
  assert.equal(canNotifySeller(live,true),false);
  assert.equal(canNotifySeller(live,false,key),false);
});
