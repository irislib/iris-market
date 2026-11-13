import test from 'node:test';
import assert from 'node:assert/strict';
import {window,settle} from './support/dom.mjs';
import {flushSync} from 'svelte';

// Surfaces dispatch DOM events into happy-dom nodes.
globalThis.Event=window.Event;
// Assertions follow clicks directly, so apply Svelte's updates synchronously.
const nativeClick=HTMLElement.prototype.click;
HTMLElement.prototype.click=function(){nativeClick.call(this);flushSync();};
const storage=new Map();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)}});
document.body.innerHTML='<button id="account-button">Sign in</button><button id="inbox-tab">Messages</button><button id="header-menu-button"><span>…</span></button><button id="profile-menu" hidden></button><section id="preferences-dialog"></section><main id="workspace-page"></main>';

const {setupAccount}=await import('../src/account-ui.ts');
const {sellerNoticeControl}=await import('../src/merchant-notice-ui.ts');
const {editChatTimer}=await import('../src/chat-timers-ui.ts');
const {setupPeople}=await import('../src/people.ts');
setupPeople({getRelays:()=>[],isPreview:()=>true});

const owner='a'.repeat(64),peer='b'.repeat(64),other='c'.repeat(64);
const base={status:'signed-out',devices:[],conversations:[],orders:[],receiptPreferences:{delivered:true,seen:true},retention:{mode:'follow'},chatTimers:{}};
function fakeMessaging(initial){
  const calls=[];let onChange;
  const messaging={
    restore:async()=>initial,state:()=>initial,destroy(){},refreshHistory:async()=>{},markSeen:async()=>{},
    loginWithKey:async options=>{calls.push(['loginWithKey',options.key]);},
    unlock:async password=>{calls.push(['unlock',password]);},
    open:async key=>{calls.push(['open',key]);},
    send:async(key,text)=>{calls.push(['send',key,text]);},
    privateMatchView:()=>null,setReceiptPreferences:async()=>{},
  };
  return {calls,messaging,emit:value=>onChange(value),factory:options=>{onChange=options.onChange;return messaging;}};
}
const page=()=>document.getElementById('workspace-page');
const byText=(root,text)=>[...root.querySelectorAll('*')].filter(node=>node.textContent.trim()===text).at(-1);
let current;
function setup(initial){
  for(const node of [...page().children])node.remove();
  document.getElementById('preferences-dialog').replaceChildren();
  const fake=fakeMessaging(initial);
  const api=setupAccount({getRelays:()=>[],isPreview:()=>false,accountPage:page(),messagePage:page(),createMessaging:fake.factory});
  current={api,...fake};
  return current;
}
const accountSurface=()=>page().querySelector('.account-dialog:not(.inbox-dialog)');
const inboxSurface=()=>page().querySelector('.inbox-dialog');

test('signed-out profile shows onboarding; existing profile options and key login keep the key out of the page',async()=>{
  const {api,calls}=setup({...base});await api.restored;await settle();
  api.showAccount();
  const surface=accountSurface();
  assert.equal(surface.hidden,false);
  assert.equal(surface.classList.contains('profile-onboarding'),true);
  assert.equal(surface.querySelector('h2').hidden,true);
  assert.equal(surface.querySelector('#account-create').hidden,false);
  assert.equal(surface.querySelector('#account-existing').hidden,true);
  assert.equal(surface.querySelector('#account-ready').hidden,true);
  assert.equal(surface.querySelector('#account-name').hasAttribute('autofocus'),true);
  surface.querySelector('#account-existing-toggle').click();
  assert.equal(surface.querySelector('#account-existing').hidden,false);
  assert.equal(surface.querySelector('#account-create').hidden,true);
  assert.equal(surface.querySelector('h2').textContent,'Existing profile');
  assert.equal(surface.classList.contains('profile-onboarding'),false);
  const key=surface.querySelector('#account-key');key.value='nsec1secret';
  surface.querySelector('#account-key-form').requestSubmit();await settle();
  assert.equal(key.value,'');
  assert.deepEqual(calls.at(-1),['loginWithKey','nsec1secret']);
  assert.equal(page().innerHTML.includes('nsec1secret'),false);
  surface.querySelector('#account-existing-back').click();
  assert.equal(surface.querySelector('#account-create').hidden,false);
});

test('locked and ready profiles show unlock, devices and receipt settings',async()=>{
  const {api,calls,emit}=setup({...base,status:'locked',password:true,ownerPubkey:owner});await api.restored;await settle();
  api.showAccount();const surface=accountSurface();
  assert.equal(surface.querySelector('h2').textContent,'Continue with your profile');
  assert.equal(surface.querySelector('#account-login').hidden,true);
  assert.equal(surface.querySelector('#account-unlock').hidden,false);
  const password=surface.querySelector('#account-password');password.value='pw';
  surface.querySelector('#account-unlock').requestSubmit();await settle();
  assert.deepEqual(calls.at(-1),['unlock','pw']);assert.equal(password.value,'');
  emit({...base,status:'ready',ownerPubkey:owner,displayName:'Alice',canSign:true,canSend:true,mode:'local',devices:[{pubkey:owner,current:true},{pubkey:other,current:false}]});flushSync();
  assert.equal(surface.querySelector('h2').textContent,'Your profile');
  assert.equal(surface.querySelector('#account-ready').hidden,false);
  assert.equal(surface.querySelector('#account-unlock').hidden,true);
  assert.equal(surface.querySelector('#account-person .user-name').textContent,'Alice');
  assert.deepEqual([...surface.querySelectorAll('.device-row')].map(row=>row.textContent),['This device','Linked device 2Revoke']);
  const settings=document.querySelector('#preferences-dialog');
  assert.equal(byText(settings,'Messages').tagName,'SUMMARY');
  assert.equal(byText(settings,'Message retention · Follow the conversation timer').disabled,false);
  assert.deepEqual([...settings.querySelectorAll('input[type=checkbox]')].slice(0,2).map(input=>input.checked),[true,true]);
});

test('Messages lists threads, marks unread, shows queued delivery and sends without waiting on relays',async()=>{
  const now=Math.floor(Date.now()/1000);
  const conversations=[{pubkey:peer,messages:[
    {id:'m1',text:'Hello there',mine:false,createdAt:now-60,delivery:'received',reactions:[]},
    {id:'m2',text:'Hi!',mine:true,createdAt:now-30,delivery:'queued',reactions:[{emoji:'👍',count:1,reacted_by_me:false}]},
  ]}];
  const {api,calls}=setup({...base,status:'ready',ownerPubkey:owner,canSign:true,canSend:false,conversations});await api.restored;await settle();
  await api.showInbox();
  const inbox=inboxSurface();
  assert.equal(inbox.hidden,false);
  assert.equal(inbox.querySelector('#chat-threads').getAttribute('aria-pressed'),'true');
  const rows=[...inbox.querySelectorAll('#chat-list .chat-row')];
  assert.equal(rows.length,1);
  assert.equal(rows[0].querySelector('.chat-thread-title').textContent,'Conversation');
  assert.equal(rows[0].getAttribute('aria-pressed'),'false');
  assert.equal(inbox.querySelector('.chat-empty').textContent,'Choose a conversation or enter a user ID.');
  assert.equal(inbox.querySelector('#chat-send').hidden,true);
  rows[0].click();
  const selected=inbox.querySelector('#chat-list .chat-row');
  assert.equal(selected.getAttribute('aria-pressed'),'true');
  assert.equal(inbox.querySelector('#chat-person .user-row').dataset.person,peer);
  assert.equal(byText(inbox.querySelector('#chat-person'),'Conversation timer · Off').disabled,true);
  const messages=[...inbox.querySelectorAll('#chat-messages .chat-message')];
  assert.deepEqual(messages.map(node=>node.dataset.messageId),['m1','m2']);
  assert.equal(messages[1].className,'chat-message mine');
  assert.equal(messages[1].querySelector('.chat-delivery').textContent,'Queued');
  assert.equal(messages[1].querySelector('.chat-delivery').getAttribute('aria-label'),'Message queued');
  assert.equal(messages[1].querySelector('.chat-reaction-chip').getAttribute('aria-pressed'),'false');
  assert.equal(inbox.querySelector('.chat-empty'),null);
  assert.equal(inbox.querySelector('#chat-status').textContent,'Messages will sync when connected.');
  assert.equal(inbox.querySelector('#chat-send').hidden,false);
  assert.equal(inbox.querySelector('#chat-send-button').disabled,true);
  const text=inbox.querySelector('#chat-text');text.value='Is it still available?';text.dispatchEvent(new Event('input',{bubbles:true}));
  inbox.querySelector('#chat-send').requestSubmit();await settle();
  assert.deepEqual(calls.at(-1),['send',peer,'Is it still available?']);
  assert.equal(text.value,'');
  inbox.querySelector('#chat-people').click();
  assert.equal(inbox.querySelector('#chat-people').getAttribute('aria-pressed'),'true');
  assert.equal(inbox.querySelector('.chat-thread-title'),null);
  assert.equal(storage.get('market-message-grouping'),'people');
  api.hideInbox();flushSync();
  assert.equal(inbox.querySelectorAll('.chat-message').length,0);
});

test('signed-out Messages asks for a profile first',async()=>{
  const {api}=setup({...base});await api.restored;await settle();
  await api.showInbox();
  assert.equal(inboxSurface().hidden,true);
  assert.equal(accountSurface().hidden,false);
});

test('seller notice control moves with listing renders and reflects queued state',async()=>{
  const queued=[];
  const control=sellerNoticeControl(peer,{status:async()=>'available',queue:async key=>{queued.push(key);return 'queued';}},()=>true);
  await settle();
  const host=document.createElement('div');document.body.append(host);host.append(control.root);
  assert.equal(control.root.className,'seller-notice');
  assert.equal(control.root.hidden,false);
  const button=control.root.querySelector('button');
  assert.equal(button.disabled,false);
  button.click();await settle();
  assert.deepEqual(queued,[peer]);
  assert.equal(button.hidden,true);
  assert.equal(control.root.querySelector('[role=status]').textContent,'Anonymous notice queued.');
  control.show('unavailable');assert.equal(control.root.hidden,true);
  host.remove();
});

test('conversation timer editor validates and saves seconds, then removes itself',async()=>{
  const saved=[];
  editChatTimer({seconds:null,save:async value=>{saved.push(value);}});
  const dialog=document.querySelector('dialog.chat-timer-dialog');
  assert.equal(dialog.getAttribute('aria-label'),'Conversation timer');
  const [mode,unit]=dialog.querySelectorAll('select');
  assert.equal(dialog.querySelector('.chat-timer-duration').hidden,true);
  mode.value='expire';mode.dispatchEvent(new Event('change',{bubbles:true}));flushSync();
  assert.equal(dialog.querySelector('.chat-timer-duration').hidden,false);
  const amount=dialog.querySelector('input[type=number]');amount.value='2';amount.dispatchEvent(new Event('input',{bubbles:true}));
  unit.value='3600';unit.dispatchEvent(new Event('change',{bubbles:true}));
  dialog.querySelector('form').requestSubmit();await settle();
  assert.deepEqual(saved,[7200]);
  assert.equal(document.querySelector('dialog.chat-timer-dialog'),null);
});
