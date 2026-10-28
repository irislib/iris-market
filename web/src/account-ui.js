import { createChatDrafts } from './chat-drafts.js';
import { captureInvitation } from './asset-url.js';
import { npubEncode } from 'nostr-tools/nip19';
import { createMessaging } from './messaging/client.js';
import { createAvatar, createUserRow, nameFor, personFor, warmProfiles, resetPeople } from './people.js';
import { normalizePublicKey } from './social.js';
import { cacheProfileMetadata } from './profiles.js';

const el = (tag, text, className) => { const node=document.createElement(tag); if(text!==undefined)node.textContent=text; if(className)node.className=className; return node; };
function dialog(markup, name) {
  const node=el('dialog',undefined,'account-dialog'); node.innerHTML=markup; node.setAttribute('aria-label',name); document.body.append(node);
  node.querySelector('[data-close]').onclick=()=>node.close();
  node.addEventListener('click',event=>{if(event.target===node){const r=node.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)node.close()}});
  return node;
}
export function setupAccount({getRelays,isPreview,onIdentity=()=>{},onProfile=()=>{}}) {
  const readyListeners=new Set(), drafts=createChatDrafts();
  const incomingInvitation=captureInvitation(location.href,document.baseURI);
  let pendingInvite=incomingInvitation?.invite??null;
  if(incomingInvitation)history.replaceState(null,'',incomingInvitation.cleanURL);
  let state={status:'signed-out',devices:[],conversations:[]}, busy=false, selected=null, pendingInbox=false, signingOnly=false, loginView='new', controller;
  const account=dialog(`<button data-close class="dialog-close icon-button" aria-label="Close profile">×</button><h2>Your profile</h2><div id="account-person"></div><p id="account-status" class="small muted" role="status"></p><p id="account-error" class="error" role="alert"></p>
  <div id="account-login"><form id="account-create" class="profile-start"><label for="account-name">Your name</label><input id="account-name" placeholder="Name" autocomplete="nickname" maxlength="80" required><button class="button primary">Continue</button></form><button id="account-existing-toggle" class="text-button profile-existing">Existing profile</button>
  <div id="account-existing" hidden><button id="account-extension" class="button secondary">Browser extension</button><button id="account-link-device" class="button secondary">Link this device</button><details class="account-option" id="account-remote-option"><summary>Remote signer</summary><form id="account-remote"><label for="account-bunker">Connection link <span class="muted">· optional</span></label><input id="account-bunker" placeholder="bunker://…" autocomplete="off"><button class="button secondary">Connect signer</button></form><div id="account-connect" hidden><p class="small muted">Approve this link on your other device.</p><input id="account-connect-link" readonly aria-label="Signer connection link"><button id="account-copy-connect" class="text-button">Copy connection link</button><a id="account-open-connect" class="text-button" target="_blank" rel="noopener noreferrer">Open signer</a><button id="account-cancel-connect" class="text-button">Cancel</button></div></details>
  <details class="account-option" id="account-key-option"><summary>Private key</summary><form id="account-key-form"><label for="account-key">Private key</label><input id="account-key" type="password" placeholder="nsec…" autocomplete="off" spellcheck="false" required><button class="button secondary">Continue</button></form></details><button id="account-existing-back" class="text-button">Back</button></div></div>
  <form id="account-unlock" hidden><label for="account-password">Password</label><input id="account-password" type="password" autocomplete="current-password"><button class="button primary">Continue</button></form>
  <div id="account-ready" hidden><button id="account-open-invite" class="button primary" hidden>Open private invitation</button><div class="account-actions"><button id="account-inbox" class="button primary">Messages</button><button id="account-profile" class="button secondary">View profile</button><button id="account-lock" class="text-button">Lock</button></div><div id="posting-signer" hidden><p class="small muted">Connect a signer to post listings.</p><button id="posting-extension" class="button secondary">Use browser signer</button><button id="posting-remote" class="text-button">Use remote signer</button></div><details class="account-option"><summary>Edit profile</summary><form id="account-edit-profile"><label>Name<input id="account-edit-name" maxlength="80" required autocomplete="nickname"></label><label>Photo link<input id="account-edit-picture" type="url" placeholder="https://…" autocomplete="off"></label><button class="button secondary">Save profile</button></form></details><details class="account-option"><summary>Linked devices</summary><div id="account-devices"></div><p class="small muted">New messages reach your authorized devices. Earlier history is not copied automatically.</p></details><details class="account-option"><summary>Profile details</summary><button id="account-copy-id" class="text-button">Copy profile ID</button><button id="account-backup" class="text-button">Copy backup key</button><button id="account-invite" class="text-button">Copy private chat invitation</button></details></div>`, 'Your profile');
  const inbox=dialog(`<button data-close class="dialog-close icon-button" aria-label="Close messages">×</button><h2>Messages</h2><div class="chat-shell"><aside class="chat-sidebar"><form id="chat-new"><label class="sr-only" for="chat-recipient">User ID or private invitation</label><input id="chat-recipient" placeholder="User ID or invitation" autocomplete="off"><button class="button secondary" aria-label="Start conversation">New</button></form><div id="chat-list"></div></aside><section class="chat-main"><div id="chat-person"></div><div id="chat-messages" role="log" aria-live="polite"></div><p id="chat-status" class="small muted" role="status"></p><p id="chat-error" class="error" role="alert"></p><form id="chat-send"><label class="sr-only" for="chat-text">Message</label><textarea id="chat-text" placeholder="Message" rows="2" maxlength="8000"></textarea><button id="chat-send-button" class="button primary">Send</button></form></section></div>`, 'Messages');
  inbox.classList.add('inbox-dialog');
  const $=id=>document.getElementById(id);
  const profileCopy=value=>String(value).replace(/\baccounts\b/gi,'profiles').replace(/\baccount\b/gi,'profile');
  const fail=error=>{ $('account-error').textContent=profileCopy(error.message||String(error)); };
  const withBusy=async task=>{if(busy)return;busy=true;$('account-error').textContent='';try{return await task()}catch(error){fail(error);throw error}finally{busy=false;renderAccount()}};
  const messaging=createMessaging({getRelays,onChange:value=>{const previous=state.ownerPubkey;state=value;if(value.profileEvent)cacheProfileMetadata(value.profileEvent,{relays:getRelays()});if(value.canSign)queueMicrotask(()=>{for(const listener of readyListeners)listener()});warmProfiles([value.ownerPubkey,...value.conversations.map(c=>c.pubkey)].filter(Boolean));renderAccount();renderInbox();onIdentity(value.ownerPubkey,value.status,previous,value.pendingListings||[]);if(pendingInbox&&value.status==='ready'){pendingInbox=false;account.close();showInbox();if(selected)void messaging.open(selected).catch(error=>{$('chat-error').textContent=error.message;})}}});
  function renderAccount(){
    const ready=state.status==='ready', locked=state.status==='locked';
    if(locked&&state.needsLogin)loginView='existing';
    const existing=loginView==='existing'||signingOnly;
    $('account-open-invite').hidden=!pendingInvite;account.querySelector('h2').textContent=pendingInvite?'Private chat invitation':locked?'Continue with your profile':ready&&!signingOnly?'Your profile':'Existing profile';
    account.querySelector('h2').hidden=!ready&&!locked&&!pendingInvite&&!existing;
    account.classList.toggle('profile-onboarding',!ready&&!locked&&!existing&&!pendingInvite);
    $('account-create').hidden=existing;$('account-existing-toggle').hidden=existing;$('account-existing').hidden=!existing;
    $('account-key-option').hidden=signingOnly;$('account-link-device').hidden=signingOnly;$('account-existing-back').hidden=signingOnly;
    $('account-login').hidden=ready&&!signingOnly||locked&&!state.needsLogin;
    $('account-unlock').hidden=!locked||state.needsLogin;
    $('account-password').hidden=!state.password;$('account-unlock').querySelector('label').hidden=!state.password;
    $('account-ready').hidden=!ready||signingOnly;
    $('account-status').textContent='';
    $('account-person').replaceChildren(...(state.ownerPubkey?[createUserRow(state.ownerPubkey,{size:44})]:[]));
    const ownName=$('account-person').querySelector('.user-name');if(ownName&&state.displayName){delete ownName.dataset.personName;ownName.textContent=state.displayName;}
    $('account-backup').hidden=state.mode!=='local'; $('posting-signer').hidden=state.canSign;
    const nav=$('account-button'); nav.replaceChildren(...(ready&&state.ownerPubkey?[createAvatar(state.ownerPubkey)]:[document.createTextNode('Sign in')]));nav.setAttribute('aria-label',ready?'Your profile':'Sign in');
    $('account-devices').replaceChildren(...state.devices.map((device,index)=>{const row=el('div',undefined,'device-row');row.append(el('span',device.current?'This device':`Linked device ${index+1}`));if(!device.current&&state.canSign){const button=el('button','Revoke','text-button');button.onclick=()=>withBusy(()=>messaging.revokeDevice(device.pubkey)).catch(()=>{});row.append(button)}return row}));
    for(const button of account.querySelectorAll('form button,#account-extension,#account-link-device,#account-existing-toggle,#account-existing-back'))button.disabled=busy;
    $('account-name').disabled=busy;
  }
  function renderInbox(){
    if(!inbox.open)return;
    $('chat-list').replaceChildren(...state.conversations.map(c=>{const row=createUserRow(c.pubkey,{size:36,className:'chat-row',onClick:()=>{selectChat(c.pubkey);renderInbox()}});row.setAttribute('aria-pressed',String(selected===c.pubkey));return row}));
    $('chat-person').replaceChildren(...(selected?[createUserRow(selected,{size:36,onClick:()=>{inbox.close();onProfile(selected)}})]:[]));
    const messages=state.conversations.find(c=>c.pubkey===selected)?.messages||[];
    const area=$('chat-messages'), nearBottom=area.scrollHeight-area.scrollTop-area.clientHeight<100;
    area.replaceChildren(...messages.map(message=>{const item=el('div',undefined,`chat-message ${message.mine?'mine':''}`);item.append(el('p',message.text));const time=new Date(message.createdAt*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});item.append(el('span',`${time}${message.mine?' · '+message.delivery:''}`,'small muted'));return item}));
    if(!selected)area.append(el('p','Choose a conversation or enter a user ID.','muted chat-empty'));
    if(nearBottom)area.scrollTop=area.scrollHeight;
    $('chat-send').hidden=!selected;$('chat-send-button').disabled=!state.canSend;
    $('chat-status').textContent=selected&&!state.canSend?'Messages will sync when connected.':'';
  }
  function showAccount({posting=false}={}){if(isPreview()){$('account-error').textContent='Switch to the live market to sign in.'}signingOnly=false;if(!busy)loginView='new';renderAccount();account.showModal();if(posting&&readyForPostingSigner())$('account-status').textContent='Connect a signer to post.'}
  function readyForPostingSigner(){return state.status==='ready'&&!state.canSign;}
  function showInbox(){if(state.status!=='ready'){pendingInbox=true;showAccount();return}renderInbox();if(!inbox.open)inbox.showModal();renderInbox()}
  function selectChat(pubkey,proposal){$('chat-text').value=drafts.select(pubkey,$('chat-text').value,proposal);selected=pubkey;}
  async function openChat(pubkey,{draft}={}){if(isPreview())throw new Error('Switch to the live market to send messages.');selectChat(normalizePublicKey(pubkey),draft);warmProfiles([selected]);if(state.status!=='ready'){pendingInbox=true;showAccount();return}await messaging.open(selected);showInbox()}
  function ensureLive(){if(isPreview())throw new Error('Switch to the live market to sign in.');}
  const login=task=>withBusy(async()=>{ensureLive();await task();signingOnly=false;}).catch(()=>{});
  $('account-existing-toggle').onclick=()=>{loginView='existing';$('account-error').textContent='';renderAccount();};
  $('account-existing-back').onclick=()=>{controller?.abort();loginView='new';$('account-key').value='';$('account-error').textContent='';renderAccount();};
  $('account-extension').onclick=()=>login(()=>signingOnly?messaging.connectExtensionSigner():messaging.loginWithExtension({}));
  $('account-create').onsubmit=event=>{event.preventDefault();const name=$('account-name').value.trim();if(!name){$('account-name').setCustomValidity('Enter your name.');$('account-name').reportValidity();return}login(async()=>{await messaging.createAccount({});await messaging.updateProfile({name});resetPeople();warmProfiles([state.ownerPubkey]);})};
  $('account-name').oninput=()=>$('account-name').setCustomValidity('');
  $('account-key-form').onsubmit=event=>{event.preventDefault();const key=$('account-key').value;$('account-key').value='';login(()=>messaging.loginWithKey({key}));};
  $('account-unlock').onsubmit=event=>{event.preventDefault();const password=$('account-password').value;$('account-password').value='';login(()=>messaging.unlock(password));};
  $('account-remote').onsubmit=event=>{event.preventDefault();controller?.abort();controller=new AbortController();login(async()=>{await messaging[signingOnly?'connectPostingSigner':'loginWithSigner']({bunkerLink:$('account-bunker').value.trim()||undefined,signal:controller.signal,onConnectionLink:link=>{$('account-connect').hidden=false;$('account-connect-link').value=link;$('account-open-connect').href=link;},onAuthUrl:url=>{if(new URL(url).protocol==='https:'){$('account-connect').hidden=false;$('account-open-connect').href=url;$('account-open-connect').textContent='Approve connection';}}});controller=undefined;$('account-connect').hidden=true;})};
  $('account-link-device').onclick=()=>{$('account-remote-option').open=true;$('account-bunker').value='';$('account-remote').requestSubmit();};
  $('account-copy-connect').onclick=()=>navigator.clipboard.writeText($('account-connect-link').value).catch(fail);
  $('account-cancel-connect').onclick=()=>controller?.abort();account.addEventListener('close',()=>{if(state.status!=='ready')controller?.abort();});
  $('posting-extension').onclick=()=>login(()=>messaging.connectExtensionSigner());
  $('posting-remote').onclick=()=>{signingOnly=true;loginView='existing';renderAccount();$('account-remote-option').open=true;};
  $('account-edit-profile').parentElement.addEventListener('toggle',event=>{if(event.currentTarget.open&&state.ownerPubkey){const person=personFor(state.ownerPubkey);$('account-edit-name').value=state.displayName||person.name||'';$('account-edit-picture').value=person.pictureUrl||'';}});
  $('account-edit-profile').onsubmit=event=>{event.preventDefault();login(async()=>{await messaging.updateProfile({name:$('account-edit-name').value,picture:$('account-edit-picture').value.trim()||undefined});resetPeople();warmProfiles([state.ownerPubkey]);$('account-status').textContent='Profile saved';});};
  $('account-open-invite').onclick=()=>withBusy(async()=>{const peer=await messaging.acceptInvite(pendingInvite);pendingInvite=null;account.close();await openChat(peer);}).catch(()=>{});
  $('account-inbox').onclick=()=>{account.close();showInbox();};
  $('account-profile').onclick=()=>{account.close();onProfile(state.ownerPubkey);};
  $('account-lock').onclick=()=>login(()=>messaging.lock());
  $('account-copy-id').onclick=()=>navigator.clipboard.writeText(npubEncode(state.ownerPubkey)).then(()=>{$('account-status').textContent='Profile ID copied';}).catch(fail);
  $('account-backup').onclick=()=>withBusy(async()=>{await navigator.clipboard.writeText(await messaging.exportKey());$('account-status').textContent='Backup key copied. Store it privately.';}).catch(()=>{});
  $('account-invite').onclick=()=>withBusy(async()=>{await navigator.clipboard.writeText(await messaging.inviteUrl());$('account-status').textContent='Private invitation copied.';}).catch(()=>{});
  $('chat-new').onsubmit=event=>{event.preventDefault();const input=$('chat-recipient').value.trim();$('chat-error').textContent='';(async()=>{selectChat(input.includes('://')?await messaging.acceptInvite(input):normalizePublicKey(input));await messaging.open(selected);$('chat-recipient').value='';renderInbox();})().catch(error=>{$('chat-error').textContent=error.message;});};
  $('chat-send').onsubmit=event=>{event.preventDefault();const text=$('chat-text').value.trim(),peer=selected;if(!text||!peer)return;$('chat-send-button').disabled=true;$('chat-error').textContent='';messaging.send(peer,text).then(()=>{drafts.clear(peer);if(selected===peer&&$('chat-text').value.trim()===text)$('chat-text').value='';}).catch(error=>{$('chat-error').textContent=error.message;}).finally(()=>{$('chat-send-button').disabled=!state.canSend;});};
  $('account-button').onclick=()=>showAccount();$('inbox-tab').onclick=showInbox;
  if(!isPreview())void messaging.restore().then(value=>{state=value;renderAccount();if(pendingInvite)showAccount();}).catch(error=>{fail(error);if(pendingInvite)showAccount();}); else renderAccount();
  window.addEventListener('pagehide',()=>{controller?.abort();messaging.destroy();});
  return { messaging, state:()=>state, showAccount, showInbox, openChat, closeAccount:()=>account.close(), onReady:listener=>readyListeners.add(listener) };
}
