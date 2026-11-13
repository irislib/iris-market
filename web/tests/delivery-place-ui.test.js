import test from 'node:test';
import assert from 'node:assert/strict';
import {window,settle} from './support/dom.mjs';
import {flushSync} from 'svelte';
import {createDeliveryPlaceInput} from '../src/delivery-place-ui.ts';
// Assertions follow clicks and input events directly, so apply Svelte's updates synchronously.
const nativeClick=window.HTMLElement.prototype.click;
window.HTMLElement.prototype.click=function(){nativeClick.call(this);flushSync();};
const fire=(node,name)=>{node.dispatchEvent(new window.Event(name,{bubbles:true}));flushSync();};
document.documentElement.dataset.appearance='light';
const all=node=>[node,...node.querySelectorAll('*')];
// The innermost element whose accessible label or whole text matches.
const find=(ui,label)=>all(ui.element).filter(n=>n.getAttribute('aria-label')===label||n.textContent===label).at(-1);
const tick=()=>new Promise(resolve=>setTimeout(resolve,280));
test('private point requires address, never auto-locates, and typing drops previous coordinates',async()=>{
 let gps=0,maps=0;const ui=createDeliveryPlaceInput({label:'Destination',value:{label:'Home',address:'Old address',coordinates:[24,60]},geolocation:{getCurrentPosition(){gps++;}},createMap:async()=>{maps++;},searchPlaces:async()=>[]});
 assert.equal(gps,0);assert.equal(maps,0);assert.deepEqual(ui.read().coordinates,[24,60]);
 const input=find(ui,'Destination address or meeting point');input.value='New address';fire(input,'input');assert.equal(ui.read().coordinates,undefined);
 input.value='';fire(input,'input');assert.throws(()=>ui.read(),/Enter the destination/);
 find(ui,'Use my location for destination').click();assert.equal(gps,1);ui.destroy();
});
test('local suggestion adds a point and stale suggestions or GPS cannot alter a destroyed editor',async()=>{
 let callback;const ui=createDeliveryPlaceInput({label:'Pickup',searchPlaces:async()=>[{name:'Station',displayName:'Central station',lat:60,lng:24}],geolocation:{getCurrentPosition(success){callback=success;}}});
 const input=find(ui,'Pickup address or meeting point');input.value='Station';fire(input,'input');await tick();find(ui,'Station · Central station').click();assert.deepEqual(ui.read(),{label:'Station',address:'Station',coordinates:[24,60]});
 find(ui,'Use my location for pickup').click();input.value='Changed';fire(input,'input');callback({coords:{longitude:25,latitude:61}});assert.equal(ui.read().coordinates,undefined);
 ui.destroy();callback({coords:{longitude:25,latitude:61}});assert.equal(ui.read().coordinates,undefined);
});
test('map opens lazily, choosing its center is explicit, and destroy closes the map',async()=>{
 let creates=0,closed=0;const listeners=new Map(),canvas=document.createElement('canvas');const raw={on(name,fn){listeners.set(name,fn);},off(name){listeners.delete(name);},getCanvas:()=>canvas,getCenter:()=>({lng:24,lat:60}),jumpTo(){}};
 const ui=createDeliveryPlaceInput({label:'Destination',value:{label:'Home',address:'Home entrance'},searchPlaces:async()=>[],createMap:async(_container,options)=>{creates++;const overlay=options.createOverlay(raw);return{resize(){},setDark:async()=>{},destroy:async()=>{closed++;overlay.destroy();}};}});
 assert.equal(creates,0);const details=all(ui.element).find(n=>n.tagName==='DETAILS');details.open=true;fire(details,'toggle');await settle();assert.equal(creates,1);assert.equal(ui.read().coordinates,undefined);
 find(ui,'Use map center').click();assert.deepEqual(ui.read().coordinates,[24,60]);ui.destroy();assert.equal(closed,1);
});
test('place selected while the native map loads is centered and retained, and an older suggestion cannot replace it',async()=>{
 const drafts=[],jumps=[],listeners=new Map(),canvas=document.createElement('canvas');let attach;
 const raw={on(name,fn){listeners.set(name,fn);},off(name){listeners.delete(name);},getCanvas:()=>canvas,getCenter:()=>({lng:0,lat:0}),jumpTo(value){jumps.push(value);}};
 const ui=createDeliveryPlaceInput({label:'Meeting point',onDraftChange:value=>drafts.push(value),searchPlaces:async query=>[{name:query,context:'Finland',lat:query==='Helsinki'?60.17:61.5,lng:query==='Helsinki'?24.94:23.76}],createMap:(_container,options)=>new Promise(resolve=>{attach=()=>{const overlay=options.createOverlay(raw);resolve({resize(){},setDark:async()=>{},destroy:async()=>overlay.destroy()});};})});
 const loading=ui.showMap();assert.equal(all(ui.element).find(n=>n.tagName==='DETAILS').open,true);
 const input=find(ui,'Meeting point address or meeting point');input.value='Helsinki';fire(input,'input');await tick();const old=find(ui,'Helsinki · Finland');old.click();
 assert.deepEqual(drafts.at(-1),{label:'Helsinki',address:'Helsinki, Finland',coordinates:[24.94,60.17]});
 attach();await loading;assert.deepEqual(jumps.at(-1),{center:[24.94,60.17],zoom:15});
 input.value='Tampere';fire(input,'input');await tick();find(ui,'Tampere · Finland').click();old.click();
 assert.deepEqual(ui.read(),{label:'Tampere',address:'Tampere, Finland',coordinates:[23.76,61.5]});assert.deepEqual(jumps.at(-1),{center:[23.76,61.5],zoom:15});
 ui.setValue(ui.read());assert.deepEqual(ui.read().coordinates,[23.76,61.5]);ui.destroy();
});
