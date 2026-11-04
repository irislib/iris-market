(() => {
  'use strict';
  const E=globalThis.IrisEscrow;
  const node=(name,text,cls)=>{const el=document.createElement(name);if(text!=null)el.textContent=String(text);if(cls)el.className=cls;return el;};
  const caption=s=>node('p',s,'esc-caption');
  const amount=(s,m)=>s.toLocaleString() + (/testnut/.test(new URL(m).hostname)||new URL(m).hostname==='127.0.0.1'?' test sats':' sats');
  const fiatPayment=f=>f.price+' '+f.currency+(f.method==='cash'?' in cash':' by bank transfer');
  function field(label,control){const l=node('label',label,'esc-field');l.append(control);return l;}
  function mount(host,api,selection){
    const order=selection.order;
    let draft={amount:'',mint:'',provider:order?.provider||'',query:''}, recovered=false;
    const pendingTradeId=selection.trade_id||E.uid();
    let savedOrderId, discussionDraft='', discussionOpen=false, pendingComment, directory, directoryChecked=false;
    let id=selection.trade_id, listingId=selection.listing_id, context, fee, checkedToken, pending=false, disposed=false, epoch=0, prompt, lastState='',error='';
    const checked=()=>{if(disposed)throw Error('This trade has closed.');};
    const call=async(method,args={})=>{checked();const answer=await api(method,args);checked();return answer;};
    const person=p=>context.names?.[p] || context.contacts.find(c=>c.id===p)?.name || p.slice(0,10)+'…'+p.slice(-4);
    function button(label,action,secondary=false){const b=node('button',label,secondary?'esc-secondary':'esc-primary');b.type='button';b.disabled=pending;b.onclick=()=>run(action);return b;}
    async function run(action){if(pending||disposed)return;pending=true;error='';const buttons=host.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
      try{await action();}catch(e){error=e?.message||'This action could not be completed.';}
      finally{pending=false;if(!disposed)await render(true);}
    }
    const row=(label,value)=>{const el=node('div',null,'esc-row');el.append(node('span',label),node('strong',value));return el;};
    function banner(parent){if(!error)return;const note=node('p',error,'esc-error');note.setAttribute('role','alert');parent.append(note);}
    function actionBox(title,copy){const section=node('section',null,'esc-panel');section.append(node('h3',title),caption(copy));return section;}
    function heading(title,subtitle){const h=node('header');h.append(node('p','PRIVATE TRADE','esc-eyebrow'),node('h2',title),caption(subtitle));return h;}
    async function state(){
      context=await call('context');if(!context.enabled||!context.owner)throw Error('Enable escrow in Settings and sign in to use this trade.');
      if(!id)return null;
      const records=await call('records',{trade_id:id});
      const trade=await E.project(records,id,context.owner);
      if(!trade && order?.resume && context.allowFunding!==false)return null;
      if(!trade)throw Error('The private invitation has not reached this device yet.');
      return trade;
    }
    async function start(){
      const l=await call('listing',{id:listingId});
      if(l.escrow_candidates?.length || directory){
        const people=new Map(context.contacts.map(p=>[p.id,p]));
        for(const entry of [...(l.escrow_candidates||[]),...(directory||[])]){
          const known=people.get(entry.id);
          people.set(entry.id,{...known,...entry,name:entry.name==='Unnamed user' && known?.name?known.name:entry.name});
        }
        context.contacts=[...people.values()];
      }
      const form=node('form',null,'esc-panel');
      form.append(heading(l.title,order?'Choose an escrow provider for your order.':'Choose an escrow provider for this trade.'));
      if(order)form.append(row('Quantity',String(order.quantity)));
      const sats=node('input');sats.type='number';sats.min='1';sats.max='1000000000000';sats.step='1';sats.required=true;
      if(l.escrow?.trade==='bitcoin_fiat'){
        sats.value=String(l.escrow.sats);sats.readOnly=true;
        const fiat=fiatPayment({price:l.price,currency:l.currency,method:l.escrow.method});
        form.append(caption(l.side==='offer'?'You are buying bitcoin. Pay '+fiat+' after verifying the locked bitcoin.':'You are selling bitcoin. Collect '+fiat+' before authorizing its release.'));
      }
      else if(['SAT','SATS'].includes(l.currency?.toUpperCase())&&Number.isSafeInteger(Number(l.price))&&Number(l.price)>0)sats.value=String(Number(l.price)*(order?.quantity||1));
      const mint=node('select');for(const url of context.mints){const option=node('option',new URL(url).hostname);option.value=url;mint.append(option);}
      if(!sats.readOnly && draft.amount)sats.value=draft.amount;
      if(draft.mint && [...mint.options].some(o=>o.value===draft.mint))mint.value=draft.mint;
      const search=node('input');search.type='search';search.placeholder='Name, npub or public key';search.value=draft.query;
      search.autocomplete='off';search.spellcheck=false;
      const matches=node('div',null,'esc-results'), selected=node('div',null,'esc-selected'), status=caption('');
      const btn=node('button',order?'Request order with escrow':'Send private invitation','esc-primary');btn.type='submit';
      const discover=button('Find public escrow services',async()=>{
        directory=await call('discoverProviders',{listing_id:listingId});directoryChecked=true;
      },true);
      const fixed=!!(order?.resume || savedOrderId);
      function choose(key){draft.provider=key;refresh();}
      function refresh(){
        matches.replaceChildren();selected.replaceChildren();
        const key=draft.provider;
        btn.disabled=pending||!key||!mint.value;
        if(key){
          const chosen=context.contacts.find(p=>p.id===key);
          selected.append(row('Selected provider',chosen?.name||context.names?.[key]||'Profile address'),node('code',key));
          if(!fixed){const change=node('button','Change provider','esc-secondary');change.type='button';
            change.onclick=()=>{choose('');search.focus();};selected.append(change);}
        }
        search.parentElement.hidden=!!key;matches.hidden=!!key;status.hidden=!!key;selected.hidden=!key;discover.hidden=!!key;
        if(key)return;
        const value=search.value.trim();
        const results=E.candidates(context.contacts,context.owner,l.author,value);
        status.textContent=results.length?'Choose a profile to invite.':value?'No matching profiles on this device. You can paste a profile address.':'Search by name, paste a public profile address, or look up public escrow services.';
        if(directoryChecked && !results.length)status.textContent=value?'No matching provider found. Try a different name or paste an npub.':'No escrow services found on these relays. You can still invite someone by npub.';
        for(const p of results.slice(0,8)){
          const b=node('button',null,'esc-person');b.type='button';
          const badges=[p.advertised?'Offers escrow':null,p.mutual?'You both follow':p.contact?'Private contact':null].filter(Boolean);
          b.append(node('strong',p.name),caption((badges.length?badges.join(' · ')+' · ':'')+p.id.slice(0,10)+'…'+p.id.slice(-6)));
          b.onclick=()=>choose(p.id);matches.append(b);
        }
        if(/^(?:nostr:)?npub1[0-9a-z]+$/i.test(value)||/^[a-f0-9]{64}$/i.test(value)){
          const use=node('button','Use this profile address','esc-secondary');use.type='button';
          use.onclick=()=>run(async()=>{const key=await call('profileKey',{value:value.replace(/^nostr:/i,'')});if(!key||key===context.owner||key===l.author)throw Error('Choose someone other than the buyer or seller.');draft.provider=key;});matches.append(use);
        }
      }
      search.oninput=()=>{draft.query=search.value;refresh();};
      sats.oninput=()=>{draft.amount=sats.value;};mint.onchange=()=>{draft.mint=mint.value;};
      form.append(field('Search escrow providers',search),status,matches,discover,selected,
        field(order?'Order total in sats':'Amount in sats',sats),field('Wallet mint',mint),
        caption('The merchant and provider can each decline. No funds move until all three people approve and the funder confirms payment.'),btn);
      refresh();
      form.onsubmit=e=>{e.preventDefault();void run(async()=>{
        const third=await call('profileKey',{value:draft.provider});
        const current=await call('listing',{id:listingId});
        if(current.event_id!==l.event_id)throw Error('The listing changed. Reopen the listing to review it.');
        const d=E.dealFromListing(current,context.owner,third,mint.value,Number(sats.value));
        const tradeId=pendingTradeId;
        if(order){
          savedOrderId=await call('createOrder',{listing_id:listingId,trade_id:tradeId,provider:third,quantity:order.quantity,note:order.note});
          Object.assign(d,{order_id:savedOrderId,quantity:order.quantity});E.validateDeal(d);
          await E.exactOrder(call,context.owner,tradeId,d);
        }
        await E.send(call,context.owner,tradeId,d,{action:'invite',deal:d});
        id=tradeId;await E.join(call,context.owner,{id,d,dealHash:await E.hash(d)});
      });};
      return form;
    }
    async function render(force=false){
      const revision=++epoch;
      try{
        const t=await state();if(disposed||revision!==epoch)return;
        if(!t){if(!force&&host.childElementCount)return;const form=await start();if(disposed||revision!==epoch)return;banner(form);host.replaceChildren(form);return;}
        const fingerprint=await E.hash([t.id,t.terms,t.token?.length,t.disputed,Object.keys(t.joins),[...t.approved].sort(),Object.keys(t.payouts),Object.values(t.cosigns).map(x=>x.length),t.settled,t.rated,t.declined,t.messages.map(m=>m.id)]);
        if(!force&&fingerprint===lastState)return;lastState=fingerprint;
        const {d}=t,me=context.owner, peers=E.parties(d);
        const push=async(action,more={},source=t)=>E.send(call,me,source.id,d,{action,deal_hash:source.dealHash,terms_hash:source.termsHash,...more});
        const current=async()=>{const s=await state();if(!s||s.id!==t.id||s.dealHash!==t.dealHash||s.termsHash!==t.termsHash||s.declined!==t.declined)throw Error('The trade changed. Review the latest terms.');return s;};
        const ownKey=async()=>{const {key}=await E.wallet(call,t.id,'key');if(t.joins[me]?.key!==key)throw Error('Open the Iris wallet you used to join this trade.');};
        const w=(op,extra={})=>E.wallet(call,t.id,op,{terms:t.terms,...extra});
        const checkFunds=async()=>{await w('check',{token:t.token});checkedToken=t.token;};
        const completed=t.settled.release?'release':t.settled.refund?'refund':null;
        const container=node('div',null,'esc-trade');container.append(heading(d.title,me===d.provider?'Your escrow job':d.order_id?'Order with escrow':'Escrow agreement'));
        const info=node('section',null,'esc-panel');
        if(d.quantity)info.append(row('Quantity',String(d.quantity)));
        info.append(row('Amount',amount(d.sats,d.mint)));
        if(d.fiat)info.append(row('Fiat payment',d.fiat.price+' '+d.fiat.currency),row('Payment method',d.fiat.method==='cash'?'Cash in person':'Bank transfer'));
        info.append(row('Paid by',d.funder===me?'You':person(d.funder)),row('Paid to',d.beneficiary===me?'You':person(d.beneficiary)),row('Provider',d.provider===me?'You':person(d.provider)),row('Mint',new URL(d.mint).host));
        const identities=node('details',null,'esc-identities');identities.append(node('summary','Participant profiles'));
        for(const [role,key] of [['Buyer',d.buyer],['Seller',d.seller],['Provider',d.provider]])identities.append(row(role,key));
        info.append(identities);container.append(info);
        let stage=completed?'Complete':t.token?'Settlement':t.approved.size===3?'Funding':'Agreement';
        const rail=node('ol',null,'esc-progress');rail.setAttribute('aria-label','Trade progress');
        for(const label of ['Agreement','Funding','Settlement','Complete']){const li=node('li',label);if(label===stage)li.setAttribute('aria-current','step');rail.append(li);}container.append(rail);
        function box(title,copy){const section=actionBox(title,copy);container.append(section);return section;}
        const decline=async()=>{
          const fresh=await current();if(fresh.approved.has(me)||fresh.token)throw Error('You already approved these terms.');
          await push('decline');
        };
        if(t.disputed && me===d.provider && !completed)box('Help requested','Read the trade discussion or contact either trader privately before deciding whether to co-sign a release or a refund.');
        if(t.declined){
          box('Invitation declined',(t.declined===me?'You declined':person(t.declined)+' declined')+' this invitation. No funds were locked.'+(d.order_id && me===d.buyer?' Cancel the request in Orders before choosing another provider.':''));
        }else if(completed){
          const payee=E.recipient(d,completed);
          box(completed==='release'?'Payment released':'Payment refunded',me===payee?'The Iris wallet received the funds.':person(payee)+' confirmed receiving the funds in Iris.');
          if(me!==d.provider && !t.rated){
            const panel=box('Rate the provider','Your rating is public on the provider’s profile. The trade and its amount stay private.');
            const stars=node('select');for(let i=5;i>=1;i--){const o=node('option',i+' '+(i===1?'star':'stars'));o.value=String(i);stars.append(o);}
            panel.append(field('Rating',stars),button('Publish rating',async()=>{await call('rate',{profile:d.provider,rating:Number(stars.value),trade_id:t.id});await push('rated');},true));
          }
        }else if(!t.joins[me]){
          const panel=box(me===d.provider?'Invitation to provide escrow':'Review the invitation',me===d.provider?'Review the two traders, total and mint. Accept only if you are willing to help with a dispute. You can review the final terms before funds move.':'Join with a new spending key from your Iris wallet. You will review the agreement before anyone pays.');
          if(me===d.provider && context.canProvide===false)panel.append(caption('Open this job on a device that stores your profile key to accept it.'));
          else if(!context.mints.includes(d.mint))panel.append(caption('This wallet does not support the proposed mint. Ask the traders to use a supported mint.'));
          else panel.append(button(me===d.provider?'Accept job':me===d.seller && d.order_id?'Accept order and provider':me===d.maker?'Accept proposed provider':'Join trade',async()=>{const fresh=await current();if(fresh.declined)throw Error('This invitation was declined.');await E.join(call,me,fresh);}));
          panel.append(button(me===d.provider?'Decline job':'Decline invitation',decline,true));
        }else if(!t.terms){
          const missing=peers.filter(p=>!t.joins[p]);const b=box('Waiting for participants',missing.map(person).join(' and ')+(missing.length===1?' still needs':' still need')+' to join.');b.append(button('Withdraw from invitation',decline,true));
        }else if(!t.approved.has(me)){
          const panel=box('Approve the agreement','Two of the three participants must sign to spend the payment. There is no automatic timeout refund.');
          panel.append(button('Approve terms',async()=>{await current();await E.exactListing(call,d);await E.exactOrder(call,me,t.id,d,true);await ownKey();await push('approve');}),button('Decline terms',decline,true));
        }else if(t.approved.size<3){
          const missing=peers.filter(p=>!t.approved.has(p));box('Waiting for approval',missing.map(person).join(' and ')+(missing.length===1?' still needs':' still need')+' to approve the agreed wallet keys.');
        }else if(!t.token){
          if(me===d.funder){
            const panel=box('Fund escrow','Your Iris wallet will lock the payment at the agreed mint.');
            if(fee)panel.append(row('Maximum wallet fee',amount(fee.fee,d.mint)),row('Maximum total',amount(fee.max_total,d.mint)));
            if(recovered)panel.append(caption('Your wallet already made this payment. Share its locked proofs with the other participants.'));
            panel.append(button(recovered?'Share saved payment':context.allowFunding===false?'Recover a saved payment':fee?'Confirm and fund escrow':'Review wallet fee',async()=>{
              const s=await current();if(s.token)throw Error('Funding has already been shared.');
              await ownKey();
              const saved=await w('recover_funding');
              if(saved.token){if(recovered){await push('funded',{token:saved.token});recovered=false;}else {recovered=true;fee=null;}return;}
              if(context.allowFunding===false)throw Error('No saved payment found. Enable escrow in Settings to fund this trade.');
              await E.exactListing(call,d);await E.exactOrder(call,me,t.id,d,true);
              if(!fee){fee=await w('preview_fund');return;}
              const result=await w('fund',{max_fee:fee.fee});await push('funded',{token:result.token});fee=null;
            }));
          }else box('Waiting for funding',person(d.funder)+' can now fund the agreed amount.');
        }else{
          const verified=checkedToken===t.token;
          const panel=box(verified?'Funds verified':'Check the escrow payment',verified?'The mint confirmed the locked funds. Check again before handing over goods or sending fiat.':'The funder shared a locked payment. Check its signatures, amount and current status at the mint.');
          panel.append(button(verified?'Check again':'Verify funds',checkFunds,true));
          if(verified||Object.keys(t.payouts).length){
            for(const direction of ['release','refund']){
              const payee=E.recipient(d,direction),toMe=payee===me,swap=t.payouts[direction];
              const title=direction==='release'?'Release payment':'Refund payment';
              const params={token:t.token,direction,recipient_key:t.joins[payee].key};
              if(!swap && toMe && verified){
                const b=box(title,direction==='release'?'Request payment after fulfilling your side of the trade.':'Request your funds back if the trade will not proceed.');
                b.append(button(direction==='release'?'Request release':'Request refund',async()=>{await current();await ownKey();await checkFunds();const {swap}=await w('prepare',params);await push('payout',{direction,swap});},direction==='refund'));
              }else if(swap){
                const cosigned=t.cosigns[direction];
                if(toMe && cosigned.length){
                  const b=box(title,'A second signature is available. Your wallet can now collect the payment.');
                  b.append(button(direction==='release'?'Receive payment':'Receive refund',async()=>{await current();await ownKey();let error;
                    for(const candidate of cosigned){try{await w('complete',{...params,swap:candidate});error=null;break;}catch(e){error=e;}}
                    if(error)throw error;await push('settled',{direction});
                  }));
                }else if(!toMe && !cosigned.length && (me!==d.provider||t.disputed)){
                  const reminder=d.fiat && direction==='release' && me===d.funder?'Confirm you received '+fiatPayment(d.fiat)+' before signing.':'Check the trade before you approve.';
                  const b=box(title,'Signing lets '+person(payee)+' receive '+amount(d.sats,d.mint)+'. '+reminder);
                  const confirming=prompt===direction;
                  b.append(button(confirming?'Confirm '+direction:'Review '+direction,async()=>{if(!confirming){prompt=direction;return;}
                    await current();await checkFunds();await ownKey();const out=await w('cosign',{...params,swap});await push('cosign',{direction,swap:out.swap});prompt=null;
                  },direction==='refund'));
                }else box(title,cosigned.length?'Waiting for the recipient to collect the funds.':'Waiting for a second signature.');
              }
            }
            if(!t.disputed && me!==d.provider)panel.append(button('Ask provider for help',()=>push('dispute'),true));
            if(t.disputed)panel.append(caption('The provider has been asked to help. Discuss the outcome privately before signing.'));
          }
        }
        if(t.terms && !t.declined){
          const room=node('details',null,'esc-panel');room.open=discussionOpen||t.disputed;
          room.ontoggle=()=>{discussionOpen=room.open;};
          room.append(node('summary','Trade discussion'+(t.messages.length?' ('+t.messages.length+')':'')),
            caption('Visible to the buyer, merchant and escrow provider.'));
          const log=node('div',null,'esc-log');log.setAttribute('aria-label','Trade discussion messages');
          if(!t.messages.length)log.append(caption('No messages here yet.'));
          for(const msg of t.messages){
            const line=node('div');line.append(node('strong',msg.author===me?'You':person(msg.author)),node('p',msg.text));log.append(line);
          }
          const input=node('textarea');input.rows=2;input.maxLength=2000;input.value=discussionDraft;
          const send=button('Send to all three',async()=>{
            const text=input.value.trim();if(!text || new TextEncoder().encode(text).length>2000)throw Error('Write a message of up to 2,000 bytes.');
            if(pendingComment?.text!==text)pendingComment={message_id:E.uid(),text};
            await push('comment',pendingComment);discussionDraft='';pendingComment=null;
          });
          send.disabled=pending || !input.value.trim();
          input.oninput=()=>{discussionDraft=input.value;send.disabled=pending||!input.value.trim();};
          room.append(log,field('Message all three',input),send);container.append(room);
        }
        const privateBox=box('Private messages','Only you and the person you choose will see that conversation.');
        const contacts=me===d.provider?[d.buyer,d.seller]:[d.provider];
        for(const peer of contacts){
          const role=peer===d.provider?'provider':peer===d.buyer?'buyer':'seller';
          privateBox.append(button('Message '+role+' privately',()=>call('contact',{peer,trade_id:t.id}),true));
        }
        const focused=host.contains(document.activeElement) && document.activeElement.tagName==='TEXTAREA';
        banner(container);host.replaceChildren(container);
        if(focused){const input=container.querySelector('textarea');input?.focus();input?.setSelectionRange(input.value.length,input.value.length);}

      }catch(e){if(disposed||revision!==epoch)return;const box=actionBox('Trade unavailable',e?.message||'Try reopening this trade.');box.append(button('Try again',async()=>{}));host.replaceChildren(box);}
    }
    void render(true);
    return {refresh:()=>{if(!pending&&id)void render();},close:()=>{disposed=true;epoch++;host.replaceChildren();}};
  }
  globalThis.IrisEscrow.mount=mount;
})();
