import '../../shared/escrow/trade.js';
import '../../shared/escrow/screen.js';
import {element as node} from './dom.ts';
import {marketplaceToolEnabled} from './marketplace-tools.ts';
import {normalizePublicKey} from './social.ts';
import {escrowCandidates} from './profiles.ts';
import {advertisedProviders,findEscrowServices} from './escrow-directory.ts';
import type {MarketListing} from './market.ts';
import type {OrderView,DeliveryRequest} from './orders.ts';
import {nameFor} from './people.ts';
import {buildReviewDraft} from './reviews.ts';
import {configuredLocalTestMint,DEFAULT_SUPPORTED_MINTS} from './wallet/mints.ts';
import {createSurface} from './surface.ts';

type Checkout={quantity:number;note:string;deliveryRequest?:DeliveryRequest;provider?:string;resume?:boolean};
type Selection={trade_id?:string;listing_id?:string;order?:Checkout};
type ProviderDraft={title:string;side:'offer';category:'services';tags:string[]};
type OpenOptions={onOrder?:(order:OrderView)=>void;maker?:string};
type Call=(method:string,args:Record<string,any>)=>Promise<unknown>;
const engine=(globalThis as unknown as {IrisEscrow:{mount:(host:HTMLElement,api:Call,selection:Selection)=>{refresh():void;close():void};list:(records:unknown[],owner:string)=>Array<{id:string;title:string;status:string;joined:boolean;deal:Record<string,string>}>}}).IrisEscrow;

export function setupEscrowTrade({account,wallet,lookup,isPreview,relays,inventory,onOffer}:{inventory:()=>MarketListing[];onOffer:(draft:ProviderDraft)=>void;relays:()=>readonly string[];account:()=>any;wallet:()=>any;lookup:(id:string,latest?:boolean)=>Promise<any>;isPreview:()=>boolean}){
  let running:ReturnType<typeof engine.mount>, screen:ReturnType<typeof createSurface>;
  const enabled=()=>marketplaceToolEnabled('escrow')&&!isPreview();
  const canProvide=()=>{const s=account()?.state();return s?.status==='ready'&&s.canSign&&s.mode==='local';};
  async function open(selection:Selection,{onOrder,maker}:OpenOptions={}){
    let activeTrade=selection.trade_id;
    const directory=new Map<string,MarketListing>();
    const recover=()=>!!activeTrade&&!isPreview() && account()?.state().tradeSteps?.some(r=>r.mine && r.step.trade_id===activeTrade && r.step.action==='join');
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
          return {owner,names,enabled:true,canProvide:canProvide(),allowFunding:enabled(),contacts:selection.listing_id&&(!activeTrade||selection.order?.resume)?escrowCandidates(owner,maker,s.conversations.map(p=>p.pubkey),relays(),advertisedProviders(inventory(),directory)):s.conversations.map(p=>({id:p.pubkey,name:nameFor(p.pubkey),contact:true})),mints:[configuredLocalTestMint(),...DEFAULT_SUPPORTED_MINTS].filter(Boolean)};}
        case 'discoverProviders':{
          if(!enabled() || activeTrade || args.listing_id!==selection.listing_id)throw Error('Open checkout and enable escrow to find providers.');
          const servers=relays();
          await findEscrowServices(directory,servers);
          if(!enabled() || a.state().ownerPubkey!==owner)throw Error('Reopen checkout for this profile.');
          return escrowCandidates(owner,maker,s.conversations.map(p=>p.pubkey),servers,advertisedProviders(inventory(),directory));
        }
        case 'profileKey':return normalizePublicKey(String(args.value).trim().replace(/^nostr:/i,''));
        case 'createOrder':{
          const checkout=selection.order;
          if(!enabled()||!checkout||selection.listing_id!==args.listing_id||checkout.quantity!==args.quantity||checkout.note!==args.note||
            (checkout.provider&&checkout.provider!==args.provider)||(activeTrade&&args.trade_id!==activeTrade))throw Error('Reopen checkout to review this order.');
          // Use the already reviewed listing. The ceremony separately verifies its signed revision.
          const listing=await lookup(args.listing_id);
          if(!listing||listing.author!==maker)throw Error('Reopen the listing to review this order.');
          const order=await a.messaging.requestOrder(listing,{quantity:checkout.quantity,note:checkout.note,deliveryRequest:checkout.deliveryRequest,escrowProvider:args.provider,escrowTradeId:args.trade_id});
          activeTrade=args.trade_id;onOrder?.(order);return order.id;
        }
        case 'order':{
          const order=s.orders?.find(o=>o.id===args.id);
          if(!order||![order.buyer,order.seller].includes(owner))throw Error('The private order has not reached this device yet.');
          return {id:order.id,buyer:order.buyer,seller:order.seller,listing_id:order.items[0].id,provider:order.escrowProvider,trade_id:order.escrowTradeId,status:order.status,quantity:order.items[0].quantity};
        }
        case 'acceptOrder':{
          const order=s.orders?.find(o=>o.id===args.id);
          if(!enabled()||!order||order.seller!==owner||order.escrowTradeId!==args.trade_id||args.trade_id!==activeTrade||
              !matchingTrade(order,s))throw Error('Open the matching order to review this provider.');
          if(order.status==='requested')await a.messaging.updateOrder(order.id,{status:'accepted'});
          else if(!['accepted','in-transit'].includes(order.status))throw Error('This order has closed.');
          return true;
        }
        case 'records':return (await a.messaging.tradeSteps()).filter(r=>r.step.trade_id===args.trade_id);
        case 'certificate':return a.messaging.escrowProvider(args.key);
        case 'send':{
          const step=args.step;
          if(activeTrade?activeTrade!==step.trade_id:step.action!=='invite'||step.deal?.listing_id!==selection.listing_id||step.deal?.taker!==owner)throw Error('Reopen the selected trade.');
          await a.messaging.sendTradeStep(args.peers,step,args.operation_id);activeTrade=step.trade_id;return true;
        }
        case 'listing':{const l=await lookup(args.id,args.latest===true);if(!l)throw Error('Open the listing while connected, then return to the trade.');return {id:l.id,title:l.title,author:l.author,side:l.side,escrow:l.escrow,event_id:l.eventId,status:l.status,price:l.price,currency:l.currency,expires_at:l.expiration};}
        case 'contact':{
          const trade=engine.list(s.tradeSteps??[],owner).find(t=>t.id===activeTrade);
          if(!trade||args.peer===owner||![trade.deal.buyer,trade.deal.seller,trade.deal.provider].includes(args.peer))throw Error('Choose a participant in this trade.');
          dialog.close();await a.openChat(args.peer);return true;
        }
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
    const flagsChanged=()=>{if(!enabled()&&!recover())dialog.close();else mounted.refresh();};
    window.addEventListener('market-tools-change',flagsChanged);
    const listener=a.onState(s=>{if((!enabled()&&!recover())||s.ownerPubkey!==owner||s.status!=='ready'){dialog.close();return;}mounted.refresh();});
    dialog.addEventListener('close',()=>{listener?.();window.removeEventListener('market-tools-change',flagsChanged);mounted.close();dialog.remove();if(screen===dialog){screen=undefined;running=undefined;}},{once:true});
    dialog.showModal();
  }
  function entry(label:string,selection:Selection,options:OpenOptions={}){
    const b=document.createElement('button');b.type='button';b.className='button secondary';b.textContent=label;b.onclick=()=>open(selection,options);return b;
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
  function providerJobs(){
    const s=account()?.state();
    if(isPreview()||s?.status!=='ready')return [];
    return engine.list(s.tradeSteps??[],s.ownerPubkey).filter(t=>t.deal.provider===s.ownerPubkey&&(enabled()||t.joined));
  }
  function jobs(host:HTMLElement){
    const trades=providerJobs();
    const header=node('div',undefined,'escrow-jobs-heading');header.append(node('h3','Escrow jobs'));
    if(enabled()&&canProvide()){
      const offer=node('button','Offer escrow services','button secondary');offer.type='button';
      offer.onclick=()=>{if(enabled()&&canProvide())onOffer({title:'Escrow services',side:'offer',category:'services',tags:['escrow-provider']});};header.append(offer);
    }
    host.append(header);
    if(!trades.length){host.append(node('p',canProvide()?'Private invitations will appear here for you to accept or decline.':'To offer escrow services, open Iris on a device that stores your profile key.','small muted'));return;}
    const past=(status:string)=>['Release receipt','Refund receipt','Declined'].includes(status);
    for(const section of ['Invitations','In progress','Past jobs']){
      const items=trades.filter(t=>(past(t.status)?'Past jobs':t.status==='Help requested'||t.joined?'In progress':'Invitations')===section);
      if(!items.length)continue;
      if(section==='In progress')items.sort((a,b)=>Number(b.status==='Help requested')-Number(a.status==='Help requested'));
      const list=node('section',undefined,'orders-list escrow-job-list');list.setAttribute('aria-label',section);
      list.append(node('p',section,'small muted'));
      for(const t of items){
        const card=entry('',{trade_id:t.id});card.className='order-card';
        const copy=node('span',undefined,'order-card-copy');copy.append(node('strong',t.title,'order-card-title'),node('span',nameFor(t.deal.buyer)+' · '+nameFor(t.deal.seller),'small muted'));
        const aside=node('span',undefined,'order-card-aside');aside.append(node('strong',Number(t.deal.sats).toLocaleString()+' sats','order-card-price'),node('span',t.status,t.status==='Help requested'?'order-status order-status-requested':'order-status'));
        card.append(copy,aside);list.append(card);
      }
      host.append(list);
    }
  }
  function matchingTrade(order:OrderView,state){
    return engine.list(state.tradeSteps??[],state.ownerPubkey).find(t=>t.id===order.escrowTradeId&&t.deal.order_id===order.id&&
      t.deal.provider===order.escrowProvider&&t.deal.seller===order.seller&&t.deal.buyer===order.buyer&&
      t.deal.listing_id===order.items[0].id&&Number(t.deal.quantity)===order.items[0].quantity);
  }
  function linked(order:OrderView):HTMLElement|null {
    const s=account().state(), id=order.escrowTradeId;
    if(!id||![order.buyer,order.seller].includes(s.ownerPubkey)||isPreview())return null;
    const trade=matchingTrade(order,s);
    if(!enabled()&&!trade?.joined){
      if(order.status!=='requested')return null;
      return node('p','Enable Escrow in Settings to review the provider for this order.','small muted');
    }
    const panel=document.createElement('section');panel.className='order-payment';
    const h=document.createElement('h3');h.textContent='Escrow';const p=document.createElement('p');p.className='small muted';
    p.textContent='Provider · '+nameFor(order.escrowProvider);panel.append(h,p);
    if(trade){
      const reviewing=order.seller===s.ownerPubkey&&order.status==='requested'&&!trade.joined&&trade.status==='Invitation';
      if(reviewing)panel.append(node('p','The buyer proposed this provider for your order.','small muted'));
      panel.append(entry(reviewing?'Review order and provider':'Open escrow · '+trade.status,{trade_id:id}));
    }
    else if(s.ownerPubkey===order.buyer&&order.status!=='cancelled')
      panel.append(entry('Finish escrow invitation',{trade_id:id,listing_id:order.items[0].id,order:{quantity:order.items[0].quantity,note:order.note,deliveryRequest:order.deliveryRequest,provider:order.escrowProvider,resume:true}},{maker:order.seller}));
    else {const status=document.createElement('p');status.textContent=order.status==='cancelled'?'Order cancelled':'Waiting for the buyer’s private invitation.';panel.append(status);}
    return panel;
  }
  return {inbox,jobs,showJobs:()=>enabled()||providerJobs().length>0,linked,
    canCheckout:(l:any)=>enabled()&&l.side==='offer'&&l.escrow?.trade==='goods'&&l.author!==account()?.state().ownerPubkey,
    checkout:(l:any,order:Checkout,onOrder:(order:OrderView)=>void)=>open({listing_id:l.id,order},{maker:l.author,onOrder}),
    entry:(l:any)=>enabled()&&l.escrow&&(l.side==='request'||l.escrow.trade==='bitcoin_fiat')&&l.author!==account()?.state().ownerPubkey?entry('Arrange escrow',{listing_id:l.id},{maker:l.author}):null,
    refresh:()=>running?.refresh()};

}
