import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnreadTracker,conversationNotifications,orderNotifications,readingSurface} from '../src/notifications.ts';
const storage = () => { const rows=new Map();return {rows,getItem:key=>rows.get(key),setItem:(key,value)=>rows.set(key,value)}; };
const incoming=(id,createdAt=100)=>({id,mine:false,createdAt});
const stream=(id,...items)=>({id,items});

test('incoming streams count once, own messages never count and visible reading clears them',()=>{
  const counts=[],tracker=createUnreadTracker({kind:'messages',storage:storage(),onUnread:count=>counts.push(count)});
  tracker.update('owner',[stream('a',incoming('1'),incoming('2'),{id:'mine',mine:true}),stream('b',{id:'mine2',mine:true})]);
  assert.equal(tracker.count(),1);assert.equal(tracker.unread('a'),2);assert.equal(tracker.unread('b'),0);
  tracker.update('owner',[stream('a',incoming('1'),incoming('2'))],'a');
  assert.equal(tracker.count(),0);
  tracker.update('owner',[stream('a',incoming('1'),incoming('2'),incoming('3'))],'a');
  assert.equal(tracker.count(),0);assert.deepEqual(counts,[1,0]);
});

test('read receipts persist across reload while late arrivals with older timestamps stay unread',()=>{
  const local=storage(),first=createUnreadTracker({kind:'messages',storage:local});
  first.update('owner',[stream('friend',incoming('seen',500))],'friend');
  const reload=createUnreadTracker({kind:'messages',storage:local});
  reload.update('owner',[stream('friend',incoming('seen',500),incoming('delayed',20))]);
  assert.equal(reload.unread('friend'),1);
  reload.read('friend');assert.equal(reload.count(),0);
  const final=createUnreadTracker({kind:'messages',storage:local});
  final.update('owner',[stream('friend',incoming('seen',500),incoming('delayed',20))]);assert.equal(final.count(),0);
});

test('reading one thread leaves another thread from the same person unread across reload',()=>{
  const local=storage(),tracker=createUnreadTracker({kind:'messages',storage:local});
  const values=[stream('friend',incoming('order-reply'),incoming('general-reply'))];
  tracker.update('owner',values,'friend',['order-reply']);
  assert.equal(tracker.unread('friend',['order-reply']),0);
  assert.equal(tracker.unread('friend',['general-reply']),1);
  assert.equal(tracker.count(),1);
  const reload=createUnreadTracker({kind:'messages',storage:local});
  reload.update('owner',values,'friend',[]);
  assert.equal(reload.unread('friend'),1);
  reload.read('friend',['general-reply']);
  assert.equal(reload.count(),0);
});

test('same-timestamp messages use IDs; duplicate projection does not multiply unread',()=>{
  const tracker=createUnreadTracker({kind:'messages',storage:storage()});
  tracker.update('owner',[stream('friend',incoming('a'))],'friend');
  tracker.update('owner',[stream('friend',incoming('a'),incoming('b'),incoming('b'))]);
  assert.equal(tracker.unread('friend'),1);
});

test('locking hides dots without forgetting reads and profiles never share receipts',()=>{
  const tracker=createUnreadTracker({kind:'messages',storage:storage()}),values=[stream('friend',incoming('id'))];
  tracker.update('alice',values,'friend');tracker.update(null,values);assert.equal(tracker.count(),0);
  tracker.update('bob',values);assert.equal(tracker.count(),1);
  tracker.update('alice',values);assert.equal(tracker.count(),0);
});

test('stored markers contain hashes and timestamps only, without profile, peer, message text or tokens',()=>{
  const local=storage(),tracker=createUnreadTracker({kind:'messages',storage:local,now:()=>12345});
  tracker.update('owner-private-scope',[stream('private-peer',{...incoming('private-message-id'),text:'cashuA-private-bearer'})],'private-peer');
  const stored=JSON.stringify([...local.rows]);
  for(const secret of ['owner-private-scope','private-peer','private-message-id','cashuA-private-bearer'])assert(!stored.includes(secret));
  const value=JSON.parse([...local.rows.values()][0]);assert.equal(Object.values(value.streams)[0].at,12345);
});

test('order summaries only notify authenticated known orders, ignore own changes and archived records',()=>{
  const conversations=[{pubkey:'seller',messages:[{...incoming('a'),orderId:'order'}, {id:'b',mine:true,createdAt:200,orderId:'order'}, {...incoming('c'),orderId:'unknown'}, {...incoming('d'),orderId:'archive'}, incoming('plain-chat')]}];
  const values=orderNotifications(conversations,[{id:'order'},{id:'archive',archived:true}]);
  assert.deepEqual(values,[stream('order',incoming('a'), {id:'b',mine:true,createdAt:200})]);
  const tracker=createUnreadTracker({kind:'orders',storage:storage()});tracker.update('buyer',values);assert.equal(tracker.count(),1);
  tracker.read('order');assert.equal(tracker.count(),0);
  assert.equal(conversationNotifications(conversations)[0].items.some(item=>'text'in item||'orderId'in item),false);
});

test('storage failure and malformed existing records keep session read state usable',()=>{
  for(const local of [{getItem:()=>'{bad',setItem(){}},{getItem:()=>null,setItem(){throw Error('quota');}}]){
    const tracker=createUnreadTracker({kind:'messages',storage:local});tracker.update('owner',[stream('friend',incoming('a'))]);tracker.read('friend');assert.equal(tracker.count(),0);
  }
});

test('pages and dialogs are read only when visible, focused and uncovered',()=>{
  const page={open:true},modal={open:true};let hidden=false,focused=true,dialogs=[];
  const doc={get visibilityState(){return hidden?'hidden':'visible';},hasFocus:()=>focused,querySelectorAll:()=>dialogs};
  assert.equal(readingSurface(page,doc),true);
  dialogs=[modal];assert.equal(readingSurface(page,doc),false);assert.equal(readingSurface(modal,doc),true);
  focused=false;assert.equal(readingSurface(modal,doc),false);focused=true;hidden=true;assert.equal(readingSurface(modal,doc),false);
  hidden=false;dialogs=[];page.open=false;assert.equal(readingSurface(page,doc),false);
});
