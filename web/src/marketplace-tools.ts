import {element as el} from './dom.ts';

import {marketplaceToolEnabled} from './marketplace-flags.ts';
export {marketplaceToolEnabled} from './marketplace-flags.ts';
function check(label:string){const row=el('label',label,'checkbox-label'),input=el('input');input.type='checkbox';row.prepend(input);return {row,input};}
export function composerTradeTools(form:HTMLFormElement){
  const wrap=el('fieldset',undefined,'post-trade-tools'),protect=check('Allow escrow on this listing');
  const trade=el('select'),sats=el('input'),method=el('select'),tradeLabel=el('label','Trade'),satLabel=el('label','Bitcoin amount in sats'),methodLabel=el('label','Fiat payment method');
  trade.append(new Option('Goods or services','goods'),new Option('Bitcoin for fiat','bitcoin_fiat'));tradeLabel.append(trade);
  const offerInfo=el('p','The other trader proposes a provider. You can accept or decline each request.','small muted');
  sats.inputMode='numeric';sats.placeholder='100000';satLabel.append(sats);method.append(new Option('Bank transfer','bank_transfer'),new Option('Cash in person','cash'));methodLabel.append(method);
  wrap.append(el('legend','Trade options'),protect.row,offerInfo,tradeLabel,satLabel,methodLabel);form.querySelector('.post-side-tabs').after(wrap);
  let edit=false,editingOffer:import('./escrow-offer.ts').EscrowOffer|undefined;
  const price=form.elements.namedItem('price') as HTMLInputElement;
  const priceLabel=price.parentElement.firstChild;
  function sync(editing=edit){
    edit=editing;
    const enabled=marketplaceToolEnabled('escrow')&&(!edit||editingOffer?.trade==='bitcoin_fiat');
    const bitcoin=edit?editingOffer?.trade==='bitcoin_fiat':enabled&&protect.input.checked&&trade.value==='bitcoin_fiat';
    wrap.hidden=!enabled;protect.row.hidden=!enabled||edit;trade.disabled=edit;
    offerInfo.hidden=!enabled||edit||!protect.input.checked;tradeLabel.hidden=!enabled||!protect.input.checked;
    satLabel.hidden=methodLabel.hidden=!enabled||!bitcoin;
    priceLabel.textContent=bitcoin?'Total fiat price':'Price';
    price.placeholder=bitcoin?'0.00':'Negotiable';
  }
  protect.input.onchange=()=>sync();trade.onchange=()=>{
    if(trade.value==='bitcoin_fiat'&&!edit){
      const expiry=form.elements.namedItem('expiration') as HTMLSelectElement;
      if(expiry && !expiry.value)expiry.value='1w';
    }
    sync();
  };window.addEventListener('market-tools-change',()=>sync());
  sync();
  return {sync,setEditingOffer(offer){editingOffer=offer;protect.input.checked=!!offer;trade.value=offer?.trade??'goods';sats.value=offer?.trade==='bitcoin_fiat'?String(offer.sats):'';method.value=offer?.method??'bank_transfer';},choices(){return {escrow:marketplaceToolEnabled('escrow')&&(!edit||editingOffer?.trade==='bitcoin_fiat')&&protect.input.checked?(trade.value==='goods'?{trade:'goods'}:{trade:'bitcoin_fiat',sats:Number(sats.value),method:method.value}):undefined};}};
}
