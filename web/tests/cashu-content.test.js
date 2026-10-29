import test from 'node:test';
import assert from 'node:assert/strict';
import { getEncodedToken } from '@cashu/cashu-ts';
import { cashuParts, cashuAmount, containsCashu, renderCashuContent, formatPaymentNote, parsePaymentNote, renderPaymentNote } from '../src/cashu-content.ts';
const proof={amount:8,id:'009a1f293253e41e',secret:'synthetic-test-only',C:'02'+'11'.repeat(32)};
// SDK4 encodes v4 only; construct the standard legacy v3 envelope explicitly.
const token=(mint='https://mint.example',version=4)=>version===3?'cashuA'+Buffer.from(JSON.stringify({token:[{mint,proofs:[proof]}],unit:'sat'})).toString('base64url'):getEncodedToken({mint,unit:'sat',proofs:[proof]});

test('actual Cashu v3 and v4 cards preserve surrounding text, amount and exact bearer token',async()=>{
  for(const version of [3,4]){const value=token(undefined,version);assert(value.startsWith(version===3?'cashuA':'cashuB'));const parts=await cashuParts(`Here you go: ${value}\nThanks!`);assert.equal(parts.length,3);assert.equal(parts[1].token,value);assert.equal(parts[1].amount,'8');assert.equal(cashuAmount(parts[1]),'8 sats');assert.equal(parts[2].text,'\nThanks!');assert.equal(parts[1].mintName,'mint.example');}
});
test('plain invalid tokens and unsafe mints remain readable parse results',async()=>{
  for(const value of ['cashuBbad','cashuAeyJ4IjoxfQ',token('http://mint.example'),token('https://user:pass@mint.example'),token('https://mint.example/?key=x')])assert.deepEqual(await cashuParts(value),[{type:'text',text:value}]);
});
test('cashu URI accepted, embedded URL or identifier not interpreted, parsing bounded',async()=>{
  const value=token();assert.equal((await cashuParts(`cashu:${value}`))[0].type,'cashu');
  for(const text of [`https://example.org/${value}`,`abc${value}`,`https://example.org/?token=${value}`])assert.equal((await cashuParts(text)).length,1);
  assert.equal((await cashuParts(Array(8).fill(value).join(' '))).filter(p=>p.type==='cashu').length,4);
  assert.equal((await cashuParts('a'.repeat(16001)+value))[0].type,'text');
  assert.equal(containsCashu('A normal message'),false);
  assert.deepEqual(await cashuParts('A normal message'),[{type:'text',text:'A normal message'}]);
});

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.textContent='';}
  append(...children){this.children.push(...children);}
  setAttribute(name,value){this.attributes[name]=value;}
}
const document={createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment')};
const descendants=node=>[node,...node.children.flatMap(descendants)];
const visibleText=node=>[node.textContent,...node.children.filter(child=>child.tag!=='details').map(visibleText)].join(' ');

test('rendering creates a hidden token card and makes no wallet or mint calls',async()=>{
  let opened=0,copied=0,fetched=0;const previous=globalThis.fetch,value=token();globalThis.fetch=()=>{fetched++;throw new Error('No mint access during rendering');};
  try{
    const fragment=await renderCashuContent(value,{document,onToken:input=>{assert.equal(input,value);opened++;},copyText:async input=>{assert.equal(input,value);copied++;}});
    assert.equal(opened,0);assert.equal(copied,0);assert.equal(fetched,0);
    assert.match(visibleText(fragment),/8 sats/);assert.match(visibleText(fragment),/Not checked/);assert(!visibleText(fragment).includes(value));
    const nodes=descendants(fragment);assert.equal(nodes.find(node=>node.tag==='textarea').value,value);
    nodes.find(node=>node.textContent==='Open in wallet').onclick();assert.equal(opened,1);
    nodes.find(node=>node.textContent==='Copy token').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal(copied,1);
    assert.equal(fetched,0);
  }finally{globalThis.fetch=previous;}
});
test('unparsed, extra and oversized bearer candidates remain hidden in the UI',async()=>{
  for(const text of ['cashuBbad',Array(5).fill(token()).join(' '),'a'.repeat(16001)+token()]){
    const fragment=await renderCashuContent(text,{document});assert(!visibleText(fragment).includes('cashuB'));assert(descendants(fragment).some(node=>node.tag==='details'));
  }
});
test('late rendering and actions are suppressed after close, lock or conversation change',async()=>{
  let active=true,opened=0,copied=0;
  const pending=renderCashuContent(token(),{document,isActive:()=>active,onToken:()=>opened++});active=false;assert.deepEqual((await pending).children,[]);
  active=true;const fragment=await renderCashuContent(token(),{document,isActive:()=>active,onToken:()=>opened++,copyText:()=>copied++});active=false;
  for(const button of descendants(fragment).filter(node=>node.tag==='button'))button.onclick();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(opened,0);assert.equal(copied,0);
});

test('completed Lightning sharing is a readable unverified note with no token or payment proof',()=>{
  const receipt={type:'lightning',state:'complete',amount:'1234',createdAt:1700000000,invoice:'private-invoice',preimage:'private-preimage',token:token()};
  const text=formatPaymentNote(receipt);assert.match(text,/Amount: 1234 sats/);assert.match(text,/Sender-reported; not verified/);assert(!text.includes('private-'));assert(!text.includes('cashuB'));
  assert.deepEqual(parsePaymentNote(text),{amount:'1234',at:1700000000});assert.equal(formatPaymentNote({...receipt,createdAt:1700000000000}),text);
  const card=renderPaymentNote(parsePaymentNote(text),{document});assert.match(visibleText(card),/1,234 sats/);assert.match(visibleText(card),/Not verified/);
});
test('unpaid or unrelated transfers cannot be shared as completed Lightning payments',()=>{
  const base={type:'lightning',state:'complete',amount:'8',createdAt:1700000000};
  for(const invalid of [{...base,state:'pending'},{...base,state:'cancelled'},{...base,type:'receive'},{...base,amount:'0'},{...base,amount:'-8'},{...base,createdAt:NaN}])assert.throws(()=>formatPaymentNote(invalid));
  for(const invalid of ['Lightning payment',formatPaymentNote(base).replace('not verified','verified'),formatPaymentNote(base)+'\nForged',formatPaymentNote(base).replace('2023-11-14','2023-02-31')])assert.equal(parsePaymentNote(invalid),null);
});
