import test from 'node:test';
import assert from 'node:assert/strict';
import {courierListingType,courierListings,courierServiceDraft,courierJobs,orderReviewParticipants,setupCourierWorkspace} from '../src/courier-ui.ts';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attributes=new Map();this.dataset={};this.className='';this.textContent='';this.value='';this.hidden=false;this.classList={toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on?names.add(name):names.delete(name);this.className=[...names].join(' ');}};}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  click(){if(!this.disabled)return this.onclick?.();}
  focus(){this.focused=true;}
}
globalThis.document={createElement:tag=>new Element(tag)};
const all=node=>[node,...node.children.flatMap(all)];
const find=(node,text)=>all(node).find(child=>child.textContent===text);
const author='a'.repeat(64),buyer='b'.repeat(64),courier='c'.repeat(64),outsider='d'.repeat(64);
const listing=(id,tags=['parcel'],extra={})=>({id,author,title:`Request ${id}`,side:'request',category:'transport',tags,location:'Helsinki',status:'active',createdAt:10,...extra});
const order=(extra={})=>({id:'order',buyer,seller:author,items:[{id:'item',title:'Parcel',price:'10',currency:'EUR',quantity:1}],status:'accepted',shipment:{stops:[{id:'pickup',status:'pending',courierPubkey:courier}]},updatedAt:10,archived:false,...extra});
function fixture(options={}){
  let owner=courier,rows=[listing('parcel'),listing('ride',['passenger'])],jobs=[order()],moreCalls=0;
  const announced=[],edited=[],opened=[],reviewed=[],storage=new Map();let signIns=0;
  const ui=setupCourierWorkspace({getListings:()=>rows,getOwner:()=>owner,getOrders:()=>jobs,onListing:item=>opened.push(item),onAnnounce:value=>announced.push(value),onEditListing:item=>edited.push(item),onReviews:key=>reviewed.push(key),onSignIn:()=>signIns++,renderOrder:job=>{const button=new Element('button');button.textContent=`Job ${job.id}`;return button;},storage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},...options});
  return {ui,root:ui.element,announced,edited,opened,reviewed,storage,get signIns(){return signIns;},setRows:value=>{rows=value;ui.refresh();},setOwner:value=>{owner=value;ui.refresh();}};
}

test('only explicit transport service tags classify gigs, including passenger-only courier listings',()=>{
  assert.equal(courierListingType(listing('x',['transport'])) ,null);
  assert.equal(courierListingType(listing('x',[],{title:'Buy a passenger car'})),null);
  assert.equal(courierListingType(listing('x',['courier','passenger'])),'passenger');
  assert.equal(courierListingType(listing('x',['Delivery'])),'parcel');
  assert.equal(courierListingType(listing('x',['ride','parcel'])),'both');
});

test('work uses actual active requests, excludes own listings and checks expiry and submitted area',()=>{
  const rows=[listing('yes'),listing('old',['parcel'],{expiration:9}),listing('zero',['parcel'],{expiration:0}),listing('sold',['parcel'],{status:'sold'}),listing('offer',['parcel'],{side:'offer'}),listing('own',['parcel'],{author:courier}),listing('other',['parcel'],{location:'Turku'}),listing('ride',['ride'])];
  assert.deepEqual(courierListings(rows,{owner:courier,area:' HELSINKI ',now:10}).map(item=>item.id),['yes']);
  assert.deepEqual(courierListings(rows,{owner:courier,type:'passenger',now:10}).map(item=>item.id),['ride']);
  assert.deepEqual(courierListings([rows[0],rows[0]],{now:10}).map(item=>item.id),['yes']);
});

test('service draft keeps area explicit and public, with shared listing tags and no automatic publication',()=>{
  for(const type of ['parcel','passenger','both']){
    const value=courierServiceDraft(type,' Helsinki ');assert.equal(value.side,'offer');assert.equal(value.category,'transport');assert.equal(value.location,'Helsinki');assert.equal(value.price,'');assert.equal(courierListingType(value),type);
    assert.deepEqual(Object.keys(value).sort(),['category','description','location','price','side','tags','title']);
  }
  for(const area of ['', 'x'.repeat(161),'a\nb'])assert.throws(()=>courierServiceDraft('parcel',area),/service area/);
  assert.throws(()=>courierServiceDraft('unknown','Helsinki'));
});

test('private jobs require assignment, omit archived records and put active work first',()=>{
  const rows=[order({id:'done',status:'delivered',updatedAt:50}),order({id:'active'}),order({id:'archived',archived:true}),order({id:'unassigned',shipment:{stops:[]}})];
  assert.deepEqual(courierJobs(rows,courier).map(job=>job.id),['active','done']);
  assert.deepEqual(courierJobs(rows,outsider),[]);assert.deepEqual(courierJobs(rows,undefined),[]);
});

test('completed-job review links work in both directions without exposing order details or enabling self reviews',()=>{
  const delivered=order({status:'delivered',shipment:{stops:[{courierPubkey:courier},{courierPubkey:courier}]}});
  assert.deepEqual(orderReviewParticipants(delivered,buyer),[{pubkey:author,label:'Seller'},{pubkey:courier,label:'Courier'}]);
  assert.deepEqual(orderReviewParticipants(delivered,courier),[{pubkey:buyer,label:'Customer'},{pubkey:author,label:'Seller'}]);
  assert.deepEqual(orderReviewParticipants(delivered,outsider),[]);
  assert.deepEqual(orderReviewParticipants(order(),buyer),[]);
  assert.deepEqual(orderReviewParticipants({...delivered,status:'cancelled'},buyer),[]);
});

test('workspace defaults to parcels, preserves preference, and never treats untagged purchases as work',()=>{
  const f=fixture();assert(find(f.root,'Request parcel'));assert.equal(find(f.root,'Request ride'),undefined);
  find(f.root,'Passenger').click();assert(find(f.root,'Request ride'));assert.equal(find(f.root,'Request parcel'),undefined);
  assert.equal(f.storage.get('market-courier-type-v1'),'passenger');
  find(f.root,'Both').click();assert(find(f.root,'Request parcel'));assert(find(f.root,'Request ride'));
  f.setRows([listing('car',[],{title:'Buying a car'})]);assert(find(f.root,'No matching requests'));assert.equal(find(f.root,'Buying a car'),undefined);f.ui.destroy();
});

test('public feed refresh leaves area input mounted and typing does not apply a new filter',()=>{
  const f=fixture(),area=all(f.root).find(node=>node.tag==='input'),form=all(f.root).find(node=>node.tag==='form');
  area.value='Turku';f.ui.refresh();assert.equal(all(f.root).find(node=>node.tag==='input'),area);assert.equal(area.value,'Turku');assert(find(f.root,'Request parcel'));
  form.onsubmit({preventDefault(){}});assert(find(f.root,'No matching requests'));
  area.value='Helsinki';form.onsubmit({preventDefault(){}});assert(find(f.root,'Request parcel'));f.ui.destroy();
});

test('announcing opens a draft only on explicit submit; existing service edit uses original listing',()=>{
  const f=fixture(),mine=listing('my-service',['courier','passenger'],{author:courier,side:'offer'});f.setRows([mine]);
  find(f.root,'Passenger').click();find(f.root,'My service').click();assert.equal(f.announced.length,0);
  const area=all(f.root).find(node=>node.tag==='input');area.value='Helsinki';f.ui.refresh();assert.equal(f.announced.length,0);
  all(f.root).find(node=>node.tag==='form').onsubmit({preventDefault(){}});
  assert.equal(f.announced.length,1);assert.equal(f.announced[0].location,'Helsinki');assert.deepEqual(f.announced[0].tags,['courier','passenger']);
  find(f.root,'Edit listing').click();assert.equal(f.edited[0],mine);find(f.root,'My reviews').click();assert.deepEqual(f.reviewed,[courier]);f.ui.destroy();
});

test('signed-out work browsing stays public, private jobs require sign-in, and identity change clears drafts',()=>{
  const f=fixture();f.setOwner(undefined);assert(find(f.root,'Request parcel'));
  find(f.root,'My jobs').click();find(f.root,'Sign in to see your jobs').click();assert.equal(f.signIns,1);assert.equal(find(f.root,'Job order'),undefined);
  f.setOwner(courier);assert(find(f.root,'Job order'));find(f.root,'My service').click();const area=all(f.root).find(node=>node.tag==='input');area.value='Unpublished area';f.setOwner(outsider);assert.equal(area.value,'');f.ui.destroy();
});

test('pagination reveals the next local page before asking for more inventory and never retries automatically',async()=>{
  let requests=0;const f=fixture({loadMore:async()=>{requests++;throw Error('Offline');},pagination:()=>({hasMore:true})});f.setRows(Array.from({length:30},(_,i)=>listing(`item${i}`)));
  const cards=()=>all(f.root).filter(node=>node.textContent.startsWith('Request item'));
  assert.equal(cards().length,24);await find(f.root,'Load more').click();assert.equal(cards().length,30);assert.equal(requests,0);
  await find(f.root,'Load more').click();assert.equal(requests,1);assert(find(f.root,'Could not load more requests. Try again.'));f.ui.refresh();assert.equal(requests,1);f.ui.destroy();
});

test('preview cannot announce availability and untrusted listing text is never interpreted as markup',()=>{
  const preview=fixture({isPreview:()=>true});find(preview.root,'My service').click();assert.equal(find(preview.root,'Offer service').disabled,true);all(preview.root).find(node=>node.tag==='form').onsubmit({preventDefault(){}});assert.equal(preview.announced.length,0);preview.ui.destroy();
  const f=fixture();f.setRows([listing('x',['parcel'],{title:'<img src=x onerror=alert(1)>'})]);assert(find(f.root,'<img src=x onerror=alert(1)>'));assert.equal(all(f.root).some(node=>node.innerHTML),false);f.ui.destroy();
});
