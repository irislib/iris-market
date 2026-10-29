import test from 'node:test';
import assert from 'node:assert/strict';
import { ListingWindow, setupListingGrid } from '../src/listing-grid.ts';
const items = n => Array.from({length:n}, (_,id) => ({id:String(id),title:String(id)}));
function streamingGrid(t, loadOlder) {
  const saved=Object.getOwnPropertyDescriptor(globalThis,'window');
  globalThis.window={scrollY:0,addEventListener(){},removeEventListener(){}};
  const grid={children:[],setAttribute(){},insertBefore(node,anchor){node.remove();this.children.splice(anchor?this.children.indexOf(anchor):this.children.length,0,node);}};
  const button={};
  const view=setupListingGrid({grid,controls:{},button,status:{},cardKey:item=>item.id,olderState:()=>({hasMore:true}),loadOlder,
    makeCard:()=>({dataset:{},remove(){const index=grid.children.indexOf(this);if(index>=0)grid.children.splice(index,1);}})});
  t.after(()=>{view.dispose();if(saved)Object.defineProperty(globalThis,'window',saved);else delete globalThis.window;});
  return {grid,button,view};
}
test('the next window displays every arriving match before loading finishes',async t=>{
  let finish,requests=0;
  const {grid,button,view}=streamingGrid(t,()=>{requests++;return new Promise(resolve=>{finish=resolve;});});
  view.update(items(24),'search');
  const first=grid.children[0],pending=button.onclick();
  view.update(items(25),'search');
  assert.equal(grid.children.length,25,'first new match appears while the source is still busy');
  view.update(items(31),'search');
  assert.equal(grid.children.length,31);
  assert.equal(grid.children[0],first,'existing cards retain their DOM and position');
  assert.equal(button.disabled,true);
  finish();await pending;
  view.update(items(80),'search');
  assert.equal(grid.children.length,48,'completion does not reserve another page');
  assert.equal(requests,1);
});
test('an old load cannot block a new search or finish its loading state',async t=>{
  const finishes=[];
  const {grid,button,view}=streamingGrid(t,()=>new Promise(resolve=>finishes.push(resolve)));
  view.update(items(24),'first');const first=button.onclick();
  view.update(items(24),'second');
  assert.equal(button.disabled,false,'changing search detaches the previous load');
  const second=button.onclick();
  finishes[0]();await first;
  assert.equal(button.disabled,true,'the old completion cannot finish the new request');
  view.update(items(26),'second');assert.equal(grid.children.length,26);
  finishes[1]();await second;
  assert.equal(button.disabled,false);
});
test('initial window is bounded; load more retains the first page despite new rankings', () => {
  const view = new ListingWindow(24), all = items(80);
  assert.equal(view.update(all,'all').length,24);
  view.more();
  const next = view.update([...all].reverse(),'all');
  assert.deepEqual(next.slice(0,24),all.slice(0,24));
  assert.equal(next.length,48);
  assert.equal(new Set(next.map(x=>x.id)).size,48);
});
test('live updates replace values, remove sold items and append without moving surviving cards', () => {
  const view = new ListingWindow(3), all = items(4);
  view.update(all,'all'); view.pin();
  assert.deepEqual(view.update([{id:'new'}, {...all[2],title:'updated'},all[0],all[3]],'all').map(x=>x.id),['0','2','new']);
  assert.equal(view.update([{id:'new'}, {...all[2],title:'updated'},all[0],all[3]],'all')[1].title,'updated');
});
test('filter or sort change resets pagination; unpinned initial inventory can settle into ranking', () => {
  const view = new ListingWindow(2), all = items(6);
  view.update(all,'all');
  assert.deepEqual(view.update([...all].reverse(),'all').map(x=>x.id),['5','4']);
  view.more(); assert.equal(view.update(all,'all').length,4);
  assert.deepEqual(view.update(all,'search').map(x=>x.id),['0','1']);
  assert.equal(view.pinned,false);
});
test('duplicate coordinates never create duplicate cards', () => {
  const view = new ListingWindow(2);
  assert.deepEqual(view.update([{id:'a',title:'old'},{id:'a',title:'new'},{id:'b'}],'all'),[{id:'a',title:'new'},{id:'b'}]);
});

test('a short initial feed cannot pin rankings or load history until the reader scrolls', t => {
  const saved = Object.fromEntries(['window','document','IntersectionObserver'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(() => { for (const [key,descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } });
  let intersect, onScroll, observations = 0, historyRequests = 0;
  globalThis.window = {scrollY:0,addEventListener:(_,callback)=>{onScroll=callback;},removeEventListener:()=>{}};
  globalThis.document = {querySelector:()=>null};
  globalThis.IntersectionObserver = class {
    constructor(callback) { intersect = callback; }
    observe() { observations++; }
    unobserve() {}
    disconnect() {}
  };
  const grid = {
    children:[], setAttribute() {},
    insertBefore(node,anchor) {
      node.remove();
      this.children.splice(anchor ? this.children.indexOf(anchor) : this.children.length,0,node);
    },
  };
  const button = {};
  const view = setupListingGrid({
    grid,controls:{},button,status:{},cardKey:item=>item.id,
    makeCard:()=>{const node={dataset:{},remove(){const i=grid.children.indexOf(node);if(i>=0)grid.children.splice(i,1);}};return node;},
    olderState:()=>({hasMore:true}),loadOlder:async()=>{historyRequests++;},
  });
  view.update(items(2),'browse');
  intersect([{isIntersecting:true}]);
  assert.equal(historyRequests,0);
  assert.equal(observations,0);
  const ranked = items(60).reverse();
  view.update(ranked,'browse');
  assert.equal(grid.children[0].dataset.listingId,'59');
  assert.equal(grid.children.length,24);
  window.scrollY=150;onScroll();
  assert.equal(observations,1);
  intersect([{isIntersecting:true}]);
  assert.equal(grid.children.length,48);
  view.update(items(60),'browse');
  assert.equal(grid.children[0].dataset.listingId,'59');
  view.update(items(150),'browse');
  intersect([{isIntersecting:true}]);
  assert.equal(grid.children.length,72);
  intersect([{isIntersecting:true}]);
  assert.equal(grid.children.length,72, 'automatic loading stops after two batches');
  button.onclick();
  assert.equal(grid.children.length,96);
  intersect([{isIntersecting:true}]);
  assert.equal(grid.children.length,96, 'Load more does not restart endless scrolling');
  view.update(items(150),'new-search');
  assert.equal(grid.children.length,24);
  window.scrollY=150;onScroll();
  intersect([{isIntersecting:true}]);
  assert.equal(grid.children.length,48, 'a new search gets a fresh automatic allowance');
  view.dispose();
});
