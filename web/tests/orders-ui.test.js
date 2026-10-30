import test from 'node:test';
import assert from 'node:assert/strict';

class Element extends EventTarget {
  constructor(tag){super();this.tag=tag;this.children=[];this.attributes=new Map();this.dataset={};this.className='';this.textContent='';this.value='';this.hidden=false;this.scrollTop=0;this.classList={toggle:(name,on)=>{const values=new Set(this.className.split(' ').filter(Boolean));on?values.add(name):values.delete(name);this.className=[...values].join(' ');}};}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(matches(child,selector)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  click(){if(!this.disabled)return this.onclick?.();}
  focus(){document.activeElement=this;}
}
function matches(node,selector){if(selector==='[data-order-action]')return 'orderAction'in node.dataset;if(selector==='[data-person-relationship]')return 'personRelationship'in node.dataset;if(selector==='dialog[open]')return node.tag==='dialog'&&node.open;if(selector.startsWith('.'))return node.className.split(' ').includes(selector.slice(1));return node.tag===selector;}
const doc=new EventTarget();doc.body=new Element('body');doc.documentElement={dataset:{appearance:'light'}};doc.createElement=tag=>new Element(tag);doc.visibilityState='visible';doc.hasFocus=()=>true;doc.querySelectorAll=selector=>doc.body.querySelectorAll(selector);
const win=new EventTarget(),geo={calls:[],cleared:[],watchPosition(success,failure,options){this.calls.push({success,failure,options});return this.calls.length;},clearWatch(id){this.cleared.push(id);}};
Object.defineProperties(globalThis,{document:{value:doc,configurable:true},window:{value:win,configurable:true},navigator:{value:{geolocation:geo},configurable:true},matchMedia:{value:()=>({matches:false,addEventListener(){},removeEventListener(){}}),configurable:true},HTMLElement:{value:Element,configurable:true},HTMLInputElement:{value:Element,configurable:true}});
const {setupPeople}=await import('../src/people.ts');setupPeople({getRelays:()=>[],isPreview:()=>true});
const {setupOrders}=await import('../src/orders-ui.ts');
const all=node=>[node,...node.children.flatMap(all)],find=(node,text)=>all(node).find(child=>child.textContent===text),settle=()=>new Promise(resolve=>setImmediate(resolve));
const buyer='b'.repeat(64),seller='a'.repeat(64),courier='c'.repeat(64);
function fixture({signedOut=false,delivered=false,eta=undefined}={}){
  doc.visibilityState='visible';geo.calls=[];geo.cleared=[];
  let state={status:signedOut?'empty':'ready',ownerPubkey:signedOut?undefined:courier,orders:[],conversations:[]},reads=0,signIns=0;
  const listeners=new Set(),updates=[],reviews=[],announced=[];
  const job={id:'job',buyer,seller,items:[{id:'item',title:'Private parcel',price:'10',currency:'EUR',quantity:1}],status:delivered?'delivered':'accepted',createdAt:100,updatedAt:100,shipment:{eta,stops:[{id:'pickup',label:'Pickup',address:'Private pickup',status:'pending',courierPubkey:courier}]},archived:false,sync:'queued',locationFresh:false};state.orders=[job];
  const account={state:()=>state,showAccount:()=>signIns++,closeAccount(){},onState:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},messaging:{updateOrder:async(id,patch)=>{updates.push({id,patch});}}};
  const page=new Element('main');doc.body.append(page);
  const ui=setupOrders({account,page,onReview:key=>reviews.push(key),courier:{getListings:()=>{reads++;return[{id:'public',author:seller,title:'Public parcel request',tags:['parcel'],category:'transport',side:'request',status:'active'}];},onListing(){},onAnnounce:value=>announced.push(value)}});
  return{ui,page,job,updates,reviews,announced,get reads(){return reads;},get signIns(){return signIns;},setState:patch=>{state={...state,...patch};for(const fn of listeners)fn(state);},cleanup(){win.dispatchEvent(new Event('pagehide'));page.remove();}};
}

test('arrival countdown advances without network updates or replacing controls and disappears on completion',t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:1000000});
  const f=fixture({eta:1120});try{
    f.ui.open('job');const headline=find(f.page,'About 2 min'),button=find(f.page,'Share live location');assert(headline);
    t.mock.timers.tick(75000);assert.equal(headline.textContent,'Less than a minute');assert.equal(find(f.page,'Share live location'),button);
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
    f.ui.refreshCourier();assert.equal(f.reads,reads);assert.equal(find(f.page,'Share live location'),button);assert.equal(geo.calls.length,0);
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
    assert.equal(find(f.page,'Stop sharing location').attributes.get('aria-pressed'),'true');
    const callback=geo.calls[0].success;callback({coords:{longitude:25.123456,latitude:60.123456}});await settle();
    assert.deepEqual(f.updates[0],{id:'job',patch:{location:{coordinates:[25.12346,60.12346],stopId:'pickup'}}});
    f.ui.refreshCourier();assert.equal(geo.cleared.length,0);find(f.page,'Stop sharing location').click();await settle();
    assert.deepEqual(geo.cleared,[1]);assert.deepEqual(f.updates.at(-1),{id:'job',patch:{location:null}});assert.equal(find(f.page,'Share live location').attributes.get('aria-pressed'),'false');
    const count=f.updates.length;callback({coords:{longitude:1,latitude:2}});await settle();assert.equal(f.updates.length,count);
  }finally{f.cleanup();}
});

test('leaving or hiding a job stops its GPS watch and clears the shared position',async()=>{
  for(const reason of ['route','background']){
    const f=fixture();try{
      f.ui.open('job','deliveries');find(f.page,'Share live location').click();
      if(reason==='route')f.ui.hide();else{doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));}
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
    const buttons=all(f.page).filter(node=>node.tag==='button'&&node.textContent==='Review');assert.equal(buttons.length,2);
    buttons[0].click();assert.deepEqual(f.reviews,[buyer]);assert.equal(f.page.children[0].open,false);assert.deepEqual(f.updates,[]);assert.deepEqual(f.announced,[]);
  }finally{f.cleanup();}
});
