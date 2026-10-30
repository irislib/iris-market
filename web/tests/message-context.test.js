import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contextTags,messageContext,groupMessageThreads,orderContext,listingContext} from '../src/message-context.ts';
import {createUnreadTracker} from '../src/notifications.ts';
const a='e166c41b-ed90-4d76-aa37-2ed2b2ff4f31',b='c9e05d7e-ef82-4b6a-a97b-5dce4d242baa';
test('private context round trips; malformed and duplicate tags are optional hints',()=>{
 const context={thread_id:a,listing:`30402:${'a'.repeat(64)}:city-cycle`};
 assert.deepEqual(messageContext(contextTags(context)),context);
 assert.equal(messageContext([...contextTags(context),...contextTags(context)]),undefined);
 assert.equal(messageContext([['iris-market-context','1','{"thread_id":"bad"}']]),undefined);
 assert.throws(()=>contextTags({...context,listing:'https://tracker.invalid'}));
});
test('order context uses the established buyer and UUID order identity',()=>{const id=`${'b'.repeat(64)}:${a}`;assert.deepEqual(messageContext(contextTags(orderContext(id))),{thread_id:a,order_id:id});assert.throws(()=>contextTags({thread_id:b,order_id:id}));});
test('orders, inquiries and general chat remain separate with the same person',()=>{
 const orderId=`${'b'.repeat(64)}:${a}`;
 const groups=groupMessageThreads([{id:'a',createdAt:1},{id:'b',createdAt:2,orderId},{id:'c',createdAt:3,context:orderContext(orderId)},{id:'d',createdAt:4,context:{thread_id:b}}]);
 assert.equal(groups.length,3);assert.equal(groups.find(g=>g.key===`order:${orderId}`).messages.length,2);
});
test('reading one thread does not mark another thread read',()=>{
 const storage=new Map(),tracker=createUnreadTracker({kind:'messages',storage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)}});
 const streams=[{id:'person',items:[{id:'one',mine:false},{id:'two',mine:false}]}];
 tracker.update('owner',streams,'person',['one']);assert.equal(tracker.unread('person'),1);assert.equal(tracker.unread('person',['one']),0);assert.equal(tracker.unread('person',['two']),1);
 tracker.update('owner',streams,'person',['two']);assert.equal(tracker.unread('person'),0);
});

test('Buying inquiry context normalizes actual card coordinates without double-prefixing',()=>{
 const coordinate=`${'a'.repeat(64)}:need-city-cycle`;
 assert.deepEqual(messageContext(contextTags(listingContext(coordinate,a))),{thread_id:a,listing:`30402:${coordinate}`});
 assert.deepEqual(listingContext(`30402:${coordinate}`,a),listingContext(coordinate,a));
 assert.throws(()=>listingContext('https://tracker.invalid',a));
});
