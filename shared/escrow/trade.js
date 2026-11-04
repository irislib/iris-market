// The same escrow ceremony runs in the browser and in the bundled native view.
// Only the host's wallet can sign or spend. This module never receives private keys.
(() => {
  'use strict';
  const hex = /^[0-9a-f]{64}$/, spendingKey = /^0[23][0-9a-f]{64}$/;
  const fail = text => { throw Error(text); };
  const insist = (ok, text) => { if (!ok) fail(text); };
  const equal = (a,b) => canonical(a) === canonical(b);
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  async function hash(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
  }
  const uid = () => [...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const parties = d => [d.buyer,d.seller,d.provider];
  const recipient = (d, direction) => direction === 'release' ? d.beneficiary : d.funder;
  function validateDeal(d) {
    insist(d && ['buyer','seller','provider','funder','beneficiary','maker','taker','revision'].every(k=>typeof d[k]==='string' && hex.test(d[k])), 'This invitation contains an invalid profile or listing revision.');
    const traders=[d.buyer,d.seller];
    insist(new Set(parties(d)).size === 3 && [d.maker,d.taker,d.funder,d.beneficiary].every(k=>traders.includes(k)) && d.maker!==d.taker && d.funder!==d.beneficiary, 'The buyer, seller and provider must be distinct.');
    insist(typeof d.title==='string' && d.title.length<=320 && typeof d.listing_id==='string' && d.listing_id.length<=260 && Number.isSafeInteger(d.sats) && d.sats>0 && d.sats<=1e12 && typeof d.mint==='string' && d.mint.length<=2048, 'This invitation contains invalid trade terms.');
    if (d.order_id !== undefined || d.quantity !== undefined) {
      insist(typeof d.order_id==='string' && d.order_id.startsWith(d.buyer+':') &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.order_id.slice(65)) &&
        d.taker===d.buyer && Number.isInteger(d.quantity) && d.quantity>=1 && d.quantity<=999, 'Invalid order on this invitation.');
    }
    const url=new URL(d.mint);
    insist((url.protocol==='https:' || (url.protocol==='http:' && url.hostname==='127.0.0.1' && !!url.port)) && !url.username && !url.password && !url.hash && !url.search && url.href.replace(/\/$/,'')===d.mint,'Choose a mint supported by this wallet.');
    if(d.fiat)insist(typeof d.fiat==='object' && typeof d.fiat.price==='string' && /^\d{1,12}(?:\.\d{1,2})?$/.test(d.fiat.price) && /^[A-Z]{3}$/.test(d.fiat.currency) && ['bank_transfer','cash'].includes(d.fiat.method),'The fiat quote is invalid.');
    return d;
  }
  function dealFromListing(l, taker, provider, mint, sats) {
    insist(l && l.escrow && ['goods','bitcoin_fiat'].includes(l.escrow.trade), 'This listing does not offer escrow.');
    insist(l.status==='active' && (!l.expires_at || l.expires_at>Math.floor(Date.now()/1000)), 'This listing has closed or expired.');
    const bitcoin=l.escrow.trade==='bitcoin_fiat';
    if(bitcoin) insist(sats===l.escrow.sats,'Use the bitcoin amount on the listing.');
    const buyer=l.side==='request'?l.author:taker, seller=l.side==='request'?taker:l.author;
    return validateDeal({listing_id:l.id,revision:l.event_id,maker:l.author,taker,buyer,seller,provider,
      funder:bitcoin?seller:buyer,beneficiary:bitcoin?buyer:seller,title:l.title,sats,mint,
      ...(bitcoin?{fiat:{price:l.price,currency:l.currency,method:l.escrow.method}}:{})});
  }
  async function exactListing(api,deal,latest=true) {
    const listing=await api('listing',{id:deal.listing_id,latest});
    const expected=dealFromListing(listing,deal.taker,deal.provider,deal.mint,deal.sats);
    if(deal.order_id)Object.assign(expected,{order_id:deal.order_id,quantity:deal.quantity});
    if(!deal.fiat)delete expected.fiat; // Existing proposals already bind the full signed revision.
    insist(equal(deal,expected), 'The listing changed. Start a new trade from the current listing.');
  }
  async function exactOrder(api,owner,id,deal,accepted=false) {
    // The provider receives the agreement, never the private order or its delivery notes.
    if(!deal.order_id || owner===deal.provider)return;
    const o=await api('order',{id:deal.order_id});
    insist(o && o.id===deal.order_id && o.trade_id===id && o.provider===deal.provider &&
      o.buyer===deal.buyer && o.seller===deal.seller && o.listing_id===deal.listing_id && o.quantity===deal.quantity,
      'The matching order has not arrived or names a different provider. Open Orders to check the request.');
    insist(o.status!=='cancelled','This order was cancelled. Start a new order to use escrow.');
    if(accepted)insist(['accepted','in-transit','delivered'].includes(o.status),'Waiting for the merchant’s acceptance to reach Orders.');
    return o;
  }
  function candidates(contacts,owner,maker,query) {
    const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rank=p=>Number(!!p.advertised)*4+Number(!!p.mutual)*2+Number(!!p.contact);
    return contacts.filter(p=>hex.test(p.id) && p.id!==owner && p.id!==maker &&
      (words.length>0 || p.advertised || p.mutual || p.contact) && words.every(w=>[p.name,p.id,p.address].some(x=>x?.toLowerCase().includes(w))))
      .sort((a,b)=>rank(b)-rank(a)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  }
  const actor=(r,owner)=>r.mine?owner:r.peer;
  const validJoin=(s,who,d)=>spendingKey.test(s.key) && !parties(d).includes(s.key.slice(2)) && (who!==d.provider || (s.provider?.profile===d.provider && s.provider?.key===s.key && /^[0-9a-f]{128}$/.test(s.provider?.signature)));
  async function project(records,id,owner) {
    const rows=records.filter(r=>r.step?.v===1 && r.step.trade_id===id);
    const invitations=rows.filter(r=>{const d=r.step.deal;try{return r.step.action==='invite' && validateDeal(d) && parties(d).includes(owner) && actor(r,owner)===d.taker;}catch{return false;}});
    if(!invitations.length)return null;
    const own=rows.find(r=>r.mine && ['join','decline','approve','funded'].includes(r.step.action));
    let d=undefined;
    for(const row of invitations){
      const candidate=row.step.deal;
      if(own && own.step.deal_hash!==await hash(candidate))continue;
      if(d && !equal(d,candidate))fail('Conflicting invitations. Start a fresh trade.');
      d=candidate;
    }
    if(!d)return null;
    const dealHash=await hash(d);
    // A second purported taker's invitation cannot reserve or mutate a known trade.
    const relevant=rows.filter(r=>r.step.deal_hash===dealHash && parties(d).includes(actor(r,owner)));
    function unique(choices, value, description) {
      const values=choices.map(value);
      if(values.some(v=>!equal(values[0],v)))fail('Conflicting '+description+'. Pause this trade and contact the participants.');
      return values[0];
    }
    const joins={};
    for(const p of parties(d)) {
      const choice=unique(relevant.filter(r=>actor(r,owner)===p && r.step.action==='join' && validJoin(r.step,p,d)),r=>({key:r.step.key,...(p===d.provider?{provider:r.step.provider}:{})}),'wallet keys');
      if(choice)joins[p]=choice;
    }
    const ready=parties(d).every(k=>joins[k]);
    if(ready)insist(new Set(parties(d).map(p=>joins[p].key.slice(2))).size===3,'Each participant needs an independent spending key.');
    const terms=ready ? {mint:d.mint,sats:d.sats,buyer_key:joins[d.buyer].key,seller_key:joins[d.seller].key,provider:joins[d.provider].provider} : null;
    const termsHash=ready ? await hash(terms) : '';
    const final=relevant.filter(r=>ready && r.step.terms_hash===termsHash);
    const approved=new Set(final.filter(r=>r.step.action==='approve').map(r=>actor(r,owner)));
    // An approval supersedes an earlier decline on a second device. A late decline
    // must never strand a payment made after all three people approved.
    const declined=parties(d).find(p=>!approved.has(p) && relevant.some(r=>actor(r,owner)===p && r.step.action==='decline'));
    const discussion=new Map();
    for(const r of relevant){
      const s=r.step, who=actor(r,owner);
      if(s.action!=='comment' || !ready || !hex.test(s.message_id) || typeof s.text!=='string' ||
        !s.text.trim() || new TextEncoder().encode(s.text).length>2000)continue;
      const k=who+':'+s.message_id;
      if(!discussion.has(k))discussion.set(k,{id:k,author:who,text:s.text,at:r.created_at??0});
    }
    const messages=[...discussion.values()].sort((a,b)=>a.at-b.at);
    const funded=approved.size===3 ? final.filter(r=>r.step.action==='funded' && actor(r,owner)===d.funder && typeof r.step.token==='string') : [];
    const token=unique(funded,r=>r.step.token,'funding records');
    const disputed=!!token && final.some(r=>r.step.action==='dispute' && actor(r,owner)!==d.provider);
    const payouts={},cosigns={},settled={};
    for(const direction of ['release','refund']){
      const payee=recipient(d,direction);
      const swaps=final.filter(r=>r.step.direction===direction && r.step.swap?.inputs?.length && r.step.swap?.outputs?.length);
      const pay=token && unique(swaps.filter(r=>r.step.action==='payout' && actor(r,owner)===payee),r=>r.step.swap,'payouts');
      if(pay){
        payouts[direction]=pay;
        const second=swaps.filter(r=>r.step.action==='cosign' && actor(r,owner)!==payee && (actor(r,owner)!==d.provider || disputed));
        // Allow a valid co-signer to recover the trade when an earlier package is invalid.
        const distinct = new Map(second.map(r=>[actor(r,owner),r.step.swap]));cosigns[direction]=[...distinct.values()];
        settled[direction]=second.length>0 && final.some(r=>r.step.action==='settled' && r.step.direction===direction && actor(r,owner)===payee);
      }
    }
    return {id,d,dealHash,termsHash,joins,terms,approved,declined,messages,token,disputed,payouts,cosigns,settled,
      rated:final.some(r=>r.step.action==='rated' && actor(r,owner)===owner)};
  }
  async function send(api, owner, id, deal, payload) {
    const step={v:1,trade_id:id,...payload}, peers=parties(deal).filter(p=>p!==owner);
    const operation_id=await hash(['iris-market/trade-step',owner,step]);
    return api('send',{peers,step,operation_id});
  }
  const wallet=(api,id,op,more={})=>api('wallet',{trade_id:id,op,...more});
  async function join(api,owner,t){
    await exactListing(api,t.d,owner!==t.d.taker);
    const order=await exactOrder(api,owner,t.id,t.d);
    const {key}=await wallet(api,t.id,'key');
    const provider=owner===t.d.provider ? await api('certificate',{key}) : undefined;
    if(owner===t.d.seller && order?.status==='requested')await api('acceptOrder',{id:order.id,trade_id:t.id,provider:t.d.provider});
    await send(api,owner,t.id,t.d,{action:'join',deal_hash:t.dealHash,key,...(provider?{provider}:{})});
  }
  function list(records, owner) {
    const items=new Map(),joined=new Set(records.filter(r=>r.mine && r.step?.action==='join').map(r=>r.step.trade_id));
    for(const r of records){
      const s=r.step;
      if(s?.v!==1 || !hex.test(s.trade_id) || s.action!=='invite')continue;
      try{const d=validateDeal(s.deal);if(actor(r,owner)===d.taker && parties(d).includes(owner))items.set(s.trade_id,{id:s.trade_id,title:d.title,deal:d,peer:r.peer,joined:joined.has(s.trade_id),status:s.outcome==='disputed'?'Help requested':s.outcome==='declined'?'Declined':s.outcome==='release'?'Release receipt':s.outcome==='refund'?'Refund receipt':joined.has(s.trade_id)?'In progress':'Invitation'});}catch{}
    }
    return [...items.values()].reverse();
  }
  globalThis.IrisEscrow = {canonical,hash,uid,parties,recipient,validateDeal,dealFromListing,exactListing,exactOrder,candidates,project,send,wallet,join,list};
})();
