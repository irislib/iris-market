import test from 'node:test';
import assert from 'node:assert/strict';
import {getEncodedToken} from '@cashu/cashu-ts';
import {setupWallet} from '../src/wallet-ui.ts';
import {TEST_MINT} from '../src/wallet/mints.ts';
class Element extends EventTarget {
 constructor(tag='div'){super();this.tag=tag;this.children=[];this.value='';this.textContent='';this.hidden=false;this.dataset={};this.elements={};this.classList={toggle(){}};}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(name,value){this[name]=value;}
 set innerHTML(html){const stack=[this];for(const part of html.matchAll(/<\/?([\w-]+)([^>]*)>/g)){const [raw,tag,attrs]=part;if(raw.startsWith('</')){while(stack.length>1&&stack.pop().tag!==tag){}continue;}const el=new Element(tag);el.hidden=/\bhidden\b/.test(attrs);for(const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)){el[a[1]]=a[2];if(a[1].startsWith('data-'))el.dataset[a[1].slice(5)]=a[2];}stack.at(-1).append(el);if(el.name){const form=stack.findLast(e=>e.tag==='form');if(form)form.elements[el.name]=el;}if(!['input','br','hr'].includes(tag))stack.push(el);}}
 all(){return this.children.flatMap(e=>[e,...e.all()]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 querySelectorAll(selector){return this.all().filter(el=>selector.split(',').some(s=>s[0]==='#'?el.id===s.slice(1):s==='[data-receive]'?!!el.dataset.receive:s==='[data-send]'?!!el.dataset.send:s==='form button'?el.tag==='button':false));}
}
const tick=()=>new Promise(r=>setImmediate(r));
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(t,{status='ready',mint=TEST_MINT,balance='128',overrides={}}={}){
 const page=new Element(),tab=new Element('button'),window=new EventTarget();globalThis.window=window;globalThis.document={createElement:tag=>new Element(tag),getElementById:()=>tab};
 let state={status,selectedMint:mint,balance,mints:status==='ready'?[{url:mint,supported:true,balance}]:[],history:[],invoices:[],pending:[]},onChange;
 const calls={send:[],add:[],receive:[],enable:[],estimates:[],preview:[]},tokens=new Map();
 const client={state:()=>state,restore:async()=>state,destroy(){},enable:async({mintUrl})=>{calls.enable.push(mintUrl);state={...state,status:'ready',selectedMint:mintUrl,mints:[{url:mintUrl}]};onChange(state);},addMint:async url=>{calls.add.push(url);state.mints.push({url});onChange(state);},selectMint:async url=>{state.selectedMint=url;onChange(state);},previewSend:async amount=>{calls.preview.push(amount);return{amount,fee:'2'};},send:async options=>{calls.send.push(options);if(!tokens.has(options.idempotencyKey))tokens.set(options.idempotencyKey,'cashuBtest');return{token:tokens.get(options.idempotencyKey)};},previewReceive:async()=>({mint:TEST_MINT,amount:'128',received:'127',fee:'1',unknownMint:false}),receive:async token=>{calls.receive.push(token);return{amount:'127'};},...overrides};
 const ui=setupWallet({page,isPreview:()=>false,formatEstimate:amount=>{calls.estimates.push(amount);return '€0.01';},loadClient:async()=>({DEFAULT_MINT:'https://mint.coinos.io',createCashuWallet:options=>{onChange=options.onChange;return client;}})});
 t.after(()=>window.dispatchEvent(new Event('pagehide')));return{ui,calls,client,field:id=>page.querySelector('#'+id),state};
}
const order=(id='one',mint=TEST_MINT)=>({id,items:[{title:'Coffee'}],payment:{status:'requested',mint,amount:'16'}});
const token=mint=>getEncodedToken({mint,unit:'sat',proofs:[{amount:128,id:'009a1f293253e41e',secret:'fixture',C:'02'+'11'.repeat(32)}]});
const submit=async field=>{field.onsubmit({preventDefault(){}});await tick();};
test('order payment reviews fees, labels test sats, retries identical payment after delivery failure',async t=>{
 const {ui,calls,field}=fixture(t);let sent=0,done=0;
 await ui.payOrder(order(),async()=>{if(++sent===1)throw Error('Delivery unavailable');},()=>done++);
 assert.match(field('wallet-balance').textContent,/128 test sats/);assert.equal(field('wallet-estimate').textContent,'');assert.equal(calls.estimates.length,0);
 await field('wallet-order-pay').onclick();assert.equal(calls.send.length,0);assert.match(field('wallet-order-fee').textContent,/2 test sats/);
 await field('wallet-order-pay').onclick();assert.equal(done,0);assert.match(field('wallet-error').textContent,/Delivery unavailable/);
 await field('wallet-order-pay').onclick();assert.equal(done,1);assert.equal(sent,2);assert.deepEqual(calls.send[0],calls.send[1]);assert.equal(calls.send[0].maxFee,'2');assert.equal(calls.send[0].idempotencyKey,'order-payment:one:'+TEST_MINT+':16');
});
test('duplicate pay clicks serialize; closing during mint selection prevents burn and callback',async t=>{
 const wait=defer();const {ui,field,calls}=fixture(t,{overrides:{selectMint:()=>wait.promise}});let sent=0;
 await ui.payOrder(order(),async()=>sent++,()=>{});const first=field('wallet-order-pay').onclick();await field('wallet-order-pay').onclick();ui.hide();wait.resolve();await first;
 assert.equal(calls.send.length,0);assert.equal(calls.preview.length,0);assert.equal(sent,0);
});
test('a late send result cannot deliver token using a different order callback',async t=>{
 const wait=defer();const {ui,field}=fixture(t,{overrides:{send:()=>wait.promise}});let first=0,second=0;
 await ui.payOrder(order(),async()=>first++,()=>{});await field('wallet-order-pay').onclick();const sending=field('wallet-order-pay').onclick();await tick();
 ui.hide();await ui.payOrder(order('two'),async()=>second++,()=>{});wait.resolve({token:'cashuBfixture'});await sending;assert.equal(first,0);assert.equal(second,0);assert.equal(field('wallet-order-fee').textContent,'');
});
test('unsupported order and token mints cannot be enabled or redeemed',async t=>{
 const {ui,calls,field}=fixture(t,{overrides:{previewReceive:async()=>({mint:'https://untrusted.example',unknownMint:true,amount:'128'})}});
 await ui.payOrder(order('bad','https://untrusted.example'),async()=>{},()=>{});await field('wallet-order-pay').onclick();assert.equal(calls.add.length,0);assert.equal(calls.send.length,0);
 await ui.openToken(token('https://untrusted.example'));await submit(field('wallet-receive-form'));assert.equal(field('wallet-receive-confirm').hidden,true);await field('wallet-receive-confirm').onclick();assert.equal(calls.add.length,0);assert.equal(calls.receive.length,0);
});
test('incoming test token selects test mint during onboarding then returns to order after receive',async t=>{
 const {ui,field,calls}=fixture(t,{status:'disabled'});let returned=0;const value=token(TEST_MINT);
 await ui.openToken(value,()=>returned++);assert.equal(field('wallet-enable').elements.mint.value,TEST_MINT);assert.equal(field('wallet-enable-intro').textContent,'Receive test money with Cashu. No bitcoin value.');
 await submit(field('wallet-enable'));assert.deepEqual(calls.enable,[TEST_MINT]);assert.equal(field('wallet-receive-form').elements.token.value,value);
 await submit(field('wallet-receive-form'));assert.match(field('wallet-receive-summary').textContent,/127 test sats.*Fee 1 test sats/);
 await field('wallet-receive-confirm').onclick();assert.deepEqual(calls.receive,[value]);assert.equal(returned,1);
});
test('editing or closing during token preview rejects late quote and receive callback',async t=>{
 const wait=defer();const {ui,field,calls}=fixture(t,{overrides:{previewReceive:()=>wait.promise}});let returned=0;
 await ui.openToken(token(TEST_MINT),()=>returned++);field('wallet-receive-form').onsubmit({preventDefault(){}});await tick();ui.hide();wait.resolve({mint:TEST_MINT,received:'127',fee:'1'});await tick();assert.equal(field('wallet-receive-preview').hidden,true);assert.equal(calls.receive.length,0);assert.equal(returned,0);
});
test('real sats retain exchange estimate and are never labeled test money',async t=>{
 const {ui,field,calls}=fixture(t,{mint:'https://mint.coinos.io'});await ui.open();assert.equal(field('wallet-balance').textContent,'128 sats');assert.equal(field('wallet-test-money').hidden,true);assert.equal(field('wallet-estimate').textContent,'€0.01');assert.ok(calls.estimates.length>0);
});
test('closing after receive starts preserves result without invoking a newer order return callback',async t=>{
 const wait=defer();const {ui,field}=fixture(t,{overrides:{receive:()=>wait.promise}});let previous=0,next=0;
 await ui.openToken(token(TEST_MINT),()=>previous++);await submit(field('wallet-receive-form'));const receiving=field('wallet-receive-confirm').onclick();await tick();ui.hide();
 await ui.openToken(token(TEST_MINT),()=>next++);wait.resolve({amount:'127'});await receiving;assert.equal(previous,0);assert.equal(next,0);
});
test('late ordinary send quote after closing cannot reappear on reopening',async t=>{
 const wait=defer();const {ui,field}=fixture(t,{overrides:{previewSend:()=>wait.promise}});await ui.open();field('wallet-send-form').elements.amount.value='16';field('wallet-send-form').onsubmit({preventDefault(){}});await tick();ui.hide();await ui.open();wait.resolve({amount:'16',fee:'2'});await tick();assert.equal(field('wallet-send-preview').hidden,true);
});
test('adding known test mint requires a second fee review before redeeming',async t=>{
 let previews=0;const {ui,field,calls}=fixture(t,{mint:'https://mint.coinos.io',overrides:{previewReceive:async()=>++previews===1?{mint:TEST_MINT,unknownMint:true,amount:'128'}:{mint:TEST_MINT,unknownMint:false,received:'127',fee:'1'}}});
 await ui.openToken(token(TEST_MINT));await submit(field('wallet-receive-form'));assert.equal(field('wallet-receive-confirm').textContent,'Add mint and review');await field('wallet-receive-confirm').onclick();assert.deepEqual(calls.add,[TEST_MINT]);assert.equal(calls.receive.length,0);assert.match(field('wallet-receive-summary').textContent,/127 test sats.*Fee 1 test sats/);await field('wallet-receive-confirm').onclick();assert.equal(calls.receive.length,1);
});
test('reopening an order with zero remaining balance resends the durable token without another quote or spend',async t=>{
 let walletState,spends=0,previews=0,tokenReads=0;const exactToken='cashuBpersistedfixture',id='order-payment:one:'+TEST_MINT+':16';
 const {ui,field,state}=fixture(t,{overrides:{previewSend:async()=>{previews++;if(walletState.balance==='0')throw Error('Insufficient balance');return{amount:'16',fee:'2'};},send:async()=>{spends++;walletState.balance='0';walletState.history.push({id,type:'send',mint:TEST_MINT,amount:'16',fee:'2',state:'complete',createdAt:1700000000});return{token:exactToken};},getToken:async key=>{tokenReads++;assert.equal(key,id);return exactToken;}}});walletState=state;
 const delivered=[];await ui.payOrder(order(),async token=>{delivered.push(token);throw Error('Chat unavailable');},()=>{});
 await field('wallet-order-pay').onclick();await field('wallet-order-pay').onclick();assert.equal(state.balance,'0');ui.hide();
 let done=0;await ui.payOrder(order(),async token=>delivered.push(token),()=>done++);assert.equal(field('wallet-order-pay').textContent,'Retry sending payment');assert.match(field('wallet-order-fee').textContent,/Fee 2 test sats/);
 await field('wallet-order-pay').onclick();assert.deepEqual(delivered,[exactToken,exactToken]);assert.equal(done,1);assert.equal(spends,1);assert.equal(previews,1);assert.equal(tokenReads,1);
});
test('pending saved order payment recovers exact token before delivery without a new quote or spend',async t=>{
 const id='order-payment:one:'+TEST_MINT+':16';let recovered=0;const {ui,field,state,calls}=fixture(t,{balance:'0',overrides:{recover:async key=>{assert.equal(key,id);recovered++;return{token:'cashuBrecovered'};}}});state.history.push({id,type:'send',mint:TEST_MINT,amount:'16',fee:'2',state:'pending',createdAt:1700000000});let delivered;
 await ui.payOrder(order(),async token=>delivered=token,()=>{});await field('wallet-order-pay').onclick();assert.equal(delivered,'cashuBrecovered');assert.equal(recovered,1);assert.equal(calls.preview.length,0);assert.equal(calls.send.length,0);
});
