import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReceiptRumor,buildReactionRumor} from 'nostr-double-ratchet';
import {createChatControls,parseChatControls,applyChatControl,messageReactions,validReaction} from '../src/messaging/chat-controls.ts';
import emojiFixtures from '../../crates/market-core/tests/fixtures/chat-reaction-emoji.json' with {type:'json'};
import {visibleChatMessageIds} from '../src/chat-visibility.ts';
const owner='1'.repeat(64),peer='2'.repeat(64),outsider='3'.repeat(64),device='4'.repeat(64),target='5'.repeat(64);
const rumor=(kind,value,at=Date.now(),id=target)=>kind===7?buildReactionRumor(id,value,{pubkey:device,nowMs:at,tags:[['p',owner]]}):buildReceiptRumor(value,[id],{pubkey:device,nowMs:at,tags:[['p',owner]]});
function memory(){const entries=new Map();return{get:async key=>structuredClone(entries.get(key)),put:async(key,value)=>{entries.set(key,structuredClone(value));},entries};}
const apply=(message,event,who=peer)=>parseChatControls(event,who,owner,peer).reduce((next,control)=>applyChatControl(next,control,owner,peer),message);
test('private controls validate authenticated owner, exact peer and outgoing receipt target author',()=>{
 const message={id:target,mine:true,delivery:'sent'};
 assert.equal(apply(message,rumor(15,'delivered')).delivery,'delivered');
 assert.equal(apply({...message,mine:false,delivery:'received'},rumor(15,'seen')).delivery,'received');
 assert.deepEqual(parseChatControls(rumor(15,'seen'),outsider,owner,peer),[]);
 const wrong=rumor(7,'👍');wrong.tags[0][1]=outsider;assert.deepEqual(parseChatControls(wrong,peer,owner,peer),[]);
 assert.deepEqual(parseChatControls(rumor(7,'not emoji'),peer,owner,peer),[]);
 assert.deepEqual(parseChatControls(rumor(7,'👍',Date.now()+301000),peer,owner,peer),[]);
 assert(validReaction('❤️'));assert(validReaction('🇫🇮'));assert(validReaction('1️⃣'));
});
test('receipt before message persists through restart and statuses never regress',async()=>{
 const vault=memory(),book=createChatControls({vault,owner,device});await book.load();const seen=rumor(15,'seen');await book.receive(seen,peer,peer);
 const restored=createChatControls({vault,owner,device});await restored.load();let message={id:target,mine:true,delivery:'queued'};
 for(const control of restored.pendingFor(peer,target))message=applyChatControl(message,control,owner,peer);
 assert.equal(message.delivery,'seen');assert.equal(apply(message,rumor(15,'delivered')).delivery,'seen');
 assert.equal(apply(message,rumor(15,'delivered',Date.now()+10)).delivery,'seen');
});
test('reaction replacement, clear tombstone and equal-ms ID order survive replay and restart',async()=>{
 const vault=memory(),book=createChatControls({vault,owner,device});let message={id:target,mine:true,delivery:'sent'};const at=Date.now()-100;
 const first=rumor(7,'👍',at),replace=rumor(7,'❤️',at+1),clear=rumor(7,'',at+2);
 for(const event of [first,replace,clear]){await book.receive(event,peer,peer);const controls=book.pendingFor(peer,target);for(const control of controls)message=applyChatControl(message,control,owner,peer);await vault.put('message',message);await book.settled(controls);}
 const restored=createChatControls({vault,owner,device});await restored.load();message=await vault.get('message');assert.deepEqual(messageReactions(message,owner),[]);
 assert.deepEqual(messageReactions(apply(message,first),owner),[]);
 const a=rumor(7,'😂',at+3),b=rumor(7,'🎉',at+3),winner=a.id>b.id?a:b,loser=winner===a?b:a;
 const final=apply(apply(message,winner),loser);assert.deepEqual(messageReactions(final,owner),[{emoji:winner.content,count:1,reacted_by_me:false}]);
});
test('local reaction toggles off with monotonic ms and receipt preferences default on then persist opt-out',async()=>{
 const vault=memory(),book=createChatControls({vault,owner,device});await book.load();assert.deepEqual(book.preferences(),{delivered:true,seen:true});
 let message={id:target,mine:false,delivery:'received'};const first=await book.reaction(peer,message,'👍');for(const control of book.pendingFor(peer,target))message=applyChatControl(message,control,owner,peer);
 const second=await book.reaction(peer,message,'👍');assert.equal(second.kind,7);assert.equal(second.content,'');assert(Number(second.tags.find(t=>t[0]==='ms')[1])>Number(first.tags.find(t=>t[0]==='ms')[1]));
 assert.equal(book.jobs().filter(job=>job.rumor.kind===7).length,1);
 await book.receipt(peer,[target],'delivered');assert(book.jobs().some(job=>job.rumor.kind===15));await book.setPreferences({delivered:false,seen:false});assert(!book.jobs().some(job=>job.rumor.kind===15));
 await book.receipt(peer,[target],'seen');const restored=createChatControls({vault,owner,device});await restored.load();assert.deepEqual(restored.preferences(),{delivered:false,seen:false});
});
test('bounded unmatched controls prune without failing message delivery and persistence failures expose no queued action',async()=>{
 const vault=memory(),book=createChatControls({vault,owner,device});const at=Date.now()-1000;
 for(let batch=0;batch<34;batch++){const ids=Array.from({length:128},(_,i)=>(batch*128+i).toString(16).padStart(64,'0'));await book.receive(buildReceiptRumor('delivered',ids,{pubkey:device,nowMs:at+batch,tags:[['p',owner]]}),peer,peer);}
 assert((await vault.get('market/chat-controls/v1')).pending.length<=4096);
 const broken=createChatControls({vault:{...vault,put:async()=>{throw Error('full');}},owner,device});await broken.load();await assert.rejects(broken.reaction(peer,{id:target,mine:false,delivery:'received'},'👍'),/full/);assert.equal(broken.jobs().length,0);
});
test('seen selection requires actual visible incoming rows in a focused uncovered thread',()=>{
 const row=(id,top,bottom,mine=false)=>({dataset:{messageId:id,mine:String(mine)},getBoundingClientRect:()=>({top,bottom,left:10,right:400})});
 const rows=[row('visible',150,200),row('offscreen',1001,1100),row('own',250,300,true),row('sliver',890,950),row('above',0,90)];
 const surface={open:true},area={getBoundingClientRect:()=>({top:100,bottom:900,left:0,right:500}),querySelectorAll:()=>rows},doc={visibilityState:'visible',hasFocus:()=>true,querySelectorAll:()=>[]},view={innerHeight:1000,innerWidth:500};
 assert.deepEqual(visibleChatMessageIds(surface,area,doc,view),['visible']);assert.deepEqual(visibleChatMessageIds(surface,area,{...doc,hasFocus:()=>false},view),[]);assert.deepEqual(visibleChatMessageIds(surface,area,{...doc,visibilityState:'hidden'},view),[]);assert.deepEqual(visibleChatMessageIds(surface,area,{...doc,querySelectorAll:()=>[{}]},view),[]);assert.deepEqual(visibleChatMessageIds({...surface,open:false},area,doc,view),[]);
});

test('legacy JSON controls and missing-ms createdAt fallback retain binding checks',()=>{
 const at=Math.floor(Date.now()/1000),reaction=rumor(7,'👍');reaction.content=JSON.stringify({type:'reaction',messageId:target,emoji:'❤️'});reaction.tags=reaction.tags.filter(t=>t[0]!=='ms');reaction.created_at=at;
 const parsed=parseChatControls(reaction,peer,owner,peer);assert.equal(parsed[0].value,'❤️');assert.equal(parsed[0].ms,at*1000);
 reaction.content=JSON.stringify({type:'reaction',messageId:outsider,emoji:'❤️'});assert.deepEqual(parseChatControls(reaction,peer,owner,peer),[]);
 const receipt=rumor(15,'seen');receipt.content=JSON.stringify({type:'seen',messageIds:[target]});receipt.tags=receipt.tags.filter(t=>t[0]!=='ms');receipt.created_at=at;assert.equal(parseChatControls(receipt,peer,owner,peer)[0].value,'seen');
 receipt.tags.push(['ms','invalid']);assert.deepEqual(parseChatControls(receipt,peer,owner,peer),[]);
});
test('offline burst beyond queue cap coalesces optional receipts and seen replaces delivered without dropping reactions',async()=>{
 const vault=memory(),book=createChatControls({vault,owner,device});const reaction=await book.reaction(peer,{id:target,mine:false,delivery:'received'},'👍');
 for(let batch=0;batch<10;batch++){const ids=Array.from({length:100},(_,i)=>(batch*100+i+100).toString(16).padStart(64,'0'));await book.receipt(peer,ids,'delivered');await book.receipt(peer,ids,'seen');}
 const jobs=book.jobs();assert.equal(jobs.filter(job=>job.rumor.kind===7)[0].rumor.id,reaction.id);assert.equal(jobs.filter(job=>job.rumor.kind===15).length,8);assert(jobs.filter(job=>job.rumor.kind===15).every(job=>job.rumor.content==='seen'));assert.equal(jobs.filter(job=>job.rumor.kind===15).flatMap(job=>job.rumor.tags.filter(t=>t[0]==='e')).length,1000);
 await book.setPreferences({seen:false});assert.equal(book.jobs().length,1);
});

test('shared native/browser reaction fixtures cover flags, keycaps, skin tones and family sequences',()=>{
 for(const value of emojiFixtures.valid)assert.equal(validReaction(value),true,JSON.stringify(value));
 for(const value of emojiFixtures.invalid)assert.equal(validReaction(value),false,JSON.stringify(value));
});

test('legacy receipt batches accept 256 targets while rejecting 257 and preserving 128-target outgoing chunks',async()=>{
 const ids=Array.from({length:257},(_,index)=>index.toString(16).padStart(64,'0'));
 const batch=count=>buildReceiptRumor('seen',ids.slice(0,count),{pubkey:device,tags:[['p',owner]]});
 assert.equal(parseChatControls(batch(256),peer,owner,peer).length,256);assert.deepEqual(parseChatControls(batch(257),peer,owner,peer),[]);
 const book=createChatControls({vault:memory(),owner,device});await book.receipt(peer,ids.slice(0,256),'seen');assert.equal(book.jobs().length,2);assert(book.jobs().every(job=>job.rumor.tags.filter(tag=>tag[0]==='e').length===128));
});
