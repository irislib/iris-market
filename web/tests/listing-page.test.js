import test from 'node:test';
import assert from 'node:assert/strict';
import {window} from './support/dom.mjs';
import {flushSync} from 'svelte';

const copied=[];
Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});
// Assertions follow clicks directly, so apply Svelte's updates synchronously.
const nativeClick=HTMLElement.prototype.click;
HTMLElement.prototype.click=function(){nativeClick.call(this);flushSync();};
const {renderListingPage}=await import('../src/listing-page.ts');
const {imageUrl}=await import('../src/media.ts');
const {art}=await import('../src/art.ts');

const all=node=>[node,...node.querySelectorAll('*')];
const find=(node,text)=>all(node).filter(element=>element.textContent.trim()===text).at(-1);
const listing={title:'Oak desk',side:'offer',category:'home',price:'95',currency:'EUR',location:'Helsinki',description:'Solid oak.',author:'1'.repeat(64),id:'desk',imageUrl:'https://photos.example/desk.gif'};
const priceNode=(_listing,className)=>{const price=document.createElement('p');price.className=className;price.textContent='€95';return price;};
const options={priceNode,authorRow:()=>{const row=document.createElement('span');row.textContent='Seller';return row;}};
const render=(item,extra={})=>{const root=renderListingPage(item,{...options,...extra});document.body.replaceChildren(root);return root;};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('public raw event is collapsed, inert and copies only original wire fields',async()=>{
  const wire={id:'a'.repeat(64),pubkey:listing.author,created_at:123,kind:30402,tags:[['d','desk'],['title','<img onerror=alert(1)>']],content:'</code><script>alert(1)</script>',sig:'b'.repeat(128)};
  const root=render({...listing,rawEvent:{...wire,privateState:'never export'}});
  const details=root.querySelector('details');assert(details);assert.equal(details.open,false);assert.equal(root.lastElementChild===details,true);
  assert.equal(details.querySelector('summary').textContent,'Raw event');
  const code=root.querySelector('code');assert.deepEqual(JSON.parse(code.textContent),wire);assert(!code.textContent.includes('privateState'));
  assert.equal(root.querySelector('script'),null,'Listing event text must never be interpreted as markup');
  assert.equal(root.querySelector('[onerror]'),null);
  find(root,'Copy event').click();await tick();assert.deepEqual(JSON.parse(copied.at(-1)),wire);
  flushSync();assert.equal(root.querySelector('[role=status]').textContent,'Copied');
});

test('drafts, sample listings and records without a wire event have no raw-event controls',()=>{
  for(const extra of [{},{isPreview:true},{draftPreview:true}]){
    const item=Object.keys(extra).length?{...listing,rawEvent:{content:'sample'}}:listing;
    assert.equal(render(item,extra).querySelector('details'),null);
  }
});

test('images start still; only explicit original/pause actions change their source',()=>{
  const root=render(listing),image=root.querySelector('img'),button=root.querySelector('.image-original-toggle');
  assert.equal(image.src,imageUrl(listing.imageUrl,{width:1200,static:true}));assert(button);assert.equal(button.getAttribute('aria-label'),'Show original image');
  button.click();assert.equal(image.src,imageUrl(listing.imageUrl,{width:1200}));assert.equal(button.getAttribute('aria-pressed'),'true');assert.equal(button.getAttribute('aria-label'),'Pause image');
  button.click();assert.equal(image.src,imageUrl(listing.imageUrl,{width:1200,static:true}));assert.equal(button.getAttribute('aria-pressed'),'false');
  image.onerror();assert.match(image.src,/\/f:png\//,'retry remains a static proxy request');image.onerror();assert.equal(image.src,art(listing),'a failed still cannot silently fetch the original');
});

test('a failed original falls back to artwork and resets the control',()=>{
  const root=render(listing),image=root.querySelector('img'),button=root.querySelector('.image-original-toggle');
  button.click();image.onerror();flushSync();
  assert.equal(image.src,art(listing));assert.equal(button.getAttribute('aria-pressed'),'false');
});

test('missing images have no original control and draft raster blobs remain local',()=>{
  assert.equal(render({...listing,imageUrl:'javascript:alert(1)'}).querySelector('.image-original-toggle'),null);
  const draft=render(listing,{draftPreview:true,localImage:'blob:local-photo'});assert.equal(draft.querySelector('img').getAttribute('src'),'blob:local-photo');assert.equal(draft.querySelector('button'),null);
});

test('proxy-off hero pauses on the shared canvas and fetches an animated original only after selecting it',()=>{
  window.localStorage.setItem('iris-market-image-settings',JSON.stringify({useProxy:false}));
  try {
    const root=render(listing),canvas=root.querySelector('canvas'),image=root.querySelector('img'),button=root.querySelector('.image-original-toggle');
    assert(canvas);assert.equal(canvas.getAttribute('aria-label'),listing.title);assert.equal(canvas.hidden,false);assert.equal(image.hidden,true);assert.equal(image.getAttribute('src'),null);
    button.click();assert.equal(canvas.hidden,true);assert.equal(image.hidden,false);assert.equal(image.src,listing.imageUrl);
    button.click();assert.equal(canvas.hidden,false);assert.equal(image.hidden,true);assert.equal(button.getAttribute('aria-pressed'),'false');
  } finally {window.localStorage.clear();}
});

test('details and draft previews show relative expiry while Never adds no expiry label',t=>{
  const now=1_700_000_000;t.mock.method(Date,'now',()=>now*1000);
  for(const draftPreview of [false,true]) {
    const time=[...render({...listing,expiration:now+604800},{draftPreview}).querySelectorAll('time')].at(-1);
    assert.equal(time.textContent,'Expires in 1 week');assert.equal(time.dateTime,new Date((now+604800)*1000).toISOString());
  }
  assert.equal(all(render(listing)).some(node=>node.textContent?.startsWith('Expires')),false);
});

test('owners edit instead of buying; buyers respond to requests; saving reports state',()=>{
  const calls=[];
  const buyer=render({...listing,side:'request'},{onBuy:()=>calls.push('buy'),onSave:()=>calls.push('save'),saved:true});
  find(buyer,'Respond').click();const save=find(buyer,'♥ Saved');assert.equal(save.getAttribute('aria-pressed'),'true');save.click();
  const own=render(listing,{owner:listing.author,onEdit:()=>calls.push('edit')});
  assert.equal(find(own,'Buy'),undefined);find(own,'Edit listing').click();
  assert.deepEqual(calls,['buy','save','edit']);
  const order=['eyebrow','H1','detail-price','detail-place','SPAN','listing-dates','detail-actions','detail-description'];
  const copy=[...render(listing).querySelector('.detail-copy').children].filter(node=>!node.hidden||node.tagName!=='SPAN');
  assert.deepEqual(copy.map(node=>order.find(name=>node.tagName===name||node.classList.contains(name))).filter(Boolean),['eyebrow','H1','detail-price','detail-place','SPAN','detail-actions','detail-description']);
});

test('bitcoin quotes without photos are quote-only; failed closes stay retryable; external orders list terms',async()=>{
  const escrow={trade:'bitcoin_fiat',sats:12000,method:'sepa'};
  const root=render({...listing,imageUrl:undefined,escrow},{owner:listing.author,onCloseBitcoin:async()=>{throw Error('Relay refused');}});
  assert.equal(root.className,'detail-layout detail-quote-only');assert.equal(root.querySelector('.detail-media').hidden,true);
  assert.equal(root.querySelector('.eyebrow').textContent,'Selling bitcoin');
  const close=root.querySelector('.account-option button');close.click();assert.equal(close.disabled,true);
  await tick();flushSync();assert.equal(root.querySelector('[role=alert]').textContent,'Relay refused');assert.equal(close.disabled,false);
  const order=render({...listing,imageUrl:undefined,externalOrder:{platform:'Peach',methods:'SEPA',layer:'onchain',quantity:5000,premium:null}});
  assert.deepEqual([...order.querySelectorAll('dt')].map(node=>node.textContent),['Payment method','Settlement','Bitcoin amount']);
  assert.equal(order.querySelector('.detail-place'),null);assert.equal(order.querySelector('.detail-description'),null);assert.equal(find(order,'Buy'),undefined);
});
