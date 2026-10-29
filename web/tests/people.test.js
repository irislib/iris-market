import test from 'node:test';
import assert from 'node:assert/strict';
class Element {
 constructor(tag){this.tag=tag;this.dataset={};this.children=[];this.attributes=new Map()}
 append(...children){for(const child of children){child.parent=this;this.children.push(child)}}
 remove(){this.parent.children=this.parent.children.filter(child=>child!==this)}
 setAttribute(key,value){this.attributes.set(key,value)}
 querySelectorAll(selector){return this.children.filter(child=>selector==='[data-person-relationship]'&&'personRelationship'in child.dataset)}
}
const roots=[];
globalThis.window={addEventListener(){}};
globalThis.document={createElement:tag=>new Element(tag),querySelectorAll(selector){
 const all=roots.flatMap(row=>[row,...row.children]);
 return all.filter(node=>selector==='[data-person-avatar]'?'personAvatar'in node.dataset:selector==='[data-person-name]'?'personName'in node.dataset:selector==='button[data-person]'?node.tag==='button'&&'person'in node.dataset:selector==='.user-row[data-person]'?'person'in node.dataset:false)
}};
const {setupPeople,createUserRow,refreshPeople,resetPeople,warmProfiles}=await import('../src/people.ts');
test('shared user rows refresh one relationship badge and remove stale evidence',()=>{
 const key='a'.repeat(64);let relation={distance:1,badge:'following',description:'Followed by the selected profile',knownFollowers:[],knownFollowerCount:0,partial:true};
 setupPeople({getRelays:()=>['wss://people.example'],isPreview:()=>true,relationshipFor:k=>{assert.equal(k,key);return relation},makeRelationshipBadge:r=>{const badge=new Element('span');badge.setAttribute('aria-label',r.description);return badge}});
 const row=createUserRow(key,{onClick(){}});roots.push(row);
 assert.equal(row.querySelectorAll('[data-person-relationship]').length,1);
 const previous=row.children[2];relation={...relation,distance:2,description:'Followed by one known person'};refreshPeople();
 assert.equal(row.querySelectorAll('[data-person-relationship]').length,1);assert.notEqual(row.children[2],previous);assert.equal(row.children[2].attributes.get('aria-label'),relation.description);
 relation=undefined;refreshPeople();assert.equal(row.querySelectorAll('[data-person-relationship]').length,0);assert.equal(row.children.length,2);
 resetPeople();roots.length=0;
});

test('missing names retry after a bounded interval without duplicate active watches',async()=>{
 const originalNow=Date.now;let clock=1000000;Date.now=()=>clock;
 const key='b'.repeat(64),opened=[],bootstrap=[];
 try{
  setupPeople({getRelays:()=>['wss://people.example'],isPreview:()=>false,loadBootstrap:async options=>{bootstrap.push(options)},watchMetadata:(keys,options)=>{const watch={keys,close(){options.onClose()}};opened.push(watch);return watch}});
  warmProfiles([key]);await Promise.resolve();assert.equal(opened.length,1);assert.equal(bootstrap.length,1);
  clock+=31000;warmProfiles([key]);await Promise.resolve();assert.equal(opened.length,1,'a slow live reply remains on its original watch');
  opened[0].close();warmProfiles([key]);await Promise.resolve();assert.equal(opened.length,2,'missing metadata is not suppressed for five minutes');
  resetPeople();assert.equal(bootstrap[0].signal.aborted,true);
 }finally{Date.now=originalNow;resetPeople()}
});
