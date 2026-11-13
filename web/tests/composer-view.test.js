import test from 'node:test';
import assert from 'node:assert/strict';
import {window,settle} from './support/dom.mjs';
import {flushSync} from 'svelte';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools/pure';

// The composer reads its form with FormData and dispatches DOM events, so use the DOM's own classes.
globalThis.FormData=window.FormData;globalThis.Event=window.Event;
if(typeof globalThis.Option!=='function')globalThis.Option=function(text='',value=text){const option=document.createElement('option');option.textContent=text;option.value=value;return option;};
const nativeClick=window.HTMLElement.prototype.click;
window.HTMLElement.prototype.click=function(){nativeClick.call(this);flushSync();};
const fire=(node,name)=>{node.dispatchEvent(new window.Event(name,{bubbles:true}));flushSync();};
const {setupComposer}=await import('../src/composer.ts');

const secret=generateSecretKey(),owner=getPublicKey(secret);
const postButton=document.createElement('button');postButton.id='post-button';document.body.append(postButton);

function fixture({canSign=true,preview=false}={}){
  const signed=[],published=[],shown=[];let ready;
  const account={
    state:()=>({canSign,ownerPubkey:owner,mode:'local'}),
    messaging:{signEvent:async draft=>{const event=finalizeEvent(draft,secret);signed.push(event);return event;},publishSignedEvents:async events=>{published.push(...events);return events.map(event=>({id:event.id,queued:true}));}},
    showAccount:options=>shown.push(options),closeAccount(){},onReady:callback=>{ready=callback;},
  };
  const page=document.createElement('main');document.body.append(page);
  const composer=setupComposer({account,page,isPreview:()=>preview,defaultCurrency:()=>'EUR',onPublished:(event,receipt,showSaved)=>published.push({event,receipt,showSaved})});
  const root=page.lastElementChild,$=selector=>root.querySelector(selector),field=name=>root.querySelector(`[name=${name}]`);
  const type=(name,value)=>{field(name).value=value;fire(field(name),'input');};
  // happy-dom misjudges the area picker's decimal step as invalid, so submit the form as the browser would after validation.
  const review=()=>{root.querySelector('form').dispatchEvent(new window.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:root.querySelector('#post-submit')}));flushSync();};
  return {composer,root,$,field,type,review,signed,published,shown,ready:()=>ready?.(),enableSigning(){canSign=true;}};
}

test('composer renders the editor in its original structure and opens from the post button',()=>{
  const f=fixture();
  assert.equal(f.root.className,'composer-dialog app-page');assert.equal(f.root.hidden,true);
  assert.deepEqual([...f.root.children].map(node=>node.id||node.tagName),['post-close','H2','post-form','post-preview','post-progress','post-error']);
  assert.equal(f.$('h2').textContent,'Post a listing');
  assert.equal(f.$('.post-side-tabs').nextElementSibling.className,'post-trade-tools','trade tools follow the listing type tabs');
  assert.equal(f.field('location').closest('label').nextElementSibling.className,'post-service-areas');
  assert.equal(f.$('.post-service-areas').lastElementChild.className,'service-area-picker');
  assert.equal(f.field('pinPrecision').value,'4');
  assert.deepEqual([...f.field('expiration').options].map(option=>option.value),['','1d','1w','30d','90d','365d','keep']);
  const keep=f.$('option[value=keep]');assert.equal(keep.hidden,true);assert.equal(keep.disabled,true);
  postButton.click();
  assert.equal(f.root.hidden,false);assert.equal(f.field('currency').value,'EUR');assert.equal(f.$('#post-preview').hidden,true);
  assert.equal(f.$('#post-transport-type').hidden,true);assert.equal(f.$('.post-service-areas').hidden,true);
});

test('listing type tabs act as one radio group',()=>{
  const f=fixture();f.composer.open();
  const [selling,buying]=f.root.querySelectorAll('[data-post-side]');
  assert.equal(selling.getAttribute('aria-checked'),'true');assert.equal(buying.getAttribute('aria-checked'),'false');assert.equal(buying.tabIndex,-1);
  buying.click();
  assert.equal(f.field('side').value,'request');assert.equal(buying.getAttribute('aria-checked'),'true');assert.equal(selling.tabIndex,-1);
  selling.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));flushSync();
  assert.equal(f.field('side').value,'offer');assert.equal(document.activeElement===selling,true);
});

test('transport category reveals its type and areas; delivery reveals destinations',()=>{
  const f=fixture();f.composer.open();
  f.field('category').value='transport';fire(f.field('category'),'change');
  assert.equal(f.$('#post-transport-type').hidden,false);assert.equal(f.field('transportType').disabled,false);assert.equal(f.$('.post-service-areas').hidden,false);
  const fields=f.$('#post-delivery-fields');assert.equal(fields.hidden,true);
  f.field('shippingEnabled').checked=true;fire(f.field('shippingEnabled'),'change');
  assert.equal(fields.hidden,false);assert.equal(fields.disabled,false);
  const add=f.$('#post-country-add');add.value='FI';fire(add,'change');add.value='SE';fire(add,'change');
  assert.equal(add.value,'');assert.equal(add.querySelector('option[value=FI]').disabled,true);
  const chips=[...f.$('#post-delivery-countries').children];
  assert.deepEqual(chips.map(chip=>chip.getAttribute('aria-label')),['Remove Finland','Remove Sweden']);
  chips[0].click();
  assert.deepEqual([...f.$('#post-delivery-countries').children].map(chip=>chip.textContent),['Sweden ×']);assert.equal(add.querySelector('option[value=FI]').disabled,false);
});

test('selected files are listed and removable before upload',()=>{
  const f=fixture();f.composer.open();
  const input=f.$('#post-files');
  Object.defineProperty(input,'files',{configurable:true,get:()=>[new File(['a'],'a.pdf',{type:'application/pdf'}),new File(['b'],'b.pdf',{type:'application/pdf'})]});
  fire(input,'change');
  assert.deepEqual([...f.$('#post-file-list').children].map(row=>row.querySelector('span').textContent),['a.pdf','b.pdf']);
  f.root.querySelector('[aria-label="Remove a.pdf"]').click();
  assert.deepEqual([...f.$('#post-file-list').children].map(row=>row.textContent),['b.pdfRemove']);
  Object.defineProperty(input,'files',{configurable:true,get:()=>Array.from({length:4},(_,index)=>new File(['x'],index+'.pdf'))});
  fire(input,'change');
  assert.equal(f.$('#post-error').textContent,'Choose up to four photos or files.');
});

test('preview never publishes; only the explicit Publish control signs and queues the listing',async()=>{
  const f=fixture();f.composer.open();
  f.type('title','Oak desk');f.type('price','95');f.type('description','Solid oak.');
  f.review();
  assert.equal(f.$('#post-error').textContent,'');assert.equal(f.$('#post-form').hidden,true);assert.equal(f.$('#post-preview').hidden,false);assert.equal(f.root.classList.contains('showing-preview'),true);
  assert.equal(f.$('h2').textContent,'Preview');assert.equal(document.activeElement===f.$('h2'),true);
  assert.equal(f.$('#post-preview-content h1').textContent,'Oak desk');assert.equal(f.$('#post-publish').textContent,'Publish listing');
  assert.equal(f.signed.length,0);assert.equal(f.published.length,0);
  f.$('#post-edit').click();
  assert.equal(f.$('#post-form').hidden,false);assert.equal(f.$('#post-preview-content').children.length,0);assert.equal(f.$('h2').textContent,'Post a listing');
  assert.equal(f.field('title').value,'Oak desk');
  f.review();f.$('#post-publish').click();
  assert.equal(f.$('#post-publish').textContent,'Saving…');assert.equal(f.$('#post-publish').disabled,true);assert.equal(f.field('title').disabled,true);
  await settle();flushSync();
  assert.equal(f.signed.length,1);assert.equal(f.published.length,2);
  const [event,{receipt,showSaved}]=f.published;assert.equal(event.id,f.signed[0].id);assert.equal(receipt.queued,true);assert.equal(showSaved,true);
  assert.equal(f.root.hidden,true);assert.equal(f.field('title').value,'');assert.equal(f.field('title').disabled,false);
  assert.equal(f.$('#post-form').hidden,false);assert.equal(f.$('#post-publish').textContent,'Publish listing');
});

test('publishing without a signer asks for an account and resumes the composer when ready',()=>{
  const f=fixture({canSign:false});f.composer.open();
  f.type('title','Lamp');f.review();f.$('#post-publish').click();
  assert.deepEqual(f.shown,[{posting:true}]);assert.equal(f.signed.length,0);
  f.composer.hide({preservePending:true});assert.equal(f.root.hidden,true);
  f.ready();assert.equal(f.root.hidden,false);assert.equal(f.$('#post-preview').hidden,false,'the reviewed draft is still waiting for Publish');
});

test('preview fixtures cannot be posted to the live market',()=>{
  const f=fixture({preview:true});f.composer.open();
  f.type('title','Lamp');f.review();f.$('#post-publish').click();
  assert.equal(f.$('#post-error').textContent,'Switch to the live market to post.');assert.equal(f.signed.length,0);
});

test('editing an own listing fills the form and keeps its expiry by default',()=>{
  const f=fixture(),listing={author:owner,identifier:'desk-1',side:'request',title:'Desk',description:'Wanted',price:'10',currency:'EUR',location:'Helsinki',category:'home',tags:['home','oak'],originalTags:[['shipping_option','30406:x:y']],createdAt:1};
  f.composer.edit({...listing,author:'someone-else'});assert.equal(f.root.hidden,true);
  f.composer.edit(listing);
  assert.equal(f.$('h2').textContent,'Edit listing');assert.equal(f.field('side').value,'request');assert.equal(f.field('title').value,'Desk');assert.equal(f.field('tags').value,'oak');
  const keep=f.$('option[value=keep]');assert.equal(f.field('expiration').value,'keep');assert.equal(keep.hidden,false);assert.equal(keep.disabled,false);assert.match(keep.textContent,/^Keep current \(/);
  assert.equal(f.$('#post-remove-delivery').hidden,false);assert.equal(f.$('#post-delivery-hint').textContent,'Existing delivery options are kept unless you change these fields.');
  f.$('#post-remove-delivery').click();
  assert.equal(f.$('#post-remove-delivery').hidden,true);assert.equal(f.$('#post-delivery-hint').textContent,'Existing delivery will be removed when you publish.');
  assert.equal(f.composer.prefill({side:'offer',category:'other',title:'Other'}),false);
  assert.equal(f.$('#post-error').textContent,'Your current draft is still here. Finish it before starting another listing.');assert.equal(f.field('title').value,'Desk');
});

test('a prefilled announcement stays an editable draft',()=>{
  const f=fixture();
  assert.equal(f.composer.prefill({side:'request',category:'transport',title:'Ride to Tampere',tags:['passenger']}),true);
  assert.equal(f.root.hidden,false);assert.equal(f.field('side').value,'request');assert.equal(f.field('title').value,'Ride to Tampere');
  assert.equal(f.field('transportType').value,'passenger');assert.equal(f.$('#post-transport-type').hidden,false);
  assert.equal(f.$('#post-form').hidden,false);assert.equal(f.signed.length,0);assert.equal(f.published.length,0);
});
