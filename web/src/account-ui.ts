import {flushNow} from './account/flush.ts';
import {mount, unmount} from 'svelte';
import {setupPrivateMatches} from './private-match-ui.ts';
import {setupMarketplaceFlags} from './account/marketplace-flags-ui.ts';
import {createSurface} from './surface.ts';
import {setupHeaderIdentity} from './menu.ts';
import {createAvatar, createUserName} from './people.ts';
import AccountPanel from './account/AccountPanel.svelte';
import Inbox from './account/Inbox.svelte';
import MessageSettings from './account/MessageSettings.svelte';
import {AccountController, type AccountOptions, type AccountState} from './account/controller.svelte.ts';

export type {AccountState};

export function setupAccount(options:AccountOptions) {
  const {accountPage,onAccountPage=()=>{},onAccountClose=()=>{},messagePage,onMessagePage=()=>{},onMessageClose=()=>{},isPreview}=options;
  const c=new AccountController(options);
  c.account=createSurface({className:'account-dialog',label:'Profile settings',pageHost:accountPage,onOpen:onAccountPage,onClose:onAccountClose});
  c.inbox=createSurface({className:'account-dialog',label:'Messages',pageHost:messagePage,onOpen:()=>onMessagePage(c.selected||undefined),onClose:onMessageClose});
  c.inbox.classList.add('inbox-dialog');
  mount(AccountPanel,{target:c.account,props:{c}});
  mount(Inbox,{target:c.inbox,props:{c}});
  c.headerIdentity=setupHeaderIdentity({createAvatar,createUserName,onProfile:key=>c.options.onProfile(key)});
  const preferences=document.querySelector('#preferences-dialog');
  const settings=preferences?mount(MessageSettings,{target:preferences,props:{c}}):undefined;
  // Later setup reads the mounted markup (private matching anchors its link in Messages).
  flushNow();
  c.account.addEventListener('close',()=>{if(c.state.status!=='ready')c.controller?.abort();});
  c.inbox.addEventListener('close',()=>c.inboxClosed());
  const uncovered=()=>queueMicrotask(c.refreshUnread);
  window.addEventListener('resize',c.scheduleSeen);
  document.addEventListener('visibilitychange',c.refreshUnread);document.addEventListener('close',uncovered,true);window.addEventListener('focus',c.refreshUnread);
  const showAccount=(settings?:{posting?:boolean})=>c.showAccount(settings);
  const showInbox=()=>c.showInbox();
  document.getElementById('account-button')!.onclick=()=>showAccount();document.getElementById('inbox-tab')!.onclick=showInbox;
  const messaging=c.messaging;
  c.restored=isPreview()?Promise.resolve(c.renderAccount()):messaging.restore().then(value=>{c.state=value as AccountState;c.renderAccount();if(c.pendingInvite)c.showAccount();}).catch(error=>{c.fail(error);if(c.pendingInvite)c.showAccount();});
  if(!isPreview())void c.restored.then(async()=>{if(c.state.status==='signed-out'){await c.loadGuest();c.renderAccount();}}).catch(()=>{});
  window.addEventListener('pagehide',()=>{if(c.readFrame!==undefined)cancelAnimationFrame(c.readFrame);window.removeEventListener('resize',c.scheduleSeen);clearTimeout(c.guestTimer);if(settings)void unmount(settings);document.removeEventListener('visibilitychange',c.refreshUnread);document.removeEventListener('close',uncovered,true);window.removeEventListener('focus',c.refreshUnread);c.controller?.abort();messaging.destroy();});
  const api={ messaging, restored:c.restored, refreshGuestHistory:async()=>{await c.loadGuest();if(c.state.status==='signed-out')c.renderInbox();}, state:()=>c.state, showAccount, showInbox, openChat:(pubkey:string,settings?:Parameters<AccountController['openChat']>[1])=>c.openChat(pubkey,settings), composeMessage:(text:string)=>c.composeMessage(text), hideInbox:()=>c.inbox.hide(), closeAccount:()=>c.account.hide(), hideAccount:()=>c.account.hide(), onReady:(listener:()=>void)=>c.readyListeners.add(listener), onState:(listener:(state:AccountState)=>void)=>{c.stateListeners.add(listener);return()=>c.stateListeners.delete(listener)} };
  setupMarketplaceFlags(api);
  setupPrivateMatches(api,options.getMatchListings??(()=>[]),c.inbox);
  return api;
}
