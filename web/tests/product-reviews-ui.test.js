import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes=new Map();this.hidden=false;this.textContent='';this.className='';}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='[data-person-relationship]'&&'personRelationship'in child.dataset?[child]:[]),...child.querySelectorAll(selector)]);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
  click(){if(!this.disabled)return this.onclick?.();}
}
const document={body:new Element('body'),createElement:tag=>new Element(tag),querySelectorAll:()=>[]};
Object.defineProperties(globalThis,{document:{value:document,configurable:true},window:{value:new EventTarget(),configurable:true}});
const {setupProductReviews}=await import('../src/product-reviews-ui.ts');
const {setupPeople}=await import('../src/people.ts');setupPeople({getRelays:()=>[],isPreview:()=>true});
const all=node=>[node,...node.children.flatMap(all)],find=(node,text)=>all(node).find(child=>child.textContent===text);
const secret=new Uint8Array(32).fill(21),author=getPublicKey(secret),seller=getPublicKey(new Uint8Array(32).fill(22));
const target=`30402:${seller}:table`,listing={id:`${seller}:table`,author:seller};
const review=(extra=[],rating='1',content='<img src=x onerror=alert(1)> Sturdy table.')=>finalizeEvent({kind:31555,created_at:Math.floor(Date.now()/1000),content,tags:[['d',`a:${target}`],['rating',rating,'thumb'],['rating','0.8','quality'],...extra]},secret);
function queryFor(value){return async filters=>({events:filters[0].kinds[0]===5?[]:[value],complete:true});}

test('read-only product panel renders recommendations, identity and safe text without stars or publishing',async()=>{
  const value=review();let opened;
  const ui=setupProductReviews({listing,query:queryFor(value),onProfile:pubkey=>opened=pubkey});
  await ui.start();assert(find(ui.element,'Product reviews'));assert(find(ui.element,'Recommends this item'));
  assert(find(ui.element,'1 review · Purchases not verified'));assert.equal(find(ui.element,value.content).tag,'p');assert(find(ui.element,'quality: 80%'));
  const person=all(ui.element).find(child=>child.dataset.person===author);person.click();assert.equal(opened,author);
  assert.equal(all(ui.element).some(child=>child.innerHTML||child.tag==='form'||/[★☆]/.test(child.textContent)),false);
  ui.destroy();
});

test('fractional thumb values are labeled scores and never become counts or stars',async()=>{
  const ui=setupProductReviews({listing,query:queryFor(review([],'0.4'))});await ui.start();
  assert(find(ui.element,'Recommendation score: 40%'));assert.equal(find(ui.element,'Doesn’t recommend this item'),undefined);ui.destroy();
});

test('incomplete lookup never claims no reviews; retry is bounded and complete empty results are clear',async()=>{
  let complete=false,calls=0;
  const ui=setupProductReviews({listing,query:async()=>{calls++;return{events:[],complete};}});await ui.start();
  assert(find(ui.element,'Some reviews may be unavailable.'));assert.equal(find(ui.element,'No product reviews found.'),undefined);
  complete=true;await ui.refresh();assert.equal(calls,2);assert(find(ui.element,'No product reviews found.'));ui.destroy();
});

test('navigation aborts a pending query and late results cannot repopulate the detached panel',async()=>{
  let done,signal;const ui=setupProductReviews({listing,query:(_filters,options)=>{signal=options.signal;return new Promise(resolve=>done=resolve);}});
  const pending=ui.start();ui.destroy();assert(signal.aborted);done({events:[review()],complete:true});await pending;
  assert.equal(find(ui.element,'Recommends this item'),undefined);assert.equal(all(ui.element).some(child=>child.className==='review-card'),false);
});

test('visible expired reviews disappear without a refresh and cleanup cancels the timer',async t=>{
  const time=Date.now();t.mock.timers.enable({apis:['Date','setTimeout'],now:time});
  const ui=setupProductReviews({listing,query:queryFor(review([['expiration',String(Math.floor(time/1000)+2)]]))});await ui.start();
  assert(find(ui.element,'Recommends this item'));t.mock.timers.tick(2100);assert.equal(find(ui.element,'Recommends this item'),undefined);
  assert(find(ui.element,'No product reviews found.'));ui.destroy();
});

test('preview and unavailable readers never trigger public queries',async()=>{
  let calls=0;const ui=setupProductReviews({listing,preview:true,query:async()=>{calls++;return{events:[]};}});await ui.start();assert.equal(calls,0);assert(ui.element.hidden);ui.destroy();
  const unavailable=setupProductReviews({listing});await unavailable.start();assert(find(unavailable.element,'Reviews are unavailable.'));unavailable.destroy();
  assert.throws(()=>setupProductReviews({listing:{...listing,author}}),/author/);
});
