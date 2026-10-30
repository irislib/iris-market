import test from 'node:test';
import assert from 'node:assert/strict';
import {setupServiceAreaPicker,createServiceAreaOverlay,restoreServiceAreaCircle} from '../src/service-area-ui.ts';
import {serviceAreaCircle,serviceAreaContains} from '../src/service-area.ts';

class Element extends EventTarget{
  constructor(tag){super();this.tag=tag;this.children=[];this.attributes=new Map();this.dataset={};this.textContent='';this.value='';this.hidden=false;this.disabled=false;this.classList={toggle(){}};}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);}
  click(){if(!this.disabled)return this.onclick?.();}
}
const all=node=>[node,...node.children.flatMap(all)],find=(node,text)=>all(node).find(child=>child.textContent===text);
const label=(node,text)=>all(node).find(child=>child.getAttribute('aria-label')===text);
const document={createElement:tag=>new Element(tag),documentElement:{dataset:{appearance:'light'}}};
globalThis.document=document;
class MapStub{
  listeners=new Map();sources=new Map();layers=new Map();canvas=new Element('canvas');fits=[];
  on(name,handler){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(handler);}
  off(name,handler){this.listeners.get(name)?.delete(handler);}
  emit(name,event={}){for(const listener of this.listeners.get(name)??[])listener(event);}
  getCanvas(){return this.canvas;}
  getCenter(){return{lng:24.94,lat:60.17};}
  addSource(id,options){const source={data:options.data,setData(value){this.data=value;}};this.sources.set(id,source);}
  getSource(id){return this.sources.get(id);}
  addLayer(layer){this.layers.set(layer.id,layer);}
  getLayer(id){return this.layers.get(id);}
  fitBounds(bounds,options){this.fits.push({bounds,options});}
}
function fixture(options={}){
  const maps=[],changes=[];let requests=0,closed=0;
  const createMap=async(_container,options)=>{requests++;const map=new MapStub();map.appearance=[options.dark];maps.push(map);const overlay=options.createOverlay(map,false);map.emit('load');return{resize(){},async setDark(value){map.appearance.push(value);},async destroy(){closed++;overlay.destroy();}};};
  const ui=setupServiceAreaPicker({createMap,onChange:value=>changes.push(value),...options});
  return{ui,maps,changes,get requests(){return requests;},get closed(){return closed;},click:(lon=24.94,lat=60.17)=>maps.at(-1).emit('click',{lngLat:{lng:lon,lat}})};
}
const polygon={type:'Polygon',coordinates:[[[20,59],[22,59],[22,61],[20,61],[20,59]]]};

test('opening an area picker never selects the initial map location or requests GPS',async()=>{
  let locationCalls=0;const f=fixture({geolocation:{getCurrentPosition(){locationCalls++;}}});
  assert.equal(f.requests,0);assert.equal(f.ui.getValue(),null);await f.ui.show();
  assert.equal(f.requests,1);assert.equal(locationCalls,0);assert.equal(f.ui.getValue(),null);assert.deepEqual(f.changes,[]);
  f.click();const value=f.ui.getValue();assert(serviceAreaContains(value.pickup,[24.94,60.17]));assert.deepEqual(value.destination,value.pickup);assert.equal(f.changes.length,1);
  assert.equal(f.maps[0].getSource('service-areas').data.features.length,1,'shared boundary is drawn once');await f.ui.destroy();assert.equal(f.closed,1);
});

test('destination requires its own choice when Same as pickup is unchecked and preserves the other boundary',async()=>{
  const f=fixture();await f.ui.show();f.click();const pickup=f.ui.getValue().pickup;
  const checkbox=all(f.ui.element).find(node=>node.type==='checkbox');checkbox.checked=false;checkbox.onchange();assert.equal(f.ui.getValue(),null);
  find(f.ui.element,'Destination').click();f.click(25.7,61.1);const destination=f.ui.getValue().destination;
  assert.deepEqual(f.ui.getValue().pickup,pickup);assert.notDeepEqual(destination,pickup);assert.equal(f.maps[0].getSource('service-areas').data.features.length,2);
  checkbox.checked=true;checkbox.onchange();assert.deepEqual(f.ui.getValue().destination,pickup);
  checkbox.checked=false;checkbox.onchange();assert.deepEqual(f.ui.getValue().destination,destination);await f.ui.destroy();
});

test('setValue silently preserves exact existing geometry until an explicit boundary replacement',async()=>{
  const destination=serviceAreaCircle([25,62],20),value={pickup:polygon,destination};const f=fixture();f.ui.setValue(value);await f.ui.show();
  assert.deepEqual(f.ui.getValue(),value);assert.deepEqual(f.changes,[]);
  const radius=all(f.ui.element).find(node=>node.type==='number');radius.value='50';radius.onchange();assert.deepEqual(f.ui.getValue(),value);assert.deepEqual(f.changes,[]);
  f.click();assert.notDeepEqual(f.ui.getValue().pickup,polygon);assert.deepEqual(f.ui.getValue().destination,destination);
  const saved=f.ui.getValue();assert.throws(()=>f.ui.setValue({pickup:{type:'Point',coordinates:[0,0]},destination}));assert.deepEqual(f.ui.getValue(),saved);
  radius.value='3000';radius.onchange();assert.deepEqual(f.ui.getValue(),saved);await f.ui.destroy();
});

test('location is explicit and its late callback cannot change hidden or reset areas',async()=>{
  let success,requests=0;const f=fixture({geolocation:{getCurrentPosition(callback){requests++;success=callback;}}});await f.ui.show();
  const locate=label(f.ui.element,'Use my location for service area');locate.click();assert.equal(requests,1);assert.equal(f.ui.getValue(),null);
  f.ui.hide();success({coords:{longitude:24,latitude:60}});assert.equal(f.ui.getValue(),null);
  await f.ui.show();locate.click();f.ui.setValue(null);success({coords:{longitude:24,latitude:60}});assert.equal(f.ui.getValue(),null);
  locate.click();f.click(26,62);const selected=f.ui.getValue();success({coords:{longitude:24,latitude:60}});assert.deepEqual(f.ui.getValue(),selected,'a manual choice supersedes pending location');
  locate.click();success({coords:{longitude:24,latitude:60}});assert(serviceAreaContains(f.ui.getValue().pickup,[24,60]));await f.ui.destroy();
});

test('read-only preview draws both boundaries and cannot change them through map input',async()=>{
  const value={pickup:polygon,destination:serviceAreaCircle([25,62],20)},f=fixture({value,readOnly:true});await f.ui.show();
  assert.equal(f.maps[0].getSource('service-areas').data.features.length,2);f.click(0,0);assert.deepEqual(f.ui.getValue(),value);assert.deepEqual(f.changes,[]);
  assert.equal(all(f.ui.element).find(node=>node.className==='service-area-tools').hidden,true);await f.ui.destroy();
});

test('keyboard selection uses the map center and destroy removes map and canvas listeners',()=>{
  const map=new MapStub(),picked=[],overlay=createServiceAreaOverlay(map,{interactive:true,onPick:point=>picked.push(point)});map.emit('load');
  const enter=new Event('keydown',{cancelable:true});Object.defineProperty(enter,'key',{value:'Enter'});map.canvas.dispatchEvent(enter);assert.deepEqual(picked,[[24.94,60.17]]);
  overlay.destroy();map.emit('click',{lngLat:{lng:1,lat:2}});map.canvas.dispatchEvent(enter);assert.equal(picked.length,1);assert.equal(map.canvas.getAttribute('aria-label'),null);
  assert.equal([...map.listeners.values()].reduce((count,list)=>count+list.size,0),0);
});

test('closing during map initialization disposes its late result and never marks an area',async()=>{
  let finish,closed=0,calls=0;const f=fixture({createMap:(_container,options)=>{calls++;const map=new MapStub();options.createOverlay(map,false);return new Promise(resolve=>{finish=()=>resolve({resize(){},async destroy(){closed++;}});});}});
  const opening=f.ui.show();await Promise.resolve();f.ui.hide();finish();await opening;
  assert.equal(closed,1);assert.equal(calls,1);assert.equal(f.ui.getValue(),null);assert.deepEqual(f.changes,[]);await f.ui.destroy();
});

test('map failure keeps existing areas usable and exposes an explicit retry',async()=>{
  let attempts=0;const f=fixture({value:{pickup:polygon,destination:polygon},createMap:async()=>{attempts++;throw Error('Offline');}});
  await f.ui.show();assert(find(f.ui.element,'Map unavailable.'));assert.equal(find(f.ui.element,'Retry map').hidden,false);assert.equal(attempts,1);
  await f.ui.show();assert.equal(attempts,1,'feed refresh does not repeatedly retry a failed map');
  assert.deepEqual(f.ui.getValue(),{pickup:polygon,destination:polygon});await find(f.ui.element,'Retry map').click();assert.equal(attempts,2);await f.ui.destroy();
});

test('concurrent show calls share a failing map initialization and do not retry it',async()=>{
  let reject,attempts=0;const f=fixture({createMap:()=>{attempts++;return new Promise((_,fail)=>{reject=fail;});}});
  const first=f.ui.show(),second=f.ui.show(),third=f.ui.show();assert.equal(attempts,1);
  reject(Error('Offline'));await Promise.all([first,second,third]);assert.equal(attempts,1);assert.equal(find(f.ui.element,'Retry map').hidden,false);
  const retry=find(f.ui.element,'Retry map').click();await Promise.resolve();assert.equal(attempts,2);reject(Error('Still offline'));await retry;assert.equal(attempts,2);await f.ui.destroy();
});

test('clear removes the selected boundary, preserves an independent destination and validates partial edits',async()=>{
  const destination=serviceAreaCircle([25,62],20),f=fixture({value:{pickup:polygon,destination}});await f.ui.show();
  assert.deepEqual(f.ui.validate(),{pickup:polygon,destination});find(f.ui.element,'Clear area').click();
  assert.equal(f.ui.getValue(),null);assert.equal(f.changes.at(-1),null);assert.throws(()=>f.ui.validate(),/Choose a pickup area/);
  assert.deepEqual(f.maps[0].getSource('service-areas').data.features.map(feature=>feature.geometry),[destination]);
  find(f.ui.element,'Destination').click();find(f.ui.element,'Clear area').click();assert.equal(f.ui.validate(),null);assert.equal(f.maps[0].getSource('service-areas').data.features.length,0);
  f.ui.setValue({pickup:polygon,destination:polygon});find(f.ui.element,'Clear area').click();assert.equal(f.ui.validate(),null);assert.equal(f.maps[0].getSource('service-areas').data.features.length,0,'clearing linked pickup clears both areas');
  f.click();const checkbox=all(f.ui.element).find(node=>node.type==='checkbox');checkbox.checked=false;checkbox.onchange();assert.throws(()=>f.ui.validate(),/Choose a destination area/);await f.ui.destroy();
});

test('map appearance follows app and system themes, including changes while opening, and removes listeners',async t=>{
  class TrackedTarget extends EventTarget{
    listeners=new Set();
    addEventListener(name,fn,...rest){this.listeners.add(fn);super.addEventListener(name,fn,...rest);}
    removeEventListener(name,fn,...rest){this.listeners.delete(fn);super.removeEventListener(name,fn,...rest);}
  }
  const saved=Object.fromEntries(['window','matchMedia'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,descriptor] of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}document.documentElement.dataset.appearance='light';});
  const window=new TrackedTarget(),media=new TrackedTarget();media.matches=false;globalThis.window=window;globalThis.matchMedia=()=>media;
  document.documentElement.dataset.appearance='dark';const f=fixture();await f.ui.show();assert.deepEqual(f.maps[0].appearance,[true]);
  document.documentElement.dataset.appearance='system';window.dispatchEvent(new Event('market-themechange'));assert.deepEqual(f.maps[0].appearance,[true,false]);
  media.matches=true;media.dispatchEvent(new Event('change'));assert.deepEqual(f.maps[0].appearance,[true,false,true]);
  document.documentElement.dataset.appearance='light';window.dispatchEvent(new Event('market-themechange'));assert.equal(f.maps[0].appearance.at(-1),false);
  media.matches=false;media.dispatchEvent(new Event('change'));assert.equal(f.maps[0].appearance.length,4,'system change does not override explicit light');
  assert.equal(window.listeners.size,1);assert.equal(media.listeners.size,1);await f.ui.destroy();assert.equal(window.listeners.size,0);assert.equal(media.listeners.size,0);
  let finish;const appearances=[];const late=fixture({createMap:(_container,options)=>{appearances.push(options.dark);return new Promise(resolve=>{finish=()=>resolve({resize(){},async setDark(value){appearances.push(value);},async destroy(){}});});}});
  const opening=late.ui.show();document.documentElement.dataset.appearance='dark';window.dispatchEvent(new Event('market-themechange'));finish();await opening;assert.deepEqual(appearances,[false,true]);await late.ui.destroy();assert.equal(window.listeners.size,0);assert.equal(media.listeners.size,0);
});


test('place selection creates a boundary only after choosing a suggestion and stale searches cannot change roles',async()=>{
  let resolve;const f=fixture({searchPlaces:()=>new Promise(done=>{resolve=done;})});await f.ui.show();
  const search=label(f.ui.element,'Search places');search.value='Synthetic';search.oninput();
  await new Promise(done=>setTimeout(done,270));
  find(f.ui.element,'Destination').click();resolve([{name:'Synthetic place',lat:60,lng:24}]);await new Promise(done=>setTimeout(done,0));
  assert.equal(f.ui.getValue(),null);assert.equal(find(f.ui.element,'Synthetic place'),undefined);
  const pending=fixture({searchPlaces:async()=>[{name:'Synthetic place',lat:60,lng:24}]});await pending.ui.show();
  const input=label(pending.ui.element,'Search places');input.value='Synthetic';input.oninput();await new Promise(done=>setTimeout(done,270));
  assert.equal(pending.ui.getValue(),null);find(pending.ui.element,'Synthetic place').click();assert.ok(serviceAreaContains(pending.ui.getValue().pickup,[24,60]));
  await pending.ui.destroy();await f.ui.destroy();
});


test('reopening a saved circle restores its point and radius without rewriting geometry',async()=>{
 const area=serviceAreaCircle([24.94,60.17],25),saved={pickup:area,destination:area};
 const restored=restoreServiceAreaCircle(area);assert.ok(Math.abs(restored.radius-25)<0.0001);assert.ok(Math.abs(restored.point[0]-24.94)<0.000001);
 assert.equal(restoreServiceAreaCircle(polygon),null);
 const f=fixture({value:saved});await f.ui.show();assert.deepEqual(f.ui.getValue(),saved);assert.deepEqual(f.changes,[]);assert.ok(all(f.ui.element).some(node=>node.textContent.includes('km around the selected point')));await f.ui.destroy();
});


test('catalog failure is shown as unavailable rather than a successful empty search',async()=>{
  const f=fixture({searchPlaces:async()=>{throw new Error('Catalog download timed out');}});await f.ui.show();
  const input=label(f.ui.element,'Search places');input.value='Synthetic absent place';input.oninput();
  await new Promise(done=>setTimeout(done,270));
  assert(find(f.ui.element,'Place search unavailable. Choose a point on the map.'));
  assert.equal(find(f.ui.element,'No matching places. Choose a point on the map.'),undefined);
  assert.equal(f.ui.getValue(),null);assert.deepEqual(f.changes,[]);await f.ui.destroy();
});
