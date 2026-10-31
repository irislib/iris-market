import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeliveryPlaceInput} from '../src/delivery-place-ui.ts';
class Element extends EventTarget {
 constructor(tag){super();this.tag=tag;this.children=[];this.attributes=new Map();this.value='';this.textContent='';this.hidden=false;}
 append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
 replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}
 setAttribute(k,v){this.attributes.set(k,String(v));}getAttribute(k){return this.attributes.get(k)??null;}removeAttribute(k){this.attributes.delete(k);}
}
globalThis.document={createElement:tag=>new Element(tag),documentElement:{dataset:{appearance:'light'}}};
const all=node=>[node,...node.children.flatMap(all)];
const find=(ui,label)=>all(ui.element).find(n=>n.getAttribute('aria-label')===label||n.textContent===label);
const tick=()=>new Promise(resolve=>setTimeout(resolve,280));
test('private point requires address, never auto-locates, and typing drops previous coordinates',async()=>{
 let gps=0,maps=0;const ui=createDeliveryPlaceInput({label:'Destination',value:{label:'Home',address:'Old address',coordinates:[24,60]},geolocation:{getCurrentPosition(){gps++;}},createMap:async()=>{maps++;},searchPlaces:async()=>[]});
 assert.equal(gps,0);assert.equal(maps,0);assert.deepEqual(ui.read().coordinates,[24,60]);
 const input=find(ui,'Destination address or meeting point');input.value='New address';input.oninput();assert.equal(ui.read().coordinates,undefined);
 input.value='';input.oninput();assert.throws(()=>ui.read(),/Enter the destination/);
 find(ui,'Use my location for destination').onclick();assert.equal(gps,1);ui.destroy();
});
test('local suggestion adds a point and stale suggestions or GPS cannot alter a destroyed editor',async()=>{
 let callback;const ui=createDeliveryPlaceInput({label:'Pickup',searchPlaces:async()=>[{name:'Station',displayName:'Central station',lat:60,lng:24}],geolocation:{getCurrentPosition(success){callback=success;}}});
 const input=find(ui,'Pickup address or meeting point');input.value='Station';input.oninput();await tick();find(ui,'Station · Central station').onclick();assert.deepEqual(ui.read(),{label:'Station',address:'Station',coordinates:[24,60]});
 find(ui,'Use my location for pickup').onclick();input.value='Changed';input.oninput();callback({coords:{longitude:25,latitude:61}});assert.equal(ui.read().coordinates,undefined);
 ui.destroy();callback({coords:{longitude:25,latitude:61}});assert.equal(ui.read().coordinates,undefined);
});
test('map opens lazily, choosing its center is explicit, and destroy closes the map',async()=>{
 let creates=0,closed=0;const listeners=new Map(),canvas=new Element('canvas');const raw={on(name,fn){listeners.set(name,fn);},off(name){listeners.delete(name);},getCanvas:()=>canvas,getCenter:()=>({lng:24,lat:60}),jumpTo(){}};
 const ui=createDeliveryPlaceInput({label:'Destination',value:{label:'Home',address:'Home entrance'},searchPlaces:async()=>[],createMap:async(_container,options)=>{creates++;const overlay=options.createOverlay(raw);return{resize(){},setDark:async()=>{},destroy:async()=>{closed++;overlay.destroy();}};}});
 assert.equal(creates,0);const details=all(ui.element).find(n=>n.tag==='details');details.open=true;await details.ontoggle();assert.equal(creates,1);assert.equal(ui.read().coordinates,undefined);
 find(ui,'Use map center').onclick();assert.deepEqual(ui.read().coordinates,[24,60]);ui.destroy();assert.equal(closed,1);
});
