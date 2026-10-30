import test from 'node:test';
import assert from 'node:assert/strict';
import {rumorMilliseconds,messageMilliseconds} from '../src/message-timestamp.ts';
import {messageProjection} from '../src/messaging/client.ts';
test('private message millisecond timestamp is bounded, optional, and legacy seconds remain the fallback',()=>{
 const seconds=Math.floor(Date.now()/1000),ms=seconds*1000+123,rumor={kind:14,id:'1'.repeat(64),created_at:seconds,content:'hello',tags:[['ms',String(ms)]]};
 assert.equal(rumorMilliseconds(rumor),ms);assert.equal(messageMilliseconds({createdAt:seconds,createdAtMs:ms}),ms);
 assert.equal(messageMilliseconds({createdAt:seconds}),seconds*1000);
 for(const tags of [[],[['ms','NaN']],[['ms','-1']],[['ms','9007199254740992']],[['ms',String(ms)],['ms',String(ms)]],[['ms',String(ms+400000)]],[['ms','1']]])assert.equal(rumorMilliseconds({...rumor,tags}),undefined);
 const owner='2'.repeat(64),peer='3'.repeat(64);assert.equal(messageProjection(rumor,peer,{senderOwnerPubkey:peer},owner).message.createdAtMs,ms);assert.equal(messageProjection({...rumor,tags:[]},peer,{senderOwnerPubkey:peer},owner).message.createdAtMs,undefined);
});
