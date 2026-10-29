import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes=new Map();this.hidden=false;this.textContent='';this.className='';}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  replaceChildren(...children){this.children=[];this.append(...children);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='[data-person-relationship]'&&'personRelationship'in child.dataset?[child]:[]),...child.querySelectorAll(selector)]);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  click(){return this.onclick?.();}
  focus(){this.focused=true;}
}
const elements=[];
const document={body:new Element('body'),createElement(tag){const element=new Element(tag);elements.push(element);return element;},querySelectorAll(){return [];}};
const window=new EventTarget();
const copied=[];
Object.defineProperties(globalThis,{document:{value:document,configurable:true},window:{value:window,configurable:true},location:{value:new URL('https://market.iris.to/?invite=1#private-capability'),configurable:true},navigator:{value:{clipboard:{writeText:async text=>copied.push(text)}},configurable:true},history:{value:{pushState(){throw Error('Profile component must not navigate history');},replaceState(){throw Error('Profile component must not navigate history');}},configurable:true}});
class SilentSocket {
  constructor(){this.readyState=0;queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}});}
  send(){}
  close(){this.readyState=3;this.onclose?.();}
}
globalThis.WebSocket=SilentSocket;
const {setupProfiles}=await import('../src/profile-ui.ts');
const {cacheProfileMetadata,readProfileMetadata}=await import('../src/profiles.ts');
const {setupPeople}=await import('../src/people.ts');
const {profileURL}=await import('../src/routes.ts');
const {buildReviewDraft}=await import('../src/reviews.ts');
const relays=['wss://profile.test.invalid'];
setupPeople({getRelays:()=>relays,isPreview:()=>true});
const secrets=Array.from({length:6},(_,index)=>new Uint8Array(32).fill(index+1)),keys=secrets.map(getPublicKey);
for(let i=0;i<keys.length;i++)cacheProfileMetadata(finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify({name:['Alice','Bob','Carol','Dave','Eve','Frank'][i],about:'Cached public profile'})},secrets[i]),{relays});
const all=node=>[node,...node.children.flatMap(all)];
const find=(node,text)=>all(node).find(element=>element.textContent===text);

test('profile page renders cached identity and actions before relay replies without a modal or history mutation',async()=>{
  const page=new Element('main');let navigated=0,closed=0,messaged;
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],onNavigate(){navigated++;},onClose(){closed++;},onMessage:key=>{messaged=key;}});
  const pending=profiles.open(keys[0],{navigate:false});
  assert.equal(page.hidden,false);assert.equal(find(page,'Alice').tag,'h1');assert(find(page,'Cached public profile'));
  assert.equal(navigated,0);assert.equal(elements.some(element=>element.tag==='dialog'),false);
  await find(page,'Copy profile link').click();assert.equal(copied.at(-1),profileURL(keys[0],location.href));assert(!copied.at(-1).includes('private-capability'));
  find(page,'Message').click();assert.equal(closed,0);assert.equal(messaged,keys[0]);assert.equal(page.hidden,true);
  await pending;profiles.destroy();
});

test('metadata arrivals update the open identity without waiting for graph replies or remounting listings',async()=>{
  const page=new Element('main');let mounts=0;const card=new Element('article');card.textContent='Existing listing';
  const profiles=setupProfiles({page,getRelays:()=>relays,renderListings(_key,host){mounts++;host.append(card);}});
  const pending=profiles.open(keys[0],{navigate:false});
  cacheProfileMetadata(finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000)+1,tags:[],content:JSON.stringify({name:'Alice arrived'})},secrets[0]),{relays});
  assert(find(page,'Alice arrived'));assert.equal(find(page,'Existing listing'),card);assert.equal(mounts,1);
  profiles.close();
  cacheProfileMetadata(finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000)+2,tags:[],content:JSON.stringify({name:'Alice after close'})},secrets[0]),{relays});
  assert(!find(page,'Alice after close'),'a closed profile unsubscribes from metadata');
  await pending;profiles.destroy();
});

test('inbound followers start only on explicit selection and stale work cannot cross profiles',async()=>{
  const page=new Element('main'),requests=[];
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],loadFollowers:(key,{signal})=>new Promise(resolve=>requests.push({key,signal,resolve}))});
  const first=profiles.open(keys[0],{navigate:false});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,0,'opening a profile cannot crawl inbound follow lists');
  find(page,'Followers').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);
  find(page,'Followers').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1,'repeated clicks share the pending lookup');
  const stale=requests[0],second=profiles.open(keys[1],{navigate:false});await new Promise(resolve=>setImmediate(resolve));assert.equal(stale.signal.aborted,true);
  stale.resolve({items:[],observedCount:0,complete:false,loaded:true,warnings:[]});await new Promise(resolve=>setImmediate(resolve));
  assert(find(page,'Bob'));assert(find(page,'Followers'));assert(!find(page,'Followers 0'));assert.equal(requests.length,1);
  profiles.close();await Promise.all([first,second]);profiles.destroy();
});

test('router navigation callback can reopen silently, and programmatic close does not notify',async()=>{
  const page=new Element('main');let calls=0,closed=0,nested;
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],onNavigate(key){calls++;nested=profiles.open(key,{navigate:false});},onClose(){closed++;}});
  await profiles.open(keys[1]);assert.equal(calls,1);assert(find(page,'Bob'));
  profiles.close();assert.equal(closed,0);assert.equal(page.hidden,true);await nested;
  profiles.destroy();assert.equal(closed,0);assert.equal(page.children.length,0);
});

test('changing profiles cancels stale work and explicit Back notifies once',async()=>{
  const page=new Element('main');let closed=0;
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],onClose(){closed++;}});
  const first=profiles.open(keys[0],{navigate:false});const second=profiles.open(keys[1],{navigate:false});
  assert(find(page,'Bob'));assert(!find(page,'Alice'));
  all(page).find(node=>node.attributes.get('aria-label')==='Back from profile').click();await Promise.all([first,second]);assert.equal(closed,1);assert.equal(page.hidden,true);profiles.destroy();
});

test('profile defaults to listings and owns their lifetime across connection tabs and navigation',async()=>{
  const page=new Element('main'),started=[],stopped=[];
  const profiles=setupProfiles({page,getRelays:()=>relays,isPreview:()=>true,renderListings(key,host){
    started.push(key);const card=new Element('article');card.textContent='Bicycle';host.append(card);return()=>stopped.push(key);
  }});
  await profiles.open(keys[0],{navigate:false});
  const selected=()=>all(page).find(node=>node.attributes.get('aria-selected')==='true');
  assert.equal(selected().textContent,'Listings');assert(find(page,'Bicycle'));
  const identity=all(page).find(node=>node.className==='profile-identity');
  assert(identity.children.some(node=>node.attributes.get('aria-label')==='Back from profile'));
  assert.equal(find(page,'Back'),undefined);assert.deepEqual(started,[keys[0]]);
  find(page,'Following').click();assert.equal(find(page,'Bicycle'),undefined);assert.deepEqual(stopped,[keys[0]]);
  find(page,'Listings').click();assert(find(page,'Bicycle'));assert.deepEqual(started,[keys[0],keys[0]]);
  await profiles.open(keys[1],{navigate:false});assert.equal(selected().textContent,'Listings');
  assert.deepEqual(stopped,[keys[0],keys[0]]);assert.equal(started.at(-1),keys[1]);
  profiles.close();assert.deepEqual(stopped,[keys[0],keys[0],keys[1]]);profiles.destroy();assert.equal(stopped.length,3);
});

test('review summary opens a secondary tab and account refresh preserves the selected listings host',async()=>{
  const page=new Element('main'),started=[],stopped=[];
  const review=finalizeEvent(buildReviewDraft({target:keys[0],author:keys[1],rating:4,body:'Good communication.'}),secrets[1]);
  let pending=[review];
  const profiles=setupProfiles({page,getRelays:()=>relays,isPreview:()=>true,getReviewAccount:()=>({owner:keys[1],canSign:true,pending}),renderListings(key,host){
    started.push(key);host.append(new Element('article'));return()=>stopped.push(key);
  }});
  await profiles.open(keys[0],{navigate:false});assert.equal(all(page).find(node=>node.attributes.get('aria-selected')==='true').textContent,'Listings');
  const host=all(page).find(node=>node.className==='profile-listings');profiles.refreshReviews();assert.equal(started.length,1);assert.equal(stopped.length,0);assert.equal(all(page).find(node=>node.className==='profile-listings'),host);
  find(page,'★ 4.0 · 1 review').click();assert.equal(stopped.length,1);assert(find(page,'Good communication.'));assert.equal(all(page).find(node=>node.attributes.get('aria-selected')==='true').textContent,'Reviews');
  find(page,'Listings').click();assert.equal(started.length,2);profiles.close();assert.equal(stopped.length,2);profiles.destroy();
});

const graphProfile=(target,known=[])=>({profile:readProfileMetadata(target,{relays}),contextPubkey:keys[0],contextLabel:'Alice',relation:{distance:2,badge:'friend',knownFollowers:known,knownFollowerCount:known.length,description:'Loaded connection',partial:true},mutualFollowing:false,followsContext:false,following:{items:[],total:0,truncated:false},followedByKnown:known.map(pubkey=>({pubkey})),coverage:{secondHopLoaded:4,directFollows:10,warnings:[]}});
test('known followers replace Known tab and appear first with a max-three linked identity summary',async()=>{
  const page=new Element('main'),requests=[],known=[keys[2],keys[1],keys[3],keys[4]];
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0],known),loadFollowers:(key,{signal})=>new Promise(resolve=>requests.push({key,signal,resolve}))});
  await profiles.open(keys[0],{navigate:false});
  assert(!all(page).some(node=>node.id==='profile-tab-known'));assert.equal(requests.length,0);
  const summary=all(page).find(node=>node.className==='profile-followed-by');assert(summary);
  assert.deepEqual(summary.children.filter(node=>node.dataset.person).map(node=>node.dataset.person),known.slice(0,3));
  assert(find(summary,'Followed by'));assert(find(summary,'Carol'));assert(find(summary,'Bob'));assert(find(summary,'Dave'));assert(!find(summary,'Eve'));
  assert(!all(summary).some(node=>node.textContent.startsWith('npub')));
  find(summary,'and 1 other').click();assert.equal(requests.length,1);
  let list=all(page).find(node=>node.className==='profile-people');assert.deepEqual(list.children.filter(node=>node.dataset.person).map(node=>node.dataset.person),known);
  requests[0].resolve({items:[{pubkey:keys[5]},{pubkey:keys[1]},{pubkey:keys[4]}],observedCount:3,complete:false,loaded:true,warnings:[]});await new Promise(resolve=>setImmediate(resolve));
  list=all(page).find(node=>node.className==='profile-people');assert.deepEqual(list.children.map(node=>node.dataset.person),[...known,keys[5]]);assert(find(page,'Followers 5'));
  find(page,'Followers 5').click();assert.equal(requests.length,1,'loaded follower pages are reused');
  const currentSummary=all(page).find(node=>node.className==='profile-followed-by');currentSummary.children.find(node=>node.dataset.person===keys[2]).click();assert(find(page,'Carol'),'known names open profiles via the existing person action');profiles.destroy();
});
test('failed inbound lookup retains graph-known followers and retry can exclude superseded signed evidence',async()=>{
  const page=new Element('main');let calls=0;
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0],[keys[1],keys[2]]),loadFollowers:async()=>{calls++;if(calls===1)throw Error('offline');return {items:[{pubkey:keys[3]}],excludedKnownFollowers:[keys[1]],observedCount:1,loaded:true,complete:false,warnings:[]};}});
  await profiles.open(keys[0],{navigate:false});find(page,'Followers 2').click();await new Promise(resolve=>setImmediate(resolve));
  assert(find(page,'Could not load followers.'));assert(find(page,'Followers 2'));assert.equal(all(page).find(node=>node.className==='profile-people').children.length,2);
  find(page,'Try again').click();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(all(page).find(node=>node.className==='profile-people').children.map(node=>node.dataset.person),[keys[2],keys[3]]);assert(find(page,'Followers 2'));
  const summary=all(page).find(node=>node.className==='profile-followed-by');assert.deepEqual(summary.children.filter(node=>node.dataset.person).map(node=>node.dataset.person),[keys[2]]);profiles.destroy();
});
test('unknown follower coverage has no fabricated count or empty followed-by row',async()=>{
  const page=new Element('main');let resolveFollowers;
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0]),loadFollowers:()=>new Promise(resolve=>resolveFollowers=resolve)});
  await profiles.open(keys[0],{navigate:false});assert(!all(page).some(node=>node.className==='profile-followed-by'));assert(find(page,'Followers'));assert(!find(page,'Followers 0'));
  find(page,'Followers').click();resolveFollowers({items:[],observedCount:0,complete:false,loaded:true,warnings:[]});await new Promise(resolve=>setImmediate(resolve));assert(find(page,'Followers 0'));profiles.destroy();
});

test('explicitly superseded second-hop followers clear the current stale badge and follow-distance note',async()=>{
  const page=new Element('main');
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0],[keys[1]]),loadFollowers:async()=>({items:[],excludedKnownFollowers:[keys[1]],observedCount:0,loaded:true,complete:false,warnings:[]})});
  await profiles.open(keys[0],{navigate:false});assert(all(page).some(node=>node.className==='relationship-badge relationship-friend'));
  find(page,'Followers 1').click();await new Promise(resolve=>setImmediate(resolve));
  assert(!all(page).some(node=>node.className==='profile-followed-by'));
  assert(!all(page).some(node=>node.className==='relationship-badge relationship-friend'),'the open identity must not retain a second-hop badge after every known path explicitly unfollows');
  assert(!all(page).some(node=>node.textContent==='Follow distance: 2'&&!node.hidden));profiles.destroy();
});
