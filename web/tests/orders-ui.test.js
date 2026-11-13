import test from 'node:test';
import assert from 'node:assert/strict';
import {window,settle} from './support/dom.mjs';
import {flushSync} from 'svelte';
globalThis.Event=window.Event;

// Assertions follow clicks directly, so apply Svelte's updates synchronously.
const nativeClick=HTMLElement.prototype.click;
HTMLElement.prototype.click=function(){nativeClick.call(this);flushSync();};
let visibility='visible';
Object.defineProperty(document,'visibilityState',{get:()=>visibility,configurable:true});
document.hasFocus=()=>true;
document.documentElement.dataset.appearance='light';
const geo={calls:[],cleared:[],watchPosition(success,failure,options){this.calls.push({success,failure,options});return this.calls.length;},clearWatch(id){this.cleared.push(id);}};
Object.defineProperty(navigator,'geolocation',{value:geo,configurable:true});
globalThis.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
const {setupPeople}=await import('../src/people.ts');setupPeople({getRelays:()=>[],isPreview:()=>true});
const {setupOrders}=await import('../src/orders-ui.ts');
const all=node=>[node,...node.querySelectorAll('*')];
// The innermost element whose whole text matches.
const find=(node,text)=>all(node).filter(element=>element.textContent===text).at(-1);
const submit=form=>{form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true}));flushSync();};
const buyer='b'.repeat(64),seller='a'.repeat(64),courier='c'.repeat(64);
function fixture({signedOut=false,delivered=false,eta=undefined,buyerView=false,offers=[],payment=undefined,escrow}={}){
  visibility='visible';geo.calls=[];geo.cleared=[];
  let state={status:signedOut?'empty':'ready',ownerPubkey:signedOut?undefined:buyerView?buyer:courier,orders:[],conversations:[]},reads=0,signIns=0;
  const listeners=new Set(),updates=[],reviews=[],announced=[],deliveries=[],payments=[];
  const job={id:'job',buyer,seller,payment,items:[{id:'item',title:'Private parcel',price:'10',currency:'EUR',quantity:1}],status:delivered?'delivered':'accepted',createdAt:100,updatedAt:100,shipment:{eta,stops:[{id:'pickup',label:'Pickup',address:'Private pickup',status:'pending',...(buyerView?{}:{courierPubkey:courier})}]},archived:false,sync:'queued',locationFresh:false};state.orders=[job];
  const account={state:()=>state,showAccount:()=>signIns++,closeAccount(){},onState:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},messaging:{requestDelivery:async(id,service,destination)=>{deliveries.push({id,service,destination});const result={...job,id:'delivery',seller:service.author,deliveryRequest:{pickup:job.shipment.stops[0],destination}};state.orders.push(result);return result;},updateOrder:async(id,patch)=>{updates.push({id,patch});}}};
  const page=document.createElement('main');document.body.append(page);
  const ui=setupOrders({account,page,escrow,onPay:order=>payments.push(order),onReview:key=>reviews.push(key),courier:{getListings:()=>{reads++;return[...offers,{id:'public',author:seller,title:'Public parcel request',tags:['parcel'],category:'transport',side:'request',status:'active'}];},onListing(){},onAnnounce:value=>announced.push(value)}});
  return{ui,page,job,updates,reviews,announced,deliveries,payments,get reads(){return reads;},get signIns(){return signIns;},setState:patch=>{state={...state,...patch};for(const fn of listeners)fn(state);},cleanup(){window.dispatchEvent(new window.Event('pagehide'));page.remove();}};
}

test('arrival countdown advances without network updates or replacing controls and disappears on completion',t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:1000000});
  const f=fixture({eta:1120});try{
    f.ui.open('job');const headline=find(f.page,'About 2 min'),button=find(f.page,'Share live location');assert(headline);
    t.mock.timers.tick(75000);assert.equal(headline.textContent,'Less than a minute');assert(find(f.page,'Share live location')===button);
    t.mock.timers.tick(45000);assert.equal(headline.textContent,'Taking longer than expected');
    f.job.status='delivered';f.setState({});assert.equal(find(f.page,'Estimated arrival'),undefined);
  }finally{f.cleanup();}
});

test('signed-out courier workspace shows real public work without unlocking private orders',()=>{
  const f=fixture({signedOut:true});try{
    f.ui.open(undefined,'deliveries');assert(find(f.page,'Public parcel request'));assert.equal(f.signIns,0);assert.equal(geo.calls.length,0);
    find(f.page,'My jobs').click();assert.equal(find(f.page,'Private parcel'),undefined);find(f.page,'Sign in to see your jobs').click();assert.equal(f.signIns,1);
  }finally{f.cleanup();}
});

test('public courier refresh does not rebuild an open private job or start location sharing',()=>{
  const f=fixture();try{
    f.ui.open('job','deliveries');const button=find(f.page,'Share live location'),reads=f.reads;
    f.ui.refreshCourier();assert.equal(f.reads,reads);assert(find(f.page,'Share live location')===button);assert.equal(geo.calls.length,0);
  }finally{f.cleanup();}
});

test('provider gets prominent next-stop directions and an arrival action without starting GPS',async()=>{
  const f=fixture();try{
    f.ui.open('job','deliveries');
    const card=all(f.page).find(node=>node.className==='transport-next-stop');assert(card);
    assert(find(card,'Pickup'));assert(find(card,'Private pickup'));assert(find(card,'0 of 1 stops completed'));
    assert.equal(new URL(find(card,'Directions').href).searchParams.get('destination'),'Private pickup');
    find(card,'Mark arrived').click();await settle();
    assert.deepEqual(f.updates,[{id:'job',patch:{stopId:'pickup',status:'arrived'}}]);assert.equal(geo.calls.length,0);
  }finally{f.cleanup();}
});

test('live location is explicitly per-job, stoppable, and stale callbacks cannot resume it',async()=>{
  const f=fixture();try{
    f.ui.open('job','deliveries');assert.equal(geo.calls.length,0);find(f.page,'Share live location').click();assert.equal(geo.calls.length,1);
    assert.equal(find(f.page,'Stop sharing location').getAttribute('aria-pressed'),'true');
    const callback=geo.calls[0].success;callback({coords:{longitude:25.123456,latitude:60.123456}});await settle();
    assert.deepEqual(f.updates[0],{id:'job',patch:{location:{coordinates:[25.12346,60.12346],stopId:'pickup'}}});
    f.ui.refreshCourier();assert.equal(geo.cleared.length,0);find(f.page,'Stop sharing location').click();await settle();
    assert.deepEqual(geo.cleared,[1]);assert.deepEqual(f.updates.at(-1),{id:'job',patch:{location:null}});assert.equal(find(f.page,'Share live location').getAttribute('aria-pressed'),'false');
    const count=f.updates.length;callback({coords:{longitude:1,latitude:2}});await settle();assert.equal(f.updates.length,count);
  }finally{f.cleanup();}
});

test('leaving or hiding a job stops its GPS watch and clears the shared position',async()=>{
  for(const reason of ['route','background']){
    const f=fixture();try{
      f.ui.open('job','deliveries');find(f.page,'Share live location').click();
      if(reason==='route')f.ui.hide();else{visibility='hidden';document.dispatchEvent(new window.Event('visibilitychange'));}
      await settle();assert.deepEqual(geo.cleared,[1]);assert.deepEqual(f.updates.at(-1),{id:'job',patch:{location:null}});
    }finally{f.cleanup();}
  }
});

test('lock ends the GPS session without using the now-locked signer',async()=>{
  const f=fixture();try{
    f.ui.open('job','deliveries');find(f.page,'Share live location').click();f.setState({status:'locked'});await settle();
    assert.deepEqual(geo.cleared,[1]);assert.deepEqual(f.updates,[]);assert.equal(f.page.children[0].open,false);
  }finally{f.cleanup();}
});

test('completed-job review actions pass only the chosen public profile, never private shipment data',()=>{
  const f=fixture({delivered:true});try{
    f.ui.open('job','deliveries');assert.equal(find(f.page,'Share live location'),undefined);
    const buttons=all(f.page).filter(node=>node.tagName==='BUTTON'&&node.textContent==='Review');assert.equal(buttons.length,2);
    buttons[0].click();assert.deepEqual(f.reviews,[buyer]);assert.equal(f.page.children[0].open,false);assert.deepEqual(f.updates,[]);assert.deepEqual(f.announced,[]);
  }finally{f.cleanup();}
});


test('ordinary buyer order books a separate courier after reviewing private destination, preserving input across feed refresh',async()=>{
  const service={id:'courier-item',author:courier,title:'Parcel delivery',side:'offer',category:'transport',tags:['parcel'],price:'8',currency:'TESTSAT'};
  const f=fixture({buyerView:true,offers:[service]});try{
    f.ui.open('job');assert(find(f.page,'Arrange delivery'));find(f.page,'Arrange delivery').click();
    const address=all(f.page).find(el=>el.getAttribute('aria-label')==='Destination address or meeting point');address.value='A private meeting point';
    f.ui.refreshCourier();assert.equal(address.value,'A private meeting point');assert(address.isConnected);
    const choose=all(f.page).find(el=>el.tagName==='BUTTON'&&el.className.includes('order-service-option'));choose.click();
    assert(find(f.page,'Only this delivery provider receives your destination. The merchant receives their identity and a pickup reference.'));
    const form=all(f.page).find(el=>el.className==='order-delivery-form');submit(form);await settle();
    assert.equal(f.deliveries.length,1);assert.equal(f.deliveries[0].id,'job');assert.equal(f.deliveries[0].service.author,courier);assert.equal(f.deliveries[0].destination.address,'A private meeting point');assert.equal(geo.calls.length,0);
  }finally{f.cleanup();}
});
test('payment uses the normal order action and keeps test funds visibly distinct',()=>{
  const f=fixture({buyerView:true,payment:{amount:'16',mint:'https://testnut.cashu.space',unit:'sat',status:'requested'}});try{
    f.ui.open('job');assert(find(f.page,'16 test sats'));assert(find(f.page,'testnut.cashu.space · Test money · no bitcoin value'));find(f.page,'Pay').click();assert.deepEqual(f.payments,[f.job]);
    f.job.payment.status='received';f.setState({});assert(find(f.page,'Payment received'));assert.equal(find(f.page,'Pay'),undefined);
  }finally{f.cleanup();}
});


test('escrow checkout preserves the draft, requests no direct order, and responds to a flag change',async()=>{
  let enabled=true,requests=[];
  const escrow={canCheckout:()=>enabled,showJobs:()=>enabled,checkout:async(l,draft)=>{requests.push(draft);}};
  const f=fixture({buyerView:true,escrow});try{
    f.ui.buy({id:seller+':camera',author:seller,title:'Camera',price:'20',currency:'SATS',status:'active',side:'offer',escrow:{trade:'goods'}});
    const form=all(f.page).find(el=>el.className==='order-review'),inputs=all(form);
    const quantity=inputs.find(el=>el.type==='number'),note=inputs.find(el=>el.tagName==='TEXTAREA'),protect=inputs.find(el=>el.type==='checkbox');
    assert(!protect.checked);quantity.value='3';note.value='Pickup on Saturday';protect.checked=true;protect.dispatchEvent(new window.Event('change',{bubbles:true}));flushSync();
    assert(find(form,'Choose escrow provider'));submit(form);await settle();
    assert.deepEqual(requests,[{quantity:3,note:'Pickup on Saturday'}]);assert(find(f.page,'Choose escrow provider').parentElement===form);
    enabled=false;window.dispatchEvent(new window.Event('market-tools-change'));
    assert.equal(protect.parentElement.hidden,true);assert.equal(protect.checked,false);assert.equal(quantity.value,'3');assert(find(form,'Request order'));
  }finally{f.cleanup();}
});

test('linked orders expose escrow and suppress direct payment for both traders',()=>{
  const escrow={showJobs:()=>false,linked:()=>{const button=document.createElement('button');button.textContent='Open escrow';return button;}};
  for(const owner of [buyer,seller]){const f=fixture({buyerView:true,payment:{amount:'10',mint:'https://testnut.cashu.space',status:'requested'},escrow});try{
    f.job.escrowTradeId='d'.repeat(64);f.job.escrowProvider=courier;f.setState({ownerPubkey:owner});f.ui.open('job');
    assert(find(f.page,'Open escrow'));assert(!find(f.page,'Pay'));assert(!find(f.page,'Confirm payment received'));
    delete f.job.payment;f.job.status='requested';f.setState({});assert(!find(f.page,'Request payment'));assert(!find(f.page,'Accept order'));
  }finally{f.cleanup();}}
});

test('provider jobs are reachable from Orders, including after the ordinary orders list is empty',()=>{
  let enabled=true;
  const escrow={showJobs:()=>enabled,jobs:host=>{const message=document.createElement('p');message.textContent='Private invitation';host.append(message);}};
  const f=fixture({escrow});try{
    f.setState({orders:[]});f.ui.open();find(f.page,'Escrow jobs').click();assert(find(f.page,'Private invitation'));
    enabled=false;window.dispatchEvent(new window.Event('market-tools-change'));assert(!find(f.page,'Escrow jobs'));assert(!find(f.page,'Private invitation'));
  }finally{f.cleanup();}
});
