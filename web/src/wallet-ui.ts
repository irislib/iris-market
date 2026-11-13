import { flushSync, mount } from 'svelte';
import { createSurface } from './surface.ts';
import type { OrderView } from './orders.ts';
import type { EscrowAction } from './wallet/escrow.ts';
import Wallet from './wallet-view/Wallet.svelte';
import { WalletView, type WalletOptions } from './wallet-view/state.svelte.ts';

export function setupWallet({page,onNavigate=()=>{},onClose=()=>{},...options}: WalletOptions & {page?:HTMLElement;onNavigate?:()=>void;onClose?:()=>void}){
  const dialog=createSurface({className:'wallet-dialog',label:'Wallet',pageHost:page,onOpen:onNavigate,onClose});
  const wallet=new WalletView(dialog,options);
  mount(Wallet,{target:dialog,props:{wallet}});
  flushSync();
  dialog.addEventListener('close',()=>wallet.closed());
  // Callers read the wallet right after these resolve.
  const synced=async<T>(work:Promise<T>)=>{try{return await work}finally{flushSync()}};
  const open=()=>synced(wallet.open());
  const timer=setInterval(()=>wallet.poll(),5000);
  window.addEventListener('pagehide',()=>{clearInterval(timer);wallet.client?.destroy();});
  document.getElementById('wallet-tab').onclick=()=>void open();
  return {
    open,
    openToken:(token:string,onReceived?:()=>void)=>synced(wallet.openToken(token,onReceived)),
    payOrder:(order:OrderView,send:(token:string)=>Promise<void>,onDone:()=>void)=>synced(wallet.payOrder(order,send,onDone)),
    escrow:(request:EscrowAction)=>wallet.escrow(request),
    refreshDisplay:()=>{wallet.render();flushSync();},
    hide:()=>{dialog.hide();flushSync();},
  };
}
