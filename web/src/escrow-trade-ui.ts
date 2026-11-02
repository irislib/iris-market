import '../../shared/escrow/trade.js';
import '../../shared/escrow/screen.js';
import {marketplaceToolEnabled} from './marketplace-tools.ts';
import {normalizePublicKey} from './social.ts';
import {nameFor} from './people.ts';
import {buildReviewDraft} from './reviews.ts';
import {configuredLocalTestMint,DEFAULT_SUPPORTED_MINTS} from './wallet/mints.ts';
import {createSurface} from './surface.ts';

type Selection={trade_id?:string;listing_id?:string};
type Call=(method:string,args:Record<string,any>)=>Promise<unknown>;
const engine=(globalThis as unknown as {IrisEscrow:{mount:(host:HTMLElement,api:Call,selection:Selection)=>{refresh():void;close():void};list:(records:unknown[],owner:string)=>Array<{id:string;title:string;status:string;joined:boolean;deal:Record<string,string>}>}}).IrisEscrow;

export function setupEscrowTrade({account,wallet,lookup,isPreview}:{account:()=>any;wallet:()=>any;lookup:(id:string,latest?:boolean)=>Promise<any>;isPreview:()=>boolean}){
  let running:ReturnType<typeof engine.mount>, screen:ReturnType<typeof createSurface>;
  const enabled=()=>marketplaceToolEnabled('escrow')&&!isPreview();
  async function open(selection:Selection){
    const recover=()=>!!selection.trade_id&&!isPreview() && account()?.state().tradeSteps?.some(r=>r.mine && r.step.trade_id===selection.trade_id && r.step.action==='join');
    if(!enabled()&&!recover())return;
    const a=account();await a.restored;const initial=a.state();
    if(initial.status!=='ready'||!initial.ownerPubkey){a.showAccount();return;}
    const owner=initial.ownerPubkey;screen?.close();
    const dialog=createSurface({className:'account-dialog escrow-dialog',label:'Escrow trade'});screen=dialog;
    dialog.style.width='min(100%, 40rem)';
    const close=document.createElement('button');close.type='button';close.className='dialog-close icon-button';close.textContent='×';close.setAttribute('aria-label','Close trade');close.onclick=()=>dialog.close();
    const body=document.createElement('div');body.className='esc-root';dialog.append(close,body);
    if(!document.querySelector('link[data-escrow-style]')){const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('escrow.css',document.baseURI).href;css.dataset.escrowStyle='true';document.head.append(css);}
    const call:Call=async(method,args)=>{
      const s=a.state();if((!enabled()&&!recover())||s.ownerPubkey!==owner||s.status!=='ready')throw Error('Sign back in to this profile to continue.');
      switch(method){
        case 'context':{
          const names=Object.fromEntries((s.tradeSteps??[]).flatMap(row=>{const d=row.step.deal;return d?[d.buyer,d.seller,d.provider].filter(k=>/^[0-9a-f]{64}$/.test(k)).map(k=>[k,nameFor(k)]):[];}));
          return {owner,names,enabled:true,allowFunding:enabled(),contacts:s.conversations.map(p=>({id:p.pubkey,name:nameFor(p.pubkey)})),mints:[configuredLocalTestMint(),...DEFAULT_SUPPORTED_MINTS].filter(Boolean)};}
        case 'profileKey':return normalizePublicKey(args.value);
        case 'records':return (await a.messaging.tradeSteps()).filter(r=>r.step.trade_id===args.trade_id);
        case 'certificate':return a.messaging.escrowProvider(args.key);
        case 'send':return a.messaging.sendTradeStep(args.peers,args.step,args.operation_id);
        case 'listing':{const l=await lookup(args.id,args.latest===true);if(!l)throw Error('Open the listing while connected, then return to the trade.');return {id:l.id,title:l.title,author:l.author,side:l.side,escrow:l.escrow,event_id:l.eventId,status:l.status,price:l.price,currency:l.currency,expires_at:l.expiration};}
        case 'wallet':{
          if(args.op==='fund'&&!enabled())throw Error('Enable escrow in Settings before funding a trade.');
          if(!s.canSend&&['fund','prepare','cosign','complete'].includes(args.op))throw Error('Approve this device for private messages before moving funds.');
          return wallet().escrow(args);
        }
        case 'rate':return a.messaging.publishEvent(buildReviewDraft({target:args.profile,author:owner,rating:args.rating}));
        default:throw Error('Unavailable trade action.');
      }
    };
    const mounted=engine.mount(body,call,selection);running=mounted;
    const listener=a.onState(s=>{if((!enabled()&&!recover())||s.ownerPubkey!==owner||s.status!=='ready'){dialog.close();return;}mounted.refresh();});
    dialog.addEventListener('close',()=>{listener?.();mounted.close();dialog.remove();if(screen===dialog){screen=undefined;running=undefined;}},{once:true});
    dialog.showModal();
  }
  function entry(label:string,selection:Selection){
    const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=label;b.onclick=()=>open(selection);return b;
  }
  function inbox(host:HTMLElement,peer?:string,listing?:string){
    const a=account();if(isPreview()||a?.state().status!=='ready')return;
    const coordinate=listing?.replace(/^30402:/,'');
    const s=a.state(), trades=engine.list(s.tradeSteps??[],s.ownerPubkey).filter(t=>(enabled()||t.joined)&&(!peer||[t.deal.buyer,t.deal.seller,t.deal.provider].includes(peer))&&(!coordinate||coordinate===t.deal.listing_id));
    if(!trades.length)return;
    const group=document.createElement('section');group.dataset.escrowTrades='true';group.setAttribute('aria-label','Escrow trades');
    for(const t of trades)group.append(entry('Escrow · '+t.title+' · '+Number(t.deal.sats).toLocaleString()+' sats · '+t.status,{trade_id:t.id}));
    const heading=host.querySelector(':scope > h2');if(heading)heading.after(group);else host.append(group);
  }
  return {inbox,entry:(l:any)=>enabled()&&l.escrow&&l.author!==account()?.state().ownerPubkey?entry('Arrange escrow',{listing_id:l.id}):null,refresh:()=>running?.refresh()};
}
