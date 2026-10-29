import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftFiles,renderComposerPreview} from '../src/composer-preview.ts';
import {listingDraft} from '../src/composer.ts';

class Element {
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.attributes=new Map();}
 append(...nodes){this.children.push(...nodes);}
 setAttribute(name,value){this.attributes.set(name,value);}
 remove(){}
}
const document={createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)};
Object.defineProperty(globalThis,'document',{value:document,configurable:true});
const all=node=>[node,...node.children.flatMap(all)];
const values={title:'Oak desk',description:'Solid **oak**, ready to collect.',price:'95',currency:'EUR',location:'Helsinki',side:'offer',category:'home'};

test('preview creates local URLs only for passive raster photos and revokes each exactly once',()=>{
 const created=[],revoked=[],files=[new File(['image'],'desk.png',{type:'image/png'}),new File(['text'],'guide.pdf',{type:'application/pdf'}),new File(['<svg/>'],'drawing.svg',{type:'image/svg+xml'})];
 const previews=createDraftFiles(files,{createObjectURL:file=>{created.push(file.name);return'blob:local-desk';},revokeObjectURL:url=>revoked.push(url)});
 assert.deepEqual(created,['desk.png']);assert.equal(previews.items[0].image,'blob:local-desk');assert.equal(previews.items[1].image,undefined);assert.equal(previews.items[2].image,undefined);
 previews.close();previews.close();assert.deepEqual(revoked,['blob:local-desk']);
});

test('preview failure releases URLs already created and does not change selected files',async()=>{
 const revoked=[],files=[new File(['one'],'one.png',{type:'image/png'}),new File(['two'],'two.jpg',{type:'image/jpeg'})];let count=0;
 assert.throws(()=>createDraftFiles(files,{createObjectURL:()=>{if(++count===2)throw Error('Unavailable');return'blob:first';},revokeObjectURL:url=>revoked.push(url)}),/Unavailable/);
 assert.deepEqual(revoked,['blob:first']);assert.equal(await files[0].text(),'one');
});

test('preview reuses the safe detail presentation without publishing, purchasing, saving or link-sharing actions',()=>{
 const draft=listingDraft(values),root=renderComposerPreview(draft,[{name:'desk.png',size:1234,image:'blob:local-desk'},{name:'guide.pdf',size:1024}]);
 const nodes=all(root);assert(nodes.some(node=>node.tag==='h1'&&node.textContent==='Oak desk'));assert(nodes.some(node=>node.tag==='strong'));
 assert.equal(nodes.find(node=>node.className==='detail-art').src,'blob:local-desk');assert(nodes.some(node=>node.textContent==='guide.pdf'));
 assert.equal(nodes.some(node=>node.tag==='button'),false);assert.equal(nodes.some(node=>node.textContent==='Sample listing'),false);assert(!JSON.stringify(draft).includes('blob:'));
});
