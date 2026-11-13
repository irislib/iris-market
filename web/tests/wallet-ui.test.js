import test from 'node:test';
import assert from 'node:assert/strict';
import {getEncodedToken} from '@cashu/cashu-ts';
import {window,settle} from './support/dom.mjs';
// The surface dispatches a global Event at its happy-dom node on hide.
globalThis.Event=window.Event;
const {setupWallet}=await import('../src/wallet-ui.ts');
const {TEST_MINT}=await import('../src/wallet/mints.ts');
const tab=document.createElement('button');tab.id='wallet-tab';document.body.append(tab);
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(t,{status='ready',mint=TEST_MINT,balance='128',overrides={}}={}){
 const page=document.createElement('main');document.body.append(page);
 let state={status,selectedMint:mint,balance,mints:status==='ready'?[{url:mint,supported:true,balance}]:[],history:[],invoices:[],pending:[]},onChange;
 const calls={send:[],add:[],receive:[],enable:[],estimates:[],preview:[]},tokens=new Map();
 const client={state:()=>state,restore:async()=>state,destroy(){},enable:async({mintUrl})=>{calls.enable.push(mintUrl);state={...state,status:'ready',selectedMint:mintUrl,mints:[{url:mintUrl}]};onChange(state);},addMint:async url=>{calls.add.push(url);state.mints.push({url});onChange(state);},selectMint:async url=>{state.selectedMint=url;onChange(state);},previewSend:async amount=>{calls.preview.push(amount);return{amount,fee:'2'};},send:async options=>{calls.send.push(options);if(!tokens.has(options.idempotencyKey))tokens.set(options.idempotencyKey,'cashuBtest');return{token:tokens.get(options.idempotencyKey)};},previewReceive:async()=>({mint:TEST_MINT,amount:'128',received:'127',fee:'1',unknownMint:false}),receive:async token=>{calls.receive.push(token);return{amount:'127'};},...overrides};
 const ui=setupWallet({page,isPreview:()=>false,formatEstimate:amount=>{calls.estimates.push(amount);return '€0.01';},loadClient:async()=>({DEFAULT_MINT:'https://mint.coinos.io',createCashuWallet:options=>{onChange=options.onChange;return client;}})});
 t.after(()=>{window.dispatchEvent(new window.Event('pagehide'));page.remove();});return{ui,calls,client,field:id=>page.querySelector('#'+id),state};
}
const order=(id='one',mint=TEST_MINT)=>({id,items:[{title:'Coffee'}],payment:{status:'requested',mint,amount:'16'}});
const token=mint=>getEncodedToken({mint,unit:'sat',proofs:[{amount:128,id:'009a1f293253e41e',secret:'fixture',C:'02'+'11'.repeat(32)}]});
// Real DOM events; settle lets the wallet's async work and Svelte's updates finish.
const send=field=>field.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
const submit=async field=>{send(field);await settle();};
const click=async field=>{field.click();await settle();};
const type=(field,value)=>{field.value=value;field.dispatchEvent(new window.Event('input',{bubbles:true}));};
const buttons=node=>[...node.querySelectorAll('button')];
test('order payment reviews fees, labels test sats, retries identical payment after delivery failure',async t=>{
 const {ui,calls,field}=fixture(t);let sent=0,done=0;
 await ui.payOrder(order(),async()=>{if(++sent===1)throw Error('Delivery unavailable');},()=>done++);
 assert.match(field('wallet-balance').textContent,/128 test sats/);assert.equal(field('wallet-estimate').textContent,'');assert.equal(calls.estimates.length,0);
 await click(field('wallet-order-pay'));assert.equal(calls.send.length,0);assert.match(field('wallet-order-fee').textContent,/2 test sats/);
 await click(field('wallet-order-pay'));assert.equal(done,0);assert.match(field('wallet-error').textContent,/Delivery unavailable/);
 await click(field('wallet-order-pay'));assert.equal(done,1);assert.equal(sent,2);assert.deepEqual(calls.send[0],calls.send[1]);assert.equal(calls.send[0].maxFee,'2');assert.equal(calls.send[0].idempotencyKey,'order-payment:one:'+TEST_MINT+':16');
});
test('duplicate pay clicks serialize; closing during mint selection prevents burn and callback',async t=>{
 const wait=defer();const {ui,field,calls}=fixture(t,{overrides:{selectMint:()=>wait.promise}});let sent=0;
 await ui.payOrder(order(),async()=>sent++,()=>{});field('wallet-order-pay').click();await click(field('wallet-order-pay'));ui.hide();wait.resolve();await settle();
 assert.equal(calls.send.length,0);assert.equal(calls.preview.length,0);assert.equal(sent,0);
});
test('a late send result cannot deliver token using a different order callback',async t=>{
 const wait=defer();const {ui,field}=fixture(t,{overrides:{send:()=>wait.promise}});let first=0,second=0;
 await ui.payOrder(order(),async()=>first++,()=>{});await click(field('wallet-order-pay'));field('wallet-order-pay').click();await settle();
 ui.hide();await ui.payOrder(order('two'),async()=>second++,()=>{});wait.resolve({token:'cashuBfixture'});await settle();assert.equal(first,0);assert.equal(second,0);assert.equal(field('wallet-order-fee').textContent,'');
});
test('unsupported order and token mints cannot be enabled or redeemed',async t=>{
 const {ui,calls,field}=fixture(t,{overrides:{previewReceive:async()=>({mint:'https://untrusted.example',unknownMint:true,amount:'128'})}});
 await ui.payOrder(order('bad','https://untrusted.example'),async()=>{},()=>{});await click(field('wallet-order-pay'));assert.equal(calls.add.length,0);assert.equal(calls.send.length,0);
 await ui.openToken(token('https://untrusted.example'));await submit(field('wallet-receive-form'));assert.equal(field('wallet-receive-confirm').hidden,true);await click(field('wallet-receive-confirm'));assert.equal(calls.add.length,0);assert.equal(calls.receive.length,0);
});
test('incoming test token selects test mint during onboarding then returns to order after receive',async t=>{
 const {ui,field,calls}=fixture(t,{status:'disabled'});let returned=0;const value=token(TEST_MINT);
 await ui.openToken(value,()=>returned++);assert.equal(field('wallet-enable').elements.mint.value,TEST_MINT);assert.equal(field('wallet-enable-intro').textContent,'Receive test money with Cashu. No bitcoin value.');
 await submit(field('wallet-enable'));assert.deepEqual(calls.enable,[TEST_MINT]);assert.equal(field('wallet-receive-form').elements.token.value,value);
 await submit(field('wallet-receive-form'));assert.match(field('wallet-receive-summary').textContent,/127 test sats.*Fee 1 test sats/);
 await click(field('wallet-receive-confirm'));assert.deepEqual(calls.receive,[value]);assert.equal(returned,1);
});
test('editing or closing during token preview rejects late quote and receive callback',async t=>{
 const wait=defer();const {ui,field,calls}=fixture(t,{overrides:{previewReceive:()=>wait.promise}});let returned=0;
 await ui.openToken(token(TEST_MINT),()=>returned++);send(field('wallet-receive-form'));await settle();ui.hide();wait.resolve({mint:TEST_MINT,received:'127',fee:'1'});await settle();assert.equal(field('wallet-receive-preview').hidden,true);assert.equal(calls.receive.length,0);assert.equal(returned,0);
});
test('real sats retain exchange estimate and are never labeled test money',async t=>{
 const {ui,field,calls}=fixture(t,{mint:'https://mint.coinos.io'});await ui.open();assert.equal(field('wallet-balance').textContent,'€0.01');assert.equal(field('wallet-test-money').hidden,true);assert.equal(field('wallet-estimate').textContent,'128 sats');assert.ok(calls.estimates.length>0);
});
test('closing after receive starts preserves result without invoking a newer order return callback',async t=>{
 const wait=defer();const {ui,field}=fixture(t,{overrides:{receive:()=>wait.promise}});let previous=0,next=0;
 await ui.openToken(token(TEST_MINT),()=>previous++);await submit(field('wallet-receive-form'));field('wallet-receive-confirm').click();await settle();ui.hide();
 await ui.openToken(token(TEST_MINT),()=>next++);wait.resolve({amount:'127'});await settle();assert.equal(previous,0);assert.equal(next,0);
});
test('late ordinary send quote after closing cannot reappear on reopening',async t=>{
 const wait=defer();const {ui,field}=fixture(t,{overrides:{previewSend:()=>wait.promise}});await ui.open();type(field('wallet-send-form').elements.amount,'16');send(field('wallet-send-form'));await settle();ui.hide();await ui.open();wait.resolve({amount:'16',fee:'2'});await settle();assert.equal(field('wallet-send-preview').hidden,true);
});
test('adding known test mint requires a second fee review before redeeming',async t=>{
 let previews=0;const {ui,field,calls}=fixture(t,{mint:'https://mint.coinos.io',overrides:{previewReceive:async()=>++previews===1?{mint:TEST_MINT,unknownMint:true,amount:'128'}:{mint:TEST_MINT,unknownMint:false,received:'127',fee:'1'}}});
 await ui.openToken(token(TEST_MINT));await submit(field('wallet-receive-form'));assert.equal(field('wallet-receive-confirm').textContent,'Add mint and review');await click(field('wallet-receive-confirm'));assert.deepEqual(calls.add,[TEST_MINT]);assert.equal(calls.receive.length,0);assert.match(field('wallet-receive-summary').textContent,/127 test sats.*Fee 1 test sats/);await click(field('wallet-receive-confirm'));assert.equal(calls.receive.length,1);
});
test('reopening an order with zero remaining balance resends the durable token without another quote or spend',async t=>{
 let walletState,spends=0,previews=0,tokenReads=0;const exactToken='cashuBpersistedfixture',id='order-payment:one:'+TEST_MINT+':16';
 const {ui,field,state}=fixture(t,{overrides:{previewSend:async()=>{previews++;if(walletState.balance==='0')throw Error('Insufficient balance');return{amount:'16',fee:'2'};},send:async()=>{spends++;walletState.balance='0';walletState.history.push({id,type:'send',mint:TEST_MINT,amount:'16',fee:'2',state:'complete',createdAt:1700000000});return{token:exactToken};},getToken:async key=>{tokenReads++;assert.equal(key,id);return exactToken;}}});walletState=state;
 const delivered=[];await ui.payOrder(order(),async token=>{delivered.push(token);throw Error('Chat unavailable');},()=>{});
 await click(field('wallet-order-pay'));await click(field('wallet-order-pay'));assert.equal(state.balance,'0');ui.hide();
 let done=0;await ui.payOrder(order(),async token=>delivered.push(token),()=>done++);assert.equal(field('wallet-order-pay').textContent,'Retry sending payment');assert.match(field('wallet-order-fee').textContent,/Fee 2 test sats/);
 await click(field('wallet-order-pay'));assert.deepEqual(delivered,[exactToken,exactToken]);assert.equal(done,1);assert.equal(spends,1);assert.equal(previews,1);assert.equal(tokenReads,1);
});
test('pending saved order payment recovers exact token before delivery without a new quote or spend',async t=>{
 const id='order-payment:one:'+TEST_MINT+':16';let recovered=0;const {ui,field,state,calls}=fixture(t,{balance:'0',overrides:{recover:async key=>{assert.equal(key,id);recovered++;return{token:'cashuBrecovered'};}}});state.history.push({id,type:'send',mint:TEST_MINT,amount:'16',fee:'2',state:'pending',createdAt:1700000000});let delivered;
 await ui.payOrder(order(),async token=>delivered=token,()=>{});await click(field('wallet-order-pay'));assert.equal(delivered,'cashuBrecovered');assert.equal(recovered,1);assert.equal(calls.preview.length,0);assert.equal(calls.send.length,0);
});

test('wallet opening never requests an invoice until explicit submit',async t=>{
 let invoices=0;const {ui,field,state,client}=fixture(t,{mint:'https://mint.coinos.io',overrides:{createInvoice:async amount=>{invoices++;const invoice={id:'invoice',amount,mint:'https://mint.coinos.io',request:'lnbc10n1'+'q'.repeat(110),state:'UNPAID',expiresAt:Math.floor(Date.now()/1000)+600};state.invoices.push(invoice);return invoice;}}});
 await ui.open();await click(field('wallet-receive-tab'));assert.equal(invoices,0);assert.equal(field('wallet-invoice-qr').hidden,true);
 type(field('wallet-invoice-form').elements.amount,'100');await submit(field('wallet-invoice-form'));assert.equal(invoices,1);assert.equal(field('wallet-invoice-qr').hidden,false);assert.match(field('wallet-invoice-qr').src,/^data:image\/svg\+xml/);assert.match(field('wallet-open-invoice').href,/^lightning:lnbc/);
 state.invoices[0].state='ISSUED';await client.selectMint('https://mint.coinos.io');await settle();assert.equal(invoices,1);assert.equal(field('wallet-open-invoice').hidden,true);assert.equal(field('wallet-invoice-qr').hidden,true);
});
test('fake-mint invoices never expose a real-wallet link or payable QR',async t=>{
 const {ui,field,state}=fixture(t);state.invoices.push({id:'fake',mint:TEST_MINT,amount:'100',request:'lnbc10n1'+'q'.repeat(110),state:'UNPAID'});await ui.open();assert.equal(field('wallet-open-invoice').hidden,true);assert.equal(field('wallet-invoice-qr').hidden,true);
});

test('reclaim reviews fee and invalidation before spending and ignores a closed review',async t=>{
 let reclaimed=0;const {ui,field,state}=fixture(t,{overrides:{previewReclaimToken:async()=>({mint:TEST_MINT,amount:'16',fee:'1',received:'15'}),reclaimToken:async(id,options)=>{reclaimed++;assert.equal(id,'sent');assert.equal(options.maxFee,'1');return{amount:'15'};}}});state.history.push({id:'sent',mint:TEST_MINT,type:'send',amount:'16',fee:'1',state:'complete',createdAt:1700000000,canReclaim:true});await ui.open();
 const reclaim=buttons(field('wallet-history')).find(el=>el.textContent==='Reclaim payment');await click(reclaim);assert.equal(reclaimed,0);assert.equal(field('wallet-reclaim').hidden,false);assert.match(field('wallet-reclaim-summary').textContent,/15 test sats.*1 test sats/);await click(field('wallet-reclaim-confirm'));assert.equal(reclaimed,1);
 await click(reclaim);ui.hide();await click(field('wallet-reclaim-confirm'));assert.equal(reclaimed,1);
});

test('Activity identifies escrow deposits, payouts and refunds and keeps bearer-token actions on ordinary payments',async t=>{
 const {ui,field,state}=fixture(t,{overrides:{getToken:async()=>{throw Error('not called');},previewReclaimToken:async()=>{}}});
 for(const [id,type,escrow] of [['one','send','funding'],['two','receive','payout'],['three','receive','refund'],['four','send']]){
   state.history.push({id,type,escrow,mint:TEST_MINT,amount:'16',fee:'1',state:'complete',createdAt:1,canReclaim:true});
 }
 await ui.open();
 const rows=[...field('wallet-history').children];
 assert.deepEqual(rows.map(row=>row.querySelector('strong').textContent),['Escrow deposit','Escrow payout','Escrow refund','Sent']);
 for(const row of rows.slice(0,3))assert.deepEqual(buttons(row).map(el=>el.textContent),[]);
 assert.deepEqual(buttons(rows[3]).map(el=>el.textContent),['Show token','Reclaim payment']);
});
