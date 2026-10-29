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
const {setupPeople,createUserRow,refreshPeople,resetPeople}=await import('../src/people.ts');
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
