// node web/scripts/benchmark-pickup.mjs /path/to/web [orders=40] [--mutual]
// Supply the locked dependencies of the web revision under test. Compare the
// ordinary authorization flow across revisions, then repeat with --mutual to
// measure sending and verifying the two-party receipt on a synthetic order.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

const args=process.argv.slice(2).filter(arg=>arg!=='--mutual');
const root=resolve(args[0]??'web'), count=Number(args[1]??40);
assert(Number.isInteger(count)&&count>=20&&count<=100);
const require=createRequire(resolve(root,'package.json'));
const {finalizeEvent,getPublicKey}=require('nostr-tools/pure');
const qr=require('qrcode-generator');
const source=file=>import(pathToFileURL(resolve(root,'src',file)));
const {createVault}=await source('messaging/vault.ts'),{createOrderBook}=await source('orders.ts');
const now=()=>1700000000;
const rows={};
async function timed(label,fn) {
  const cpu=process.cpuUsage(),start=performance.now(); const value=await fn();
  const ms=performance.now()-start,used=process.cpuUsage(cpu);
  (rows[label]??=[]).push({ms,cpuMs:(used.user+used.system)/1000});
  return value;
}
async function open(n,storage={}) {
  const sk=new Uint8Array(32).fill(n),device=new Uint8Array(32).fill(n+1);
  const owner=getPublicKey(sk),pub=getPublicKey(device);
  const vault=createVault({backend:{read:async()=>structuredClone(storage.row),write:async(row,version)=>{
    assert.equal(storage.row?.version??0,version);storage.row=structuredClone(row);
  }}});
  if(storage.row)await vault.unlock();else await vault.create();
  const book=createOrderBook({vault,owner,device:pub,now,handoffKeys:{deviceSecret:()=>device,accountSigner:()=>draft=>finalizeEvent(draft,sk)}});
  await book.load(); return {owner,pub,book,storage};
}
async function sync(from,to) {
  for(const job of from.book.jobs()){
    assert.equal(job.recipient,to.owner);await to.book.receive(job.rumor,from.owner,from.pub);await from.book.sent(job.id,to.owner);
  }
}
const buyer=await open(1),merchant=await open(3);
const item={side:'offer',category:'home',id:merchant.owner+':reading-lamp',author:merchant.owner,title:'Reading lamp',price:26,currency:'EUR'};
const receiptBytes=[];const mutual=process.argv.includes('--mutual');
const wireBytes={ack:[],receipt:[]};
for(let i=0;i<count;i++){
  const order=await timed('request',()=>buyer.book.request(item,{fulfillment:'pickup'}));
  await sync(buyer,merchant);await merchant.book.update(order.id,{status:'accepted'});await sync(merchant,buyer);
  if(buyer.book.showHandoff){
    const pass=await timed('showAndRenderQR',async()=>{
      const value=await buyer.book.showHandoff(order.id,'pickup');
      const image=qr(0,'M'); image.addData(value,'Byte'); image.make(); assert(image.createSvgTag({cellSize:4,margin:16,scalable:true}).includes('<svg'));
      return value;
    });
    const previous=merchant.storage.row.ciphertext.byteLength;
    await timed('verifyAndSave',()=>merchant.book.checkHandoff(order.id,'pickup',pass));
    receiptBytes.push(merchant.storage.row.ciphertext.byteLength-previous);
    const stored=merchant.book.state().find(row=>row.id===order.id);
    assert.equal(stored.status,'accepted');assert.deepEqual(stored.handoffs,[{kind:'pickup',action:'checked'}]);
  }
  if(mutual){
    const ack=await timed('acknowledgeAndQueue',()=>buyer.book.acknowledgeOrderPickup(order.id));
    assert(ack.startsWith('iris-handoff:2:pickup:'));const partial=buyer.book.jobs().find(job=>job.action==='pickup-ack');
    wireBytes.ack.push(Buffer.byteLength(JSON.stringify(partial.rumor)));
    await timed('merchantVerifyAndSaveAck',()=>merchant.book.receivePickup(partial.rumor,buyer.owner));
    await buyer.book.sent(partial.id,merchant.owner);
    await timed('confirmAndQueue',()=>merchant.book.confirmOrderPickup(order.id));
    const full=merchant.book.jobs().find(job=>job.action==='pickup-receipt');wireBytes.receipt.push(Buffer.byteLength(JSON.stringify(full.rumor)));
    await timed('buyerVerifyAndSaveReceipt',()=>buyer.book.receivePickup(full.rumor,merchant.owner));
    await merchant.book.sent(full.id,buyer.owner);
    assert.equal(buyer.book.state().find(o=>o.id===order.id).pickupReceipt.state,'confirmed');
  }
  // Leave a fifth of purchases active; the rest become ordinary completed history.
  if(i%5!==0){await merchant.book.update(order.id,{status:'delivered'});await sync(merchant,buyer)}
}
const stored=buyer.storage.row.ciphertext.byteLength,merchantBytes=merchant.storage.row.ciphertext.byteLength;
const digest=order=>[order.role,order.status,order.items[0].title].join('/');
const reference=buyer.book.state().map(digest).sort();
for(let i=0;i<13;i++){
  const restored=await timed('reopenAndFirstOrders',async()=>{const a=await open(1,buyer.storage);return a.book.state()});
  assert.deepEqual(restored.map(digest).sort(),reference);
}
const projectStart=performance.now();for(let i=0;i<200;i++)assert.equal(buyer.book.state().length,count);
const projectionMs=(performance.now()-projectStart)/200;
const metric=(values,key,p)=>values.map(row=>row[key]).sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const round=n=>Math.round(n*1000)/1000;
const measurements=Object.fromEntries(Object.entries(rows).map(([key,samples])=>[key,{
  n:samples.length,firstMs:round(samples[0].ms),medianMs:round(metric(samples,'ms',0.5)),p95Ms:round(metric(samples,'ms',0.95)),medianCpuMs:round(metric(samples,'cpuMs',0.5))
}]));
console.log(JSON.stringify({node:process.version,count,accepted:reference.filter(v=>v.includes('/accepted/')).length,
  measures:measurements,wireBytes:mutual?Object.fromEntries(Object.entries(wireBytes).map(([k,v])=>[k,Math.round(v.reduce((a,b)=>a+b)/v.length)])):undefined,projectionMs:round(projectionMs),buyerCipherBytes:stored,merchantCipherBytes:merchantBytes,
  receiptBytes:receiptBytes.length?Math.round(receiptBytes.reduce((a,b)=>a+b,0)/receiptBytes.length):null,
  notes:'Synthetic pickup orders, real signatures and AES-GCM storage in memory. Wire sizes count the private rumor before ratchet encryption. Excludes camera, relay transit and filesystem flush.'}));
