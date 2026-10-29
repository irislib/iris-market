import test from 'node:test';
import assert from 'node:assert/strict';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attributes=new Map();this.hidden=false;this.textContent='';this.className='';this.value='';}
  append(...children){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  replaceChildren(...children){for(const child of [...this.children])child.remove();this.append(...children);}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='[data-person-relationship]'&&'personRelationship'in child.dataset?[child]:[]),...child.querySelectorAll(selector)]);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=undefined;}
  click(){if(!this.disabled)return this.onclick?.();}
  focus(){document.activeElement=this;}
}
const document={body:new Element('body'),createElement:tag=>new Element(tag),querySelectorAll:()=>[]};
Object.defineProperties(globalThis,{document:{value:document,configurable:true},window:{value:new EventTarget(),configurable:true}});
const {setupProfileReviews}=await import('../src/reviews-ui.ts');
const {buildReviewDraft,parseReview}=await import('../src/reviews.ts');
const {setupPeople}=await import('../src/people.ts');setupPeople({getRelays:()=>[],isPreview:()=>true});
const all=node=>[node,...node.children.flatMap(all)],find=(node,text)=>all(node).find(child=>child.textContent===text);
const attr=(node,name,value)=>all(node).find(child=>child.attributes.get(name)===value);
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(options={}){
  const secret=generateSecretKey(),owner=getPublicKey(secret),target=getPublicKey(generateSecretKey());let account={owner,canSign:true,pending:[]};
  const signed=[],published=[];
  const ui=setupProfileReviews({target,getAccount:()=>account,query:async()=>({events:[],complete:true}),publish:async draft=>{published.push(draft);const event=finalizeEvent(draft,secret);signed.push(event);account.pending=[event];return{event,delivery:'queued'};},...options});
  return{ui,root:ui.element,owner,target,secret,published,signed,account:()=>account,setAccount:value=>{account=value;ui.refresh();}};
}

test('review composer explicitly publishes, renders plain text, and keeps local queued status without a relay response',async()=>{
  const f=fixture();await settle();await find(f.root,'Write review').click();
  assert(find(f.root,'Your rating and review will be public.'));assert.equal(f.published.length,0);
  const form=all(f.root).find(node=>node.tag==='form'),text=all(form).find(node=>node.tag==='textarea');
  assert.equal(find(form,'Publish review').disabled,true);attr(form,'aria-label','4 stars').click();text.value='<img src=x onerror=alert(1)> Carefully packed.';
  await form.onsubmit({preventDefault(){}});assert.equal(f.published.length,1);assert.equal(form.hidden,true);
  assert(find(f.root,'Waiting to publish'));assert.equal(find(f.root,text.value).tag,'p');assert.match(f.ui.summary().label,/4.0.*1 review/);
  assert.equal(all(f.root).some(node=>node.innerHTML),false);assert.equal(parseReview(f.signed[0]).author,f.owner);f.ui.close();
});

test('editing a review preserves its subject and original date, replacing one author rating in the summary',async()=>{
  const f=fixture();await settle();find(f.root,'Write review').click();attr(f.root,'aria-label','2 stars').click();
  const form=all(f.root).find(node=>node.tag==='form');await form.onsubmit({preventDefault(){}});const first=parseReview(f.signed[0]);
  find(f.root,'Edit review').click();attr(f.root,'aria-label','5 stars').click();await form.onsubmit({preventDefault(){}});const second=parseReview(f.signed[1]);
  assert.equal(second.subject,first.subject);assert.equal(second.createdAt,first.createdAt);assert(second.updatedAt>first.updatedAt);
  assert.equal(f.ui.summary().count,1);assert.match(f.ui.summary().label,/5.0/);f.ui.close();
});

test('profile lock clears an open draft; signed-out and own-profile views cannot publish',async()=>{
  let signedIn=0;const f=fixture({onSignIn:()=>signedIn++});await settle();find(f.root,'Write review').click();
  const form=all(f.root).find(node=>node.tag==='form'),text=all(form).find(node=>node.tag==='textarea');text.value='Unsubmitted note';
  f.setAccount({canSign:false,pending:[]});assert.equal(form.hidden,true);assert.equal(text.value,'');find(f.root,'Write review').click();assert.equal(signedIn,1);assert.equal(f.published.length,0);f.ui.close();
  const owner=getPublicKey(generateSecretKey()),self=setupProfileReviews({target:owner,getAccount:()=>({owner,canSign:true}),query:async()=>({events:[],complete:true}),publish:async()=>{throw Error('Must not publish');}});
  assert.equal(find(self.element,'Write review').hidden,true);find(self.element,'Write review').click();assert.equal(all(self.element).find(node=>node.tag==='form').hidden,true);self.close();
});

test('an incomplete empty lookup is not presented as proof of no reviews and supports retry',async()=>{
  let complete=false;const f=fixture({query:async()=>({events:[],complete})});await settle();
  assert(find(f.root,'Some reviews may be unavailable.'));assert.equal(find(f.root,'No reviews yet.'),undefined);assert.equal(f.ui.summary().label,'Reviews');
  complete=true;find(f.root,'Retry').click();await settle();assert(find(f.root,'No reviews yet.'));f.ui.close();
});

test('late lookups are aborted on navigation and do not replace an open review draft',async()=>{
  let resolve,signal;const f=fixture({query:(_filters,options)=>{signal=options.signal;return new Promise(done=>resolve=done);}});await settle();
  find(f.root,'Write review').click();const form=all(f.root).find(node=>node.tag==='form'),text=all(form).find(node=>node.tag==='textarea');text.value='Keep this draft';
  resolve({events:[],complete:true});await settle();assert.equal(form.hidden,false);assert.equal(text.value,'Keep this draft');
  f.ui.close();assert.equal(signal.aborted,true);assert.equal(text.value,'');
});

test('a validly signed but changed publishing receipt is rejected and leaves the form retryable',async()=>{
  const secret=generateSecretKey(),owner=getPublicKey(secret),target=getPublicKey(generateSecretKey());
  const ui=setupProfileReviews({target,getAccount:()=>({owner,canSign:true}),query:async()=>({events:[],complete:true}),publish:async draft=>({delivery:'queued',event:finalizeEvent({...draft,tags:draft.tags.map(tag=>tag[0]==='rating'?['rating','1','5']:tag)},secret)})});
  await settle();find(ui.element,'Write review').click();attr(ui.element,'aria-label','5 stars').click();const form=all(ui.element).find(node=>node.tag==='form');
  await form.onsubmit({preventDefault(){}});assert.equal(form.hidden,false);assert(find(form,'The signer returned a different review.'));assert.equal(ui.summary().count,0);ui.close();
});
