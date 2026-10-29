import test from 'node:test';
import assert from 'node:assert/strict';
import {renderListingPage} from '../src/listing-page.ts';
import {imageUrl} from '../src/media.ts';
import {art} from '../src/art.ts';

class Element {
  constructor(tag,text=''){this.tag=tag;this.tagName=tag.toUpperCase();this.style={};this.textContent=text;this.children=[];this.dataset={};this.attributes=new Map();}
  append(...nodes){this.children.push(...nodes);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  set innerHTML(_value){throw Error('Listing event text must never be interpreted as markup');}
}
const document={createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)};
const copied=[];
Object.defineProperties(globalThis,{document:{value:document,configurable:true},navigator:{value:{clipboard:{writeText:async text=>copied.push(text)}},configurable:true}});
const all=node=>[node,...node.children.flatMap(all)];
const listing={title:'Oak desk',side:'offer',category:'home',price:'95',currency:'EUR',location:'Helsinki',description:'Solid oak.',author:'1'.repeat(64),id:'desk',imageUrl:'https://photos.example/desk.gif'};
const options={priceNode:()=>new Element('p','€95'),authorRow:()=>new Element('span','Seller')};

test('public raw event is collapsed, inert and copies only original wire fields',async()=>{
  const wire={id:'a'.repeat(64),pubkey:listing.author,created_at:123,kind:30402,tags:[['d','desk'],['title','<img onerror=alert(1)>']],content:'</code><script>alert(1)</script>',sig:'b'.repeat(128)};
  const root=renderListingPage({...listing,rawEvent:{...wire,privateState:'never export'}},options),nodes=all(root);
  const details=nodes.find(node=>node.tag==='details');assert(details);assert.notEqual(details.open,true);assert.equal(root.children.at(-1),details);
  assert.equal(details.children[0].textContent,'Raw event');
  const code=nodes.find(node=>node.tag==='code');assert.deepEqual(JSON.parse(code.textContent),wire);assert(!code.textContent.includes('privateState'));
  assert.equal(nodes.some(node=>node.tag==='script'),false);
  await nodes.find(node=>node.textContent==='Copy event').onclick();assert.deepEqual(JSON.parse(copied.at(-1)),wire);
  assert.equal(nodes.find(node=>node.attributes.get('role')==='status').textContent,'Copied');
});

test('drafts, sample listings and records without a wire event have no raw-event controls',()=>{
  for(const extra of [{},{isPreview:true},{draftPreview:true}]){
    const item=Object.keys(extra).length?{...listing,rawEvent:{content:'sample'}}:listing;
    const nodes=all(renderListingPage(item,{...options,...extra}));assert.equal(nodes.some(node=>node.tag==='details'),false);
  }
});

test('images start still; only explicit original/pause actions change their source',()=>{
  const nodes=all(renderListingPage(listing,options)),image=nodes.find(node=>node.tag==='img'),button=nodes.find(node=>node.className==='image-original-toggle');
  assert.equal(image.src,imageUrl(listing.imageUrl,{width:1200,static:true}));assert(button);assert.equal(button.attributes.get('aria-label'),'Show original image');
  button.onclick();assert.equal(image.src,imageUrl(listing.imageUrl,{width:1200}));assert.equal(button.attributes.get('aria-pressed'),'true');assert.equal(button.attributes.get('aria-label'),'Pause image');
  button.onclick();assert.equal(image.src,imageUrl(listing.imageUrl,{width:1200,static:true}));assert.equal(button.attributes.get('aria-pressed'),'false');
  image.onerror();assert.match(image.src,/\/f:png\//,'retry remains a static proxy request');image.onerror();assert.equal(image.src,art(listing),'a failed still cannot silently fetch the original');
});

test('missing images have no original control and draft raster blobs remain local',()=>{
  const missing=all(renderListingPage({...listing,imageUrl:'javascript:alert(1)'},options));assert.equal(missing.some(node=>node.className==='image-original-toggle'),false);
  const draft=all(renderListingPage(listing,{...options,draftPreview:true,localImage:'blob:local-photo'}));assert.equal(draft.find(node=>node.tag==='img').src,'blob:local-photo');assert.equal(draft.some(node=>node.tag==='button'),false);
});


test('proxy-off hero pauses on the shared canvas and fetches an animated original only after selecting it',()=>{
  Object.defineProperty(globalThis,'window',{value:{localStorage:{getItem:()=>JSON.stringify({useProxy:false})}},configurable:true});
  try {
    const nodes=all(renderListingPage(listing,options)),canvas=nodes.find(node=>node.tag==='canvas'),image=nodes.find(node=>node.tag==='img'),button=nodes.find(node=>node.className==='image-original-toggle');
    assert(canvas);assert.equal(canvas.attributes.get('aria-label'),listing.title);assert.equal(canvas.hidden,false);assert.equal(image.hidden,true);assert.equal(image.src,undefined);
    button.onclick();assert.equal(canvas.hidden,true);assert.equal(image.hidden,false);assert.equal(image.src,listing.imageUrl);
    button.onclick();assert.equal(canvas.hidden,false);assert.equal(image.hidden,true);assert.equal(button.attributes.get('aria-pressed'),'false');
  } finally {delete globalThis.window;}
});
