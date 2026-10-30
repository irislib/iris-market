import { createSurface } from './surface.ts';
import type { createCashuWallet } from './wallet/client.ts';
type WalletState = Partial<ReturnType<ReturnType<typeof createCashuWallet>['state']>>;
import { byId, element as domElement, formFields } from './dom.ts';
import { DEFAULT_SUPPORTED_MINTS, configuredLocalTestMint, isTestMint, mintUnitLabel } from './wallet/mints.ts';
import type { OrderView } from './orders.ts';
import { formatPaymentNote } from './cashu-content.ts';
const node = domElement;
const sats=(value,mint='')=>new Intl.NumberFormat().format(BigInt(value||'0'))+' '+mintUnitLabel(mint);
const mintName=url=>{try{return new URL(url).hostname}catch{return 'Mint'}};
export function setupWallet({isPreview,formatEstimate=()=>'',loadClient=()=>import('./wallet/client.ts'),onShareMessage,page,onNavigate=()=>{},onClose=()=>{}}: {page?:HTMLElement;onNavigate?:()=>void;onClose?:()=>void;isPreview:()=>boolean;formatEstimate?:(amount:string)=>string;loadClient?:()=>Promise<typeof import('./wallet/client.ts')>;onShareMessage?:(text:string)=>unknown}){
  const developerMint=configuredLocalTestMint(),supportedMints=developerMint?[...DEFAULT_SUPPORTED_MINTS,developerMint]:DEFAULT_SUPPORTED_MINTS;
  const dialog=createSurface({className:'wallet-dialog',label:'Wallet',pageHost:page,onOpen:onNavigate,onClose});
  dialog.innerHTML=[
    '<button class="dialog-close icon-button" id="wallet-close" aria-label="Close wallet">×</button><h2>Wallet</h2><p id="wallet-error" class="error" role="alert"></p><p id="wallet-status" class="small muted" role="status"></p>',
    '<div id="wallet-disabled"><p id="wallet-enable-intro" class="muted">Send and receive bitcoin with Cashu.</p><form id="wallet-enable"><label>Mint<input name="mint" type="url" autocomplete="off" required></label><p class="small muted">Your balance is held by this mint. Your wallet stays on this device.</p><button class="button primary">Enable wallet</button></form><details class="wallet-settings"><summary>Restore a backup</summary><form id="wallet-import"><label>Backup file<input name="backup" type="file" accept="application/json,.json" required></label><label>Backup password<input name="password" type="password" autocomplete="off" required></label><label class="wallet-check"><input name="stopped" type="checkbox" required> I have stopped using the original wallet.</label><p class="small muted">Use your newest backup. An older copy can miss later payments.</p><button class="button secondary">Restore wallet</button></form></details></div>',
    '<form id="wallet-unlock" hidden><label id="wallet-password-label">Password<input name="password" type="password" autocomplete="current-password"></label><button class="button primary">Unlock wallet</button></form>',
    '<div id="wallet-ready" hidden><section id="wallet-order-payment" class="wallet-flow" hidden><h3>Pay order</h3><p id="wallet-order-title"></p><p id="wallet-order-amount"></p><p id="wallet-order-mint" class="small muted"></p><p id="wallet-order-fee" class="small muted"></p><button id="wallet-order-pay" class="button primary">Review payment</button><button id="wallet-order-back" class="text-button">Back to order</button></section><p id="wallet-test-money" class="small muted" hidden>Test money · no bitcoin value</p><label class="sr-only" for="wallet-mint">Mint</label><select id="wallet-mint" aria-label="Wallet mint"></select><div class="wallet-balance"><strong id="wallet-balance">0 sats</strong><span id="wallet-estimate" class="muted"></span></div><div class="wallet-actions"><button id="wallet-receive-tab" class="button primary">Receive</button><button id="wallet-send-tab" class="button secondary">Send</button></div><div id="wallet-pending"></div>',
    '<section id="wallet-receive" class="wallet-flow" hidden><h3>Receive</h3><div class="segments"><button data-receive="lightning" class="selected" aria-pressed="true">Lightning</button><button data-receive="cashu" aria-pressed="false">Cashu</button></div><form id="wallet-invoice-form"><label>Amount in sats<input name="amount" inputmode="numeric" pattern="[0-9]+" required></label><button class="button primary">Create invoice</button></form><div id="wallet-invoice" hidden><label>Lightning invoice<textarea id="wallet-invoice-text" readonly rows="3"></textarea></label><div class="wallet-actions"><button id="wallet-copy-invoice" class="button secondary">Copy invoice</button><button id="wallet-check-invoice" class="text-button">Check payment</button></div><p id="wallet-invoice-state" class="small muted" role="status"></p></div><div id="wallet-saved-invoices"></div><form id="wallet-receive-form" hidden><label>Cashu token<textarea name="token" rows="3" autocomplete="off" spellcheck="false" required></textarea></label><button class="button primary">Review token</button><div id="wallet-receive-preview" hidden><p id="wallet-receive-summary"></p><button id="wallet-receive-confirm" type="button" class="button primary">Receive token</button></div></form></section>',
    '<section id="wallet-send" class="wallet-flow" hidden><h3>Send</h3><div class="segments"><button data-send="cashu" class="selected" aria-pressed="true">Cashu</button><button data-send="lightning" aria-pressed="false">Lightning</button></div><form id="wallet-send-form"><label>Amount in sats<input name="amount" inputmode="numeric" pattern="[0-9]+" required></label><button class="button primary">Review transfer</button></form><form id="wallet-pay-form" hidden><label>Lightning invoice<textarea name="invoice" rows="3" autocomplete="off" spellcheck="false" required></textarea></label><button class="button primary">Review payment</button></form><div id="wallet-send-preview" hidden><p id="wallet-send-summary"></p><button id="wallet-send-confirm" class="button primary">Create token</button></div><div id="wallet-token" hidden><label>Cashu token<textarea id="wallet-token-text" readonly rows="3"></textarea></label><p class="small muted">Anyone with this token can redeem it.</p><div class="wallet-actions"><button id="wallet-copy-token" class="button primary">Copy token</button><button id="wallet-share-token" class="button secondary">Add to message</button></div></div></section>',
    '<div class="wallet-history"><div class="wallet-history-head"><h3>Activity</h3><button id="wallet-refresh" class="text-button">Refresh</button></div><div id="wallet-history"></div></div><details class="wallet-settings"><summary>Wallet settings</summary><p class="small muted">Back up before adding funds. Messages and your Nostr profile do not back up this wallet.</p><form id="wallet-backup"><label>Backup password<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><label>Repeat password<input name="repeat" type="password" minlength="12" autocomplete="new-password" required></label><button class="button secondary">Download encrypted backup</button></form><form id="wallet-add-mint"><label>Add a mint<input name="mint" type="url" placeholder="https://…" autocomplete="off" required></label><button class="button secondary">Add mint</button></form><button id="wallet-lock" class="text-button">Lock wallet</button></details></div>'
  ].join('');

  const $=<K extends string>(id:K)=>byId(id,dialog),form=(id:string)=>formFields(dialog.querySelector<HTMLFormElement>('#'+id));
  let paymentOrder:OrderView|undefined,paymentQuote:any,paymentSend:((token:string)=>Promise<void>)|undefined,paymentDone:(()=>void)|undefined,receivedDone:(()=>void)|undefined;
  let client,loading,state:WalletState={status:'disabled',mints:[],history:[],pending:[],invoices:[]},busy=false,sendMode='cashu',sendQuote,receiveQuote,receiveToken='',invoiceId,polling=false,pendingToken='',walletRevision=0;
  const error=cause=>{$('wallet-error').textContent=cause?.message||String(cause);};
  function render(){
    const ready=state.status==='ready',locked=state.status==='locked';
    $('wallet-enable-intro').textContent=isTestMint(form('wallet-enable').mint.value)?'Receive test money with Cashu. No bitcoin value.':'Send and receive bitcoin with Cashu.';
    if(!ready){$('wallet-token-text').value='';$('wallet-token').hidden=true;form('wallet-receive-form').token.value='';form('wallet-pay-form').invoice.value='';receiveToken='';receiveQuote=sendQuote=null;$('wallet-send-preview').hidden=true;$('wallet-receive-preview').hidden=true;}
    $('wallet-disabled').hidden=ready||locked;$('wallet-ready').hidden=!ready;$('wallet-unlock').hidden=!locked;$('wallet-password-label').hidden=!state.password;
    $('wallet-balance').textContent=sats(state.balance,state.selectedMint);$('wallet-estimate').textContent=!isTestMint(state.selectedMint||'')&&state.balance&&state.balance!=='0'?formatEstimate(state.balance):'';
    $('wallet-test-money').hidden=!isTestMint(state.selectedMint||'');
    const payment=paymentOrder?.payment;
    const existingPayment=payment&&state.history?.find(item=>item.id==='order-payment:'+paymentOrder.id+':'+payment.mint+':'+payment.amount);
    $('wallet-order-payment').hidden=!payment;
    if(payment){$('wallet-order-title').textContent=paymentOrder.items[0].title;$('wallet-order-amount').textContent=sats(payment.amount,payment.mint);$('wallet-order-mint').textContent=mintName(payment.mint)+(isTestMint(payment.mint)?' · Test money':'');$('wallet-order-fee').textContent=existingPayment?'Fee '+sats(existingPayment.fee,payment.mint):paymentQuote?'Fee up to '+sats(paymentQuote.fee,payment.mint):'';$('wallet-order-pay').textContent=existingPayment?'Retry sending payment':paymentQuote?'Pay '+sats(payment.amount,payment.mint):'Review payment';($('wallet-order-pay') as HTMLButtonElement).disabled=busy||!!state.busy;}
    const select=$('wallet-mint');select.replaceChildren(...(state.mints||[]).map(mint=>{const option=node('option',mintName(mint.url)+(isTestMint(mint.url)?' · Test money':'')+(mint.supported===false?' · Unavailable':''));option.value=mint.url;return option}));select.value=state.selectedMint||'';
    $('wallet-status').textContent=state.reviewRequired?'Refresh to check this restored wallet before spending.':state.busy||busy?'Working…':'';
    $('wallet-pending').replaceChildren(...(state.pending||[]).map(item=>{const row=node('div',undefined,'wallet-pending-row');const info=node('div');info.append(node('span',sats(item.amount,item.mint||state.selectedMint)+' · Pending'));if(item.error)info.append(node('p',item.error,'small muted'));row.append(info);const retry=node('button','Check status','text-button');retry.onclick=()=>run(()=>client.recover(item.id));row.append(retry);if(item.canReclaim){const reclaim=node('button','Reclaim','text-button');reclaim.onclick=()=>run(()=>client.cancelPayment(item.id));row.append(reclaim)}return row}));
    $('wallet-history').replaceChildren(...(state.history||[]).slice(0,40).map(item=>{
      const row=node('div',undefined,'wallet-history-row'),left=node('div'),right=node('div',sats(item.amount,item.mint||state.selectedMint),'wallet-history-amount');
      left.append(node('strong',({send:'Sent',receive:'Received',mint:'Received',melt:'Lightning payment',lightning:'Lightning payment'})[item.type]||'Transfer'),node('span',new Date(item.createdAt>1e12?item.createdAt:item.createdAt*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+item.state,'small muted'));
      if(item.type==='send'&&item.state==='complete'&&client.getToken){const copy=node('button','Show token','text-button');copy.onclick=()=>run(async()=>{const revision=walletRevision;showToken(await client.getToken(item.id),revision);if(revision===walletRevision&&dialog.open)$('wallet-send').hidden=false;});right.append(copy)}
      if(onShareMessage&&!isTestMint(item.mint||state.selectedMint||'')&&['lightning','melt'].includes(item.type)&&item.state==='complete'){const share=node('button','Share','text-button');share.type='button';share.setAttribute('aria-label','Share payment note');share.onclick=()=>shareMessage(formatPaymentNote(item));right.append(share)}
      row.append(left,right);return row;
    }));
    if(!state.history?.length)$('wallet-history').append(node('p','No payments yet.','muted small'));
    if(!invoiceId)invoiceId=state.invoices?.findLast(item=>item.state!=='ISSUED')?.id;
    $('wallet-saved-invoices').replaceChildren(...(state.invoices||[]).filter(item=>item.state!=='ISSUED').slice(-8).reverse().map(item=>{const button=node('button','Invoice · '+sats(item.amount,item.mint||state.selectedMint)+' · '+item.state,'text-button');button.onclick=()=>{invoiceId=item.id;$('wallet-invoice-form').hidden=false;$('wallet-receive-form').hidden=true;render();};return button;}));
    const invoice=state.invoices?.find(item=>item.id===invoiceId);if(invoice){$('wallet-invoice').hidden=false;$('wallet-invoice-text').value=invoice.request;$('wallet-invoice-state').textContent=invoice.state;}
    for(const button of dialog.querySelectorAll<HTMLButtonElement>('form button,#wallet-send-confirm,#wallet-receive-confirm,#wallet-refresh,#wallet-check-invoice'))button.disabled=busy||!!state.busy;
    $('wallet-share-token').hidden=!onShareMessage;
    if(ready&&dialog.open&&pendingToken){form('wallet-receive-form').token.value=pendingToken;pendingToken='';receiveToken='';receiveQuote=null;$('wallet-receive-preview').hidden=true;$('wallet-receive').hidden=false;$('wallet-send').hidden=true;setReceiveMode('cashu');}
  }
  async function run(task){if(busy)return;const revision=walletRevision;busy=true;$('wallet-error').textContent='';render();try{return await task()}catch(cause){if(revision===walletRevision&&dialog.open)error(cause)}finally{busy=false;render()}}
  async function load(){if(!loading)loading=(async()=>{const module=await loadClient();form('wallet-enable').mint.value=paymentOrder?.payment?.mint||developerMint||module.DEFAULT_MINT;form('wallet-enable').mint.readOnly=true;$('wallet-add-mint').hidden=true;client=module.createCashuWallet({allowedMints:supportedMints,developerMint,onChange:value=>{state=value;render()}});await client.restore();state=client.state();render();})();try{await loading}catch(cause){loading=null;error(cause)}}
  function showToken(result,revision=walletRevision){if(!dialog.open||state.status!=='ready'||revision!==walletRevision)return;const token=typeof result==='string'?result:result?.token;if(!token)throw new Error('This token is not available.');$('wallet-token-text').value=token;$('wallet-token').hidden=false;}
  async function shareMessage(text){if(!onShareMessage||!dialog.open||state.status!=='ready')return;try{await onShareMessage(text);dialog.hide()}catch(cause){error(cause)}}
  async function openToken(token,onReceived?:()=>void){walletRevision++;receivedDone=onReceived;paymentOrder=undefined;paymentQuote=undefined;if(isPreview())throw new Error('Switch to the live market to use your wallet.');if(typeof token!=='string'||token.length>16000||!/^cashu[AB][A-Za-z0-9_-]+={0,2}$/.test(token))throw new Error('This Cashu token is invalid.');pendingToken=token;const revision=walletRevision;await open();if(revision!==walletRevision||!dialog.open)return;const {getTokenMetadata}=await import('@cashu/cashu-ts');const mint=getTokenMetadata(token).mint.replace(/\/+$/,'');if(revision!==walletRevision||!dialog.open)return;if(state.status==='disabled'&&supportedMints.includes(mint))form('wallet-enable').mint.value=mint;render();}
  async function open(){if(!dialog.open)dialog.showModal();if(isPreview()){$('wallet-disabled').hidden=true;$('wallet-ready').hidden=true;$('wallet-status').textContent='Switch to the live market to use your wallet.';return}await load();}
  async function payOrder(order:OrderView,send:(token:string)=>Promise<void>,onDone:()=>void){if(!order.payment||order.payment.status!=='requested')return;walletRevision++;paymentOrder=order;paymentQuote=undefined;paymentSend=send;paymentDone=onDone;receivedDone=undefined;const revision=walletRevision;await open();if(revision!==walletRevision||!dialog.open)return;form('wallet-enable').mint.value=order.payment.mint;render();}
  $('wallet-order-back').onclick=()=>{const done=paymentDone;dialog.hide();done?.();};
  $('wallet-order-pay').onclick=()=>run(async()=>{
    const order=paymentOrder,payment=order?.payment,send=paymentSend,done=paymentDone,revision=walletRevision;
    const active=()=>dialog.open&&revision===walletRevision&&paymentOrder===order&&state.status==='ready';
    if(!payment||!send||!active())return;
    if(!supportedMints.includes(payment.mint))throw new Error('This mint is not supported by this wallet.');
    const operationId='order-payment:'+order.id+':'+payment.mint+':'+payment.amount;
    const previous=state.history?.find(item=>item.id===operationId);
    let result;
    if(previous){
      if(previous.type!=='send'||previous.mint!==payment.mint||previous.amount!==payment.amount)throw new Error('Saved payment does not match this order.');
      if(previous.state==='cancelled')throw new Error('This payment was cancelled.');
      result=previous.state==='complete'?{token:await client.getToken(operationId)}:await client.recover(operationId);
      if(!result?.token)throw new Error('This payment is still pending. Check its status before retrying.');
    }else{
      if(!state.mints.some(mint=>mint.url===payment.mint))await client.addMint(payment.mint);
      if(!active())return;await client.selectMint(payment.mint);if(!active())return;
      if(!paymentQuote){const quote=await client.previewSend(payment.amount);if(active())paymentQuote=quote;return;}
      result=await client.send({amount:payment.amount,maxFee:paymentQuote.fee,idempotencyKey:operationId});
    }
    if(!active())return;await send(result.token);if(!active())return;
    paymentOrder=undefined;paymentQuote=undefined;dialog.hide();done?.();
  });
  $('wallet-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{walletRevision++;paymentQuote=undefined;paymentOrder=undefined;paymentSend=undefined;paymentDone=undefined;receivedDone=undefined;pendingToken='';form('wallet-receive-form').token.value='';form('wallet-pay-form').invoice.value='';$('wallet-token-text').value='';$('wallet-token').hidden=true;receiveToken='';receiveQuote=sendQuote=null;});
  $('wallet-enable').onsubmit=e=>{e.preventDefault();run(async()=>{await client.enable({mintUrl:form('wallet-enable').mint.value.trim()});state=client.state();render();});};
  $('wallet-unlock').onsubmit=e=>{e.preventDefault();const password=form('wallet-unlock').password.value;form('wallet-unlock').password.value='';run(()=>client.unlock(password));};
  $('wallet-lock').onclick=()=>run(()=>{walletRevision++;pendingToken='';return client.lock()});$('wallet-mint').onchange=()=>run(async()=>{walletRevision++;pendingToken='';paymentQuote=undefined;sendQuote=receiveQuote=null;receiveToken='';invoiceId=undefined;$('wallet-send-preview').hidden=true;$('wallet-receive-preview').hidden=true;$('wallet-token-text').value='';$('wallet-token').hidden=true;await client.selectMint($('wallet-mint').value);});
  $('wallet-receive-tab').onclick=()=>{$('wallet-receive').hidden=!$('wallet-receive').hidden;$('wallet-send').hidden=true;};
  $('wallet-send-tab').onclick=()=>{$('wallet-send').hidden=!$('wallet-send').hidden;$('wallet-receive').hidden=true;};
  function setReceiveMode(mode){const lightning=mode==='lightning';$('wallet-invoice-form').hidden=!lightning;$('wallet-invoice').hidden=!lightning||!invoiceId;$('wallet-receive-form').hidden=lightning;for(const other of dialog.querySelectorAll<HTMLButtonElement>('[data-receive]')){other.classList.toggle('selected',other.dataset.receive===mode);other.setAttribute('aria-pressed',String(other.dataset.receive===mode))}}
  for(const button of dialog.querySelectorAll<HTMLButtonElement>('[data-receive]'))button.onclick=()=>setReceiveMode(button.dataset.receive);
  for(const button of dialog.querySelectorAll<HTMLButtonElement>('[data-send]'))button.onclick=()=>{sendMode=button.dataset.send;$('wallet-send-form').hidden=sendMode!=='cashu';$('wallet-pay-form').hidden=sendMode!=='lightning';$('wallet-send-preview').hidden=true;sendQuote=null;for(const other of dialog.querySelectorAll<HTMLButtonElement>('[data-send]')){other.classList.toggle('selected',button===other);other.setAttribute('aria-pressed',String(button===other))}};
  $('wallet-invoice-form').onsubmit=e=>{e.preventDefault();run(async()=>{const invoice=await client.createInvoice(form('wallet-invoice-form').amount.value);invoiceId=invoice.id;state=client.state();render();});};
  $('wallet-check-invoice').onclick=()=>run(()=>client.checkInvoice(invoiceId));
  $('wallet-receive-form').addEventListener('input',()=>{receiveQuote=null;receiveToken='';$('wallet-receive-preview').hidden=true;});
  $('wallet-receive-form').onsubmit=e=>{e.preventDefault();run(async()=>{
    const revision=walletRevision,token=form('wallet-receive-form').token.value.trim();receiveToken=token;
    const quote=await client.previewReceive(token);
    if(!dialog.open||revision!==walletRevision||form('wallet-receive-form').token.value.trim()!==token)return;
    receiveQuote=quote;$('wallet-receive-summary').textContent=quote.unknownMint?(supportedMints.includes(quote.mint)?'Add '+mintName(quote.mint)+(isTestMint(quote.mint)?' · Test money':''):'This mint is not supported by this wallet.'):'Receive '+sats(quote.received,quote.mint)+' · '+mintName(quote.mint)+(quote.fee!=='0'?' · Fee '+sats(quote.fee,quote.mint):'');
    $('wallet-receive-confirm').hidden=!!quote.unknownMint&&!supportedMints.includes(quote.mint);$('wallet-receive-confirm').textContent=quote.unknownMint?'Add mint and review':'Receive token';$('wallet-receive-preview').hidden=false;
  });};
  $('wallet-receive-confirm').onclick=()=>run(async()=>{
    const revision=walletRevision,token=receiveToken,quote=receiveQuote,done=receivedDone;
    const active=()=>dialog.open&&revision===walletRevision&&state.status==='ready'&&form('wallet-receive-form').token.value.trim()===token;
    if(!quote||!active())throw new Error('Review a token first.');
    if(quote.unknownMint){
      if(!supportedMints.includes(quote.mint))throw new Error('This mint is not supported by this wallet.');
      await client.addMint(quote.mint);if(!active())return;const next=await client.previewReceive(token);if(!active())return;
      receiveQuote=next;$('wallet-receive-summary').textContent='Receive '+sats(next.received,next.mint)+' · Fee '+sats(next.fee,next.mint);$('wallet-receive-confirm').textContent='Receive token';return;
    }
    await client.receive(token);if(!active())return;
    receiveToken='';receiveQuote=null;form('wallet-receive-form').token.value='';$('wallet-receive-preview').hidden=true;$('wallet-receive').hidden=true;receivedDone=undefined;if(done){dialog.hide();done();}
  });
  const clearQuote=()=>{sendQuote=null;$('wallet-send-preview').hidden=true;};
  $('wallet-send-form').addEventListener('input',clearQuote);$('wallet-pay-form').addEventListener('input',clearQuote);
  function showQuote(quote){sendQuote=quote;$('wallet-send-summary').textContent=sats(quote.amount,state.selectedMint)+' · Fee up to '+sats(quote.fee||'0',state.selectedMint);$('wallet-send-confirm').textContent=sendMode==='cashu'?'Create token':'Pay invoice';$('wallet-send-preview').hidden=false;}
  $('wallet-send-form').onsubmit=e=>{e.preventDefault();run(async()=>{const revision=walletRevision,amount=form('wallet-send-form').amount.value,quote=await client.previewSend(amount);if(dialog.open&&revision===walletRevision&&form('wallet-send-form').amount.value===amount)showQuote(quote);});};
  $('wallet-pay-form').onsubmit=e=>{e.preventDefault();run(async()=>{const revision=walletRevision,invoice=form('wallet-pay-form').invoice.value.trim(),quote=await client.previewLightning(invoice);if(dialog.open&&revision===walletRevision&&form('wallet-pay-form').invoice.value.trim()===invoice)showQuote(quote);});};
  $('wallet-send-confirm').onclick=()=>run(async()=>{if(!sendQuote)throw new Error('Review this transfer first.');if(sendMode==='cashu'){const revision=walletRevision;showToken(await client.send({amount:sendQuote.amount,maxFee:sendQuote.fee||'0'}),revision);}else await client.payLightning({quoteId:sendQuote.quoteId,maxFee:sendQuote.fee});sendQuote=null;$('wallet-send-preview').hidden=true;});
  for(const [button,field] of [['wallet-copy-token','wallet-token-text'],['wallet-copy-invoice','wallet-invoice-text']])$(button).onclick=()=>navigator.clipboard.writeText(($ (field) as HTMLTextAreaElement).value).then(()=>{$('wallet-status').textContent='Copied';}).catch(()=>error(new Error('Copy the text from the field.')));
  $('wallet-share-token').onclick=()=>{const token=$('wallet-token-text').value;if(token)void shareMessage(token)};
  $('wallet-refresh').onclick=()=>run(()=>client.refresh());
  $('wallet-add-mint').onsubmit=e=>{e.preventDefault();run(()=>client.addMint(form('wallet-add-mint').mint.value.trim()));};
  $('wallet-backup').onsubmit=e=>{e.preventDefault();const password=form('wallet-backup').password.value,repeat=form('wallet-backup').repeat.value;form('wallet-backup').password.value=form('wallet-backup').repeat.value='';run(async()=>{if(password!==repeat)throw new Error('The passwords do not match.');const backup=await client.exportEncryptedBackup(password),url=URL.createObjectURL(new Blob([typeof backup==='string'?backup:JSON.stringify(backup)],{type:'application/json'}));const link=node('a');link.href=url;link.download='iris-market-wallet-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});};
  $('wallet-import').onsubmit=e=>{e.preventDefault();const file=form('wallet-import').backup.files[0],password=form('wallet-import').password.value;form('wallet-import').password.value='';run(async()=>{if(!file||file.size>12*1024*1024)throw new Error('Choose a wallet backup under 12 MB.');await client.importEncryptedBackup(await file.text(),password,{});$('wallet-import').reset();});};
  const timer=setInterval(()=>{if(!dialog.open||busy||polling||state.status!=='ready'||!invoiceId)return;const invoice=state.invoices?.find(item=>item.id===invoiceId);if(!invoice||!['unpaid','pending'].includes(String(invoice.state).toLowerCase())||invoice.expiresAt&&invoice.expiresAt<Date.now()/1000)return;polling=true;void client.checkInvoice(invoiceId).catch(error).finally(()=>{polling=false;});},5000);
  window.addEventListener('pagehide',()=>{clearInterval(timer);client?.destroy();});document.getElementById('wallet-tab').onclick=open;
  return {open,openToken,payOrder,hide:()=>dialog.hide()};
}
