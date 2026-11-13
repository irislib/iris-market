import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {window,settle} from './support/dom.mjs';
import {flushSync} from 'svelte';

window.happyDOM.setURL('https://market.iris.to/?invite=1#private-capability');
const copied=[];
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});
history.pushState=()=>{throw Error('Profile component must not navigate history');};
history.replaceState=()=>{throw Error('Profile component must not navigate history');};
class SilentSocket {
  constructor(){this.readyState=0;queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}});}
  send(){}
  close(){this.readyState=3;this.onclose?.();}
}
globalThis.WebSocket=SilentSocket;
// Assertions follow clicks directly, so apply Svelte's updates synchronously.
const nativeClick=HTMLElement.prototype.click;
HTMLElement.prototype.click=function(){nativeClick.call(this);flushSync();};
const Page=()=>{const page=document.createElement('main');document.body.append(page);return page;};
const Card=text=>{const card=document.createElement('article');if(text)card.textContent=text;return card;};
const {setupProfiles}=await import('../src/profile-ui.ts');
const {cacheProfileMetadata,readProfileMetadata}=await import('../src/profiles.ts');
const {setupPeople}=await import('../src/people.ts');
const {profileURL}=await import('../src/routes.ts');
const {buildReviewDraft}=await import('../src/reviews.ts');
const relays=['wss://profile.test.invalid'];
setupPeople({getRelays:()=>relays,isPreview:()=>true});
const secrets=Array.from({length:6},(_,index)=>new Uint8Array(32).fill(index+1)),keys=secrets.map(getPublicKey);
for(let i=0;i<keys.length;i++)cacheProfileMetadata(finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000),tags:[],content:JSON.stringify({name:['Alice','Bob','Carol','Dave','Eve','Frank'][i],about:'Cached public profile'})},secrets[i]),{relays});
const all=node=>[node,...node.querySelectorAll('*')];
// The innermost element whose whole text matches.
const find=(node,text)=>all(node).filter(element=>element.textContent.trim()===text).at(-1);
const attr=(node,name)=>node.getAttribute(name);
const people=node=>[...node.children].filter(child=>child.dataset.person).map(child=>child.dataset.person);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('profile page renders cached identity and actions before relay replies without a modal or history mutation',async()=>{
  const page=Page();let navigated=0,closed=0,messaged;
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],onNavigate(){navigated++;},onClose(){closed++;},onMessage:key=>{messaged=key;}});
  const pending=profiles.open(keys[0],{navigate:false});
  assert.equal(page.hidden,false);assert.equal(find(page,'Alice').tagName,'H1');assert(find(page,'Cached public profile'));
  assert.equal(navigated,0);assert.equal(document.querySelector('dialog'),null);
  find(page,'Copy profile link').click();await settle();assert.equal(copied.at(-1),profileURL(keys[0],location.href));assert(!copied.at(-1).includes('private-capability'));
  find(page,'Message').click();await settle();assert.equal(closed,0);assert.equal(messaged,keys[0]);assert.equal(page.hidden,true);
  await pending;profiles.destroy();
});

test('metadata arrivals update the open identity without waiting for graph replies or remounting listings',async()=>{
  const page=Page();let mounts=0;const card=Card('Existing listing');
  const profiles=setupProfiles({page,getRelays:()=>relays,renderListings(_key,host){mounts++;host.append(card);}});
  const pending=profiles.open(keys[0],{navigate:false});
  cacheProfileMetadata(finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000)+1,tags:[],content:JSON.stringify({name:'Alice arrived'})},secrets[0]),{relays});
  await settle();assert(find(page,'Alice arrived'));assert.equal(find(page,'Existing listing'),card);assert.equal(mounts,1);
  profiles.close();
  cacheProfileMetadata(finalizeEvent({kind:0,created_at:Math.floor(Date.now()/1000)+2,tags:[],content:JSON.stringify({name:'Alice after close'})},secrets[0]),{relays});
  await settle();assert(!find(page,'Alice after close'),'a closed profile unsubscribes from metadata');
  await pending;profiles.destroy();
});

test('a profile preloads its follower summary once and stale work cannot cross profiles',async()=>{
  const page=Page(),requests=[];
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],loadFollowers:(key,{signal})=>new Promise(resolve=>requests.push({key,signal,resolve}))});
  const first=profiles.open(keys[0],{navigate:false});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,1,'the summary starts one bounded lookup');
  find(page,'Followers').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1);
  find(page,'Followers').click();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,1,'repeated clicks share the pending lookup');
  const stale=requests[0],second=profiles.open(keys[1],{navigate:false});await new Promise(resolve=>setImmediate(resolve));assert.equal(stale.signal.aborted,true);
  stale.resolve({items:[],observedCount:0,complete:false,loaded:true,warnings:[]});await new Promise(resolve=>setImmediate(resolve));
  assert(find(page,'Bob'));assert(find(page,'Followers'));assert(!find(page,'Followers 0'));assert.equal(requests.length,2);
  profiles.close();await Promise.all([first,second]);profiles.destroy();
});

test('router navigation callback can reopen silently, and programmatic close does not notify',async()=>{
  const page=Page();let calls=0,closed=0,nested;
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],onNavigate(key){calls++;nested=profiles.open(key,{navigate:false});},onClose(){closed++;}});
  await profiles.open(keys[1]);assert.equal(calls,1);assert(find(page,'Bob'));
  profiles.close();assert.equal(closed,0);assert.equal(page.hidden,true);await nested;
  profiles.destroy();assert.equal(closed,0);assert.equal(page.children.length,0);
});

test('changing profiles cancels stale work and explicit Back notifies once',async()=>{
  const page=Page();let closed=0;
  const profiles=setupProfiles({page,getRelays:()=>relays,getContext:()=>keys[0],onClose(){closed++;}});
  const first=profiles.open(keys[0],{navigate:false});const second=profiles.open(keys[1],{navigate:false});
  assert(find(page,'Bob'));assert(!find(page,'Alice'));
  all(page).find(node=>node.getAttribute('aria-label')==='Back from profile').click();await Promise.all([first,second]);assert.equal(closed,1);assert.equal(page.hidden,true);profiles.destroy();
});

test('profile defaults to listings and owns their lifetime across connection tabs and navigation',async()=>{
  const page=Page(),started=[],stopped=[];
  const profiles=setupProfiles({page,getRelays:()=>relays,isPreview:()=>true,renderListings(key,host){
    started.push(key);const card=Card('Bicycle');host.append(card);return()=>stopped.push(key);
  }});
  await profiles.open(keys[0],{navigate:false});
  const selected=()=>all(page).find(node=>node.getAttribute('aria-selected')==='true');
  assert.equal(selected().textContent,'Listings');assert(find(page,'Bicycle'));
  const identity=all(page).find(node=>node.className==='profile-identity');
  assert([...identity.children].some(node=>node.getAttribute('aria-label')==='Back from profile'));
  assert.equal(find(page,'Back'),undefined);assert.deepEqual(started,[keys[0]]);
  find(page,'Following').click();assert.equal(find(page,'Bicycle'),undefined);assert.deepEqual(stopped,[keys[0]]);
  find(page,'Listings').click();assert(find(page,'Bicycle'));assert.deepEqual(started,[keys[0],keys[0]]);
  await profiles.open(keys[1],{navigate:false});assert.equal(selected().textContent,'Listings');
  assert.deepEqual(stopped,[keys[0],keys[0]]);assert.equal(started.at(-1),keys[1]);
  profiles.close();assert.deepEqual(stopped,[keys[0],keys[0],keys[1]]);profiles.destroy();assert.equal(stopped.length,3);
});

test('review summary opens a secondary tab and account refresh preserves the selected listings host',async()=>{
  const page=Page(),started=[],stopped=[];
  const review=finalizeEvent(buildReviewDraft({target:keys[0],author:keys[1],rating:4,body:'Good communication.'}),secrets[1]);
  let pending=[review];
  const profiles=setupProfiles({page,getRelays:()=>relays,isPreview:()=>true,getReviewAccount:()=>({owner:keys[1],canSign:true,pending}),renderListings(key,host){
    started.push(key);host.append(Card());return()=>stopped.push(key);
  }});
  await profiles.open(keys[0],{navigate:false});assert.equal(all(page).find(node=>node.getAttribute('aria-selected')==='true').textContent,'Listings');
  const host=all(page).find(node=>node.className==='profile-listings');profiles.refreshReviews();assert.equal(started.length,1);assert.equal(stopped.length,0);assert.equal(all(page).find(node=>node.className==='profile-listings'),host);
  find(page,'★ 4.0 · 1 review').click();assert.equal(stopped.length,1);assert(find(page,'Good communication.'));assert.equal(all(page).find(node=>node.getAttribute('aria-selected')==='true').textContent,'Reviews');
  find(page,'Listings').click();assert.equal(started.length,2);profiles.close();assert.equal(stopped.length,2);profiles.destroy();
});

const graphProfile=(target,known=[])=>({profile:readProfileMetadata(target,{relays}),contextPubkey:keys[0],contextLabel:'Alice',relation:{distance:2,badge:'friend',knownFollowers:known,knownFollowerCount:known.length,description:'Loaded connection',partial:true},mutualFollowing:false,followsContext:false,following:{items:[],total:0,truncated:false},followedByKnown:known.map(pubkey=>({pubkey})),coverage:{secondHopLoaded:4,directFollows:10,warnings:[]}});
test('known followers replace Known tab and appear first with a max-three linked identity summary',async()=>{
  const page=Page(),requests=[],known=[keys[2],keys[1],keys[3],keys[4]];
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0],known),loadFollowers:(key,{signal})=>new Promise(resolve=>requests.push({key,signal,resolve}))});
  await profiles.open(keys[0],{navigate:false});
  assert(!all(page).some(node=>node.id==='profile-tab-known'));assert.equal(requests.length,1);
  const summary=all(page).find(node=>node.className==='profile-followed-by');assert(summary);
  assert.deepEqual(people(summary),known.slice(0,3));
  assert(find(summary,'Followed by'));assert(find(summary,'Carol'));assert(find(summary,'Bob'));assert(find(summary,'Dave'));assert(!find(summary,'Eve'));
  assert(!all(summary).some(node=>node.textContent.startsWith('npub')));
  find(summary,'and 1 other').click();assert.equal(requests.length,1);
  let list=all(page).find(node=>node.className==='profile-people');assert.deepEqual(people(list),known);
  requests[0].resolve({items:[{pubkey:keys[5]},{pubkey:keys[1]},{pubkey:keys[4]}],observedCount:3,complete:false,loaded:true,warnings:[]});await new Promise(resolve=>setImmediate(resolve));
  list=all(page).find(node=>node.className==='profile-people');assert.deepEqual(people(list),[...known,keys[5]]);assert(find(page,'Followers 5'));
  find(page,'Followers 5').click();assert.equal(requests.length,1,'loaded follower pages are reused');
  const currentSummary=all(page).find(node=>node.className==='profile-followed-by');assert(find(currentSummary,'and 2 others'));
  const named=[...currentSummary.children].find(node=>node.dataset.person===keys[2]);assert.equal(named.tagName,'A');assert.equal(named.href,profileURL(keys[2],location.href));named.click();assert(find(page,'Carol'),'known names open profiles via the existing person action');profiles.destroy();
});
test('failed inbound lookup retains graph-known followers and retry can exclude superseded signed evidence',async()=>{
  const page=Page();let calls=0;
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0],[keys[1],keys[2]]),loadFollowers:async()=>{calls++;if(calls===1)throw Error('offline');return {items:[{pubkey:keys[3]}],excludedKnownFollowers:[keys[1]],observedCount:1,loaded:true,complete:false,warnings:[]};}});
  await profiles.open(keys[0],{navigate:false});find(page,'Followers 2').click();await new Promise(resolve=>setImmediate(resolve));
  assert(find(page,'Could not load followers.'));assert(find(page,'Followers 2'));assert.equal(people(all(page).find(node=>node.className==='profile-people')).length,2);
  find(page,'Try again').click();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(people(all(page).find(node=>node.className==='profile-people')),[keys[2],keys[3]]);assert(find(page,'Followers 2'));
  const summary=all(page).find(node=>node.className==='profile-followed-by');assert.deepEqual(people(summary),[keys[2],keys[3]]);profiles.destroy();
});
test('unknown follower coverage has no fabricated count or empty followed-by row',async()=>{
  const page=Page();let resolveFollowers;
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0]),loadFollowers:()=>new Promise(resolve=>resolveFollowers=resolve)});
  await profiles.open(keys[0],{navigate:false});assert(!all(page).some(node=>node.className==='profile-followed-by'));assert(find(page,'Followers'));assert(!find(page,'Followers 0'));
  find(page,'Followers').click();resolveFollowers({items:[],observedCount:0,complete:false,loaded:true,warnings:[]});await new Promise(resolve=>setImmediate(resolve));assert(find(page,'Followers 0'));profiles.destroy();
});

test('explicitly superseded second-hop followers clear the current stale badge and follow-distance note',async()=>{
  const page=Page();let resolveFollowers;
  const profiles=setupProfiles({page,getRelays:()=>relays,loadProfileData:async()=>graphProfile(keys[0],[keys[1]]),loadFollowers:()=>new Promise(resolve=>{resolveFollowers=resolve})});
  await profiles.open(keys[0],{navigate:false});assert(all(page).some(node=>node.classList?.contains('relationship-badge')&&node.classList.contains('relationship-friend')));
  find(page,'Followed by').click();assert.equal(find(page,'Followers 1').getAttribute('aria-selected'),'true');
  resolveFollowers({items:[],excludedKnownFollowers:[keys[1]],observedCount:0,loaded:true,complete:false,warnings:[]});await new Promise(resolve=>setImmediate(resolve));
  assert(!all(page).some(node=>node.className==='profile-followed-by'));
  assert(!all(page).some(node=>node.classList?.contains('relationship-badge')&&node.classList.contains('relationship-friend')),'the open identity must not retain a second-hop badge after every known path explicitly unfollows');
  assert(!all(page).some(node=>node.textContent==='Follow distance: 2'&&!node.hidden));profiles.destroy();
});

test('public collections mount once through profile refresh and release their lookups on navigation',async()=>{
  const page=Page(), mounted=[], closed=[];
  let finishProfile;
  const profiles=setupProfiles({page,getRelays:()=>relays,loadFollowers:async()=>({items:[],excludedKnownFollowers:[]}),
    loadProfileData:key=>new Promise(resolve=>{finishProfile=()=>resolve(graphProfile(key));}),
    renderCollections(key,host){mounted.push(key);host.replaceChildren(document.createElement('form'));return()=>closed.push(key);}});
  const pending=profiles.open(keys[0],{navigate:false});
  find(page,'Collections').click();const editor=all(page).find(element=>element.tagName==='FORM');
  finishProfile();await pending;
  assert.deepEqual(mounted,[keys[0]]);assert(all(page).includes(editor),'the draft survives a profile metadata update');
  find(page,'Reviews').click();assert.deepEqual(closed,[keys[0]]);
  find(page,'Collections').click();profiles.close();assert.deepEqual(closed,[keys[0],keys[0]]);
  profiles.destroy();
});
