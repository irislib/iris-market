import { createSurface } from './surface.ts';
import { byId, element as domElement, formFields } from './dom.ts';
import { LISTING_KIND, parseEvent } from './market.ts';
import { nhashDecode, toHex } from '@hashtree/core';
import { createDraftFiles, renderComposerPreview } from './composer-preview.ts';
import {listingPublishedAt} from './listing-dates.ts';
import {EXPIRY_CHOICES,expiryFromChoice,relativeExpiry} from './expiry.ts';
import {courierListingType,isTransportTag,transportTypeTags} from './transport-type.ts';
import {COUNTRY_CODES} from './shipping.ts';
import {deliveryDraft,validateDelivery} from './delivery.ts';
import {serviceAreaTags,parseServiceAreas} from './service-area.ts';
import {setupServiceAreaPicker} from './service-area-ui.ts';
import {formatPrice} from './currency.ts';

export function deliveryPreviewLabel(value,currency='EUR',locale=undefined):string|null {
  const delivery=validateDelivery(value);if(!delivery)return null;
  const names=new Intl.DisplayNames([locale||navigator.language||'en'],{type:'region'});
  const destinations=new Intl.ListFormat(locale,{style:'long',type:'conjunction'}).format(delivery.countries.map(code=>names.of(code)));
  if(Number(delivery.price)===0)return `Free delivery to ${destinations}`;
  return `Delivery to ${destinations} · ${formatPrice({price:delivery.price,currency},{preferredCurrency:currency,locale}).primary}`;
}
export function composerControlState({busy=false,editing=false,shippingEnabled=false,category='other'}={}) {
  return {deliveryDisabled:busy||!shippingEnabled,transportDisabled:busy||category!=='transport',keepDisabled:busy||!editing};
}

const MAX_FILES=4, MAX_FILE_BYTES=8*1024*1024;
const rasterTypes=new Set(['image/jpeg','image/png','image/webp']);
const markdownLabel=value=>value.replace(/[\\[\]`*_]/g,'\\$&').replace(/[\r\n]/g,' ');
function attachment(value) {
  if(!value||typeof value.name!=='string'||!value.name||value.name.length>160||/[\u0000-\u001f\u007f]/.test(value.name)||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_FILE_BYTES||typeof value.isImage!=='boolean'||typeof value.mime!=='string'||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mime)||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('An attachment is invalid. Select it again.');
  let url,cid;try{url=new URL(value.url);cid=nhashDecode(value.nhash)}catch{throw new Error('An attachment is invalid. Select it again.')}
  if(url.origin!=='https://cdn.iris.to'||url.username||url.password||url.search||url.hash||!new RegExp('^/'+value.sha256+'\\.[a-z0-9]+$').test(url.pathname)||cid.key||toHex(cid.hash)!==value.sha256||value.isImage&&!rasterTypes.has(value.mime))throw new Error('An attachment is invalid. Select it again.');
  const fileLink=`htree://${value.nhash}/${encodeURIComponent(value.name)}`;
  return {...value,url:url.href,fileLink};
}
export function listingDraft(values, { identifier=crypto.randomUUID(), createdAt=Math.floor(Date.now()/1000), attachments=[], previousExpiration=undefined }={}) {
  validateDelivery(values.shipping);
  const title=String(values.title||'').trim(), description=String(values.description||'').trim(), price=String(values.price??'').trim(), currency=String(values.currency||'EUR').trim().toUpperCase(), location=String(values.location||'').trim(), image=String(values.image||'').trim();
  if(!title||Array.from(title).length>160)throw new Error('Choose a title of up to 160 characters.');
  if(price!==''&&(!/^\d+(?:\.\d{1,8})?$/.test(price)||price.length>24||!Number.isFinite(Number(price))))throw new Error('Enter a positive price, or leave it blank.');
  if(!/^[A-Z]{3,12}$/.test(currency))throw new Error('Choose a currency.');
  if(Array.from(location).length>160)throw new Error('The location is too long.');
  if(!['offer','request'].includes(values.side))throw new Error('Choose Selling or Buying.');
  if(!['home','tech','services','transport','work','other'].includes(values.category))throw new Error('Choose a category.');
  if(image){let url;try{url=new URL(image)}catch{throw new Error('Use a secure image URL.')}if(url.protocol!=='https:'||url.username||url.password)throw new Error('Use a secure image URL.');}
  if(!Array.isArray(attachments)||attachments.length>MAX_FILES)throw new Error('Choose up to four photos or files.');
  const files=attachments.map(attachment), links=files.map(file=>`${file.isImage?'!':''}[${markdownLabel(file.name)}](${file.url})`);
  const content=[description,...links].filter(Boolean).join('\n\n');
  if(new TextEncoder().encode(content).length>12000)throw new Error('The description is too long. Leave room for attachment links.');
  const tags=[['d',identifier],['title',title],['market',values.side],['t',values.category],['price',price,currency],['status','active'],['published_at',String(createdAt)]];
  if(values.side==='request')tags.push(['t','market:request']);
  const labels:unknown[]=Array.isArray(values.tags)?values.tags:String(values.tags||'').split(',');
  const extraTags=[...new Set(labels.map(value=>{if(typeof value!=='string')throw new Error('Choose up to eight short tags.');return value.trim().replace(/^#/, '').toLowerCase();}).filter(Boolean))];
  if(extraTags.length>8||extraTags.some(tag=>Array.from(tag).length>60||/[\u0000-\u001f\u007f]/.test(tag)))throw new Error('Choose up to eight tags, each up to 60 characters.');
  const selectedType=values.category==='transport'?values.transportType:undefined;const generated=transportTypeTags(selectedType);
  for(const label of [...new Set([...extraTags.filter(tag=>!selectedType||!isTransportTag(tag)),...generated])])if(label!==values.category)tags.push(['t',label]);
  const expiration=expiryFromChoice(values.expiration,createdAt,previousExpiration);
  if(expiration!==undefined)tags.push(['expiration',String(expiration)]);
  if(location)tags.push(['location',location]);if(image)tags.push(['image',image]);
  if(values.serviceAreas)tags.push(...serviceAreaTags(values.serviceAreas));
  for(const file of files){
    if(file.isImage)tags.push(['image',file.url]);
    tags.push(['imeta',`url ${file.url}`,`x ${file.sha256}`,`m ${file.mime}`,`size ${file.size}`,`alt ${file.name}`],['r',file.fileLink]);
  }
  return {kind:LISTING_KIND,created_at:createdAt,tags,content};
}

/** Keep the address and unrelated public metadata when a merchant edits a listing. */
export function revisedListingDraft(values, previous, attachments=[]) {
  const draft=listingDraft({...values,expiration:values.expiration??'keep'},{identifier:previous.identifier,createdAt:Math.max(Math.floor(Date.now()/1000),previous.createdAt+1),attachments,previousExpiration:previous.expiration});
  draft.tags.find(tag=>tag[0]==='published_at')[1]=String(listingPublishedAt(previous)??previous.createdAt);
  const replaced=new Set(['d','title','market','price','location','status','published_at','expiration']);
  for(const tag of previous.originalTags||[]){
    if(values.category==='transport'&&values.transportType&&tag[0]==='t'&&isTransportTag(tag[1]))continue;
    if(Object.hasOwn(values,'serviceAreas')&&(tag[0]==='service_area'||tag[0]==='g'&&['pickup','destination'].includes(tag[2])))continue;
    if(Object.hasOwn(values,'shipping')&&tag[0]==='shipping_option')continue;
    if(replaced.has(tag[0])||tag[0]==='t'&&(tag[1]===previous.category||Object.hasOwn(values,'tags'))||tag[0]==='image'&&tag[1]===previous.imageUrl)continue;
    if(!draft.tags.some(value=>JSON.stringify(value)===JSON.stringify(tag)))draft.tags.push([...tag]);
  }
  return draft;
}

/** A signed retry is the same publication, including its exact deadline. */
export async function signedListingForPublish(values,{previous=undefined,identifier=undefined,attachments=[],pendingEvent=undefined,signEvent}) {
  if(pendingEvent)return pendingEvent;
  const draft=previous?revisedListingDraft(values,previous,attachments):listingDraft(values,{identifier,attachments});
  return signEvent(draft);
}

/** Sign the complete pair before any local enqueue or relay publication. */
export async function signedListingPublication(values,{previous=undefined,identifier=undefined,attachments=[],pendingEvent=undefined,pendingShipping=undefined,signEvent,onShipping=(_event)=>{}}) {
  if(pendingEvent)return {event:pendingEvent,shipping:pendingShipping};
  const delivery=validateDelivery(values.shipping);
  // Reject every listing field before requesting even the option signature.
  if(previous)revisedListingDraft(values,previous,attachments);else listingDraft(values,{identifier,attachments});
  let shipping=pendingShipping;
  if(delivery&&!shipping){shipping=await signEvent(deliveryDraft(delivery,String(values.currency||'EUR').trim().toUpperCase()));onShipping(shipping);}
  const event=await signedListingForPublish(values,{previous,identifier,attachments,signEvent:draft=>{
    if(shipping)draft.tags.push(['shipping_option',`30406:${shipping.pubkey}:${shipping.tags.find(tag=>tag[0]==='d')[1]}`]);
    return signEvent(draft);
  }});
  return {event,shipping};
}

/** Keep successful uploads across retry without changing the original selected files. */
export function createAttachmentSelection(upload) {
  let entries=[];
  return {
    add(files){const next=[...files];if(entries.length+next.length>MAX_FILES)throw new Error('Choose up to four photos or files.');for(const file of next)if(!file||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES||typeof file.arrayBuffer!=='function')throw new Error('Each file must be between 1 byte and 8 MiB.');entries.push(...next.map(file=>({file,result:null})));},
    remove(index){entries.splice(index,1);},
    clear(){entries=[];},
    items(){return entries.map(entry=>({file:entry.file,uploaded:Boolean(entry.result)}));},
    async uploadAll({signal,onFile=()=>{}}:{signal?:AbortSignal;onFile?:(index:number,total:number)=>void}={}){const results=[];for(const[index,entry]of entries.entries()){if(signal?.aborted)throw new DOMException('Upload cancelled','AbortError');if(!entry.result){onFile(index,entries.length);entry.result=attachment(await upload(entry.file,{signal}));}results.push(entry.result);}return results;},
  };
}

export function setupComposer({account,isPreview,onPublished,defaultCurrency=()=> 'EUR',loadUploader=()=>import('./uploads.ts'),page=undefined,onNavigate=()=>{},onClose=()=>{},priceNode=undefined}) {
  const dialog=createSurface({className:'composer-dialog',label:'Post a listing',pageHost:page,onOpen:onNavigate,onClose});
  const countryNames=new Intl.DisplayNames([navigator.language||'en'],{type:'region'});
  dialog.innerHTML=`<button class="dialog-close icon-button" id="post-close" aria-label="Close listing editor">×</button><h2>Post a listing</h2><form id="post-form"><div class="post-side-tabs" role="radiogroup" aria-label="Listing type"><button type="button" role="radio" data-post-side="offer" aria-checked="true">Selling</button><button type="button" role="radio" data-post-side="request" aria-checked="false" tabindex="-1">Buying</button></div><input type="hidden" name="side" value="offer"><label>Category<select name="category"><option value="other">Other</option><option value="home">Home</option><option value="tech">Tech</option><option value="services">Services</option><option value="transport">Transport</option><option value="work">Work</option></select></label><label id="post-transport-type" hidden>Transport type<select name="transportType" disabled><option value="">Not specified</option><option value="parcel">Delivery</option><option value="passenger">Passenger ride</option><option value="both">Both</option></select></label><label>Title<input name="title" maxlength="160" required autocomplete="off"></label><label>Description<textarea name="description" rows="4" maxlength="12000"></textarea></label><div class="form-pair"><label>Price<input name="price" inputmode="decimal" placeholder="Negotiable"></label><label>Currency<input name="currency" maxlength="12" autocapitalize="characters"></label></div><label>Location <span class="muted">· optional</span><input name="location" maxlength="160" placeholder="City or area" autocomplete="off"></label><label>Tags <span class="muted">· optional</span><input name="tags" maxlength="488" autocomplete="off"></label><details><summary>Delivery</summary><label><input type="checkbox" name="shippingEnabled"> Offer delivery</label><p class="small muted" id="post-delivery-hint">Choose destinations and a fixed delivery cost.</p><button type="button" id="post-remove-delivery" class="text-button" hidden>Remove existing delivery</button><fieldset id="post-delivery-fields" hidden disabled><legend class="sr-only">Delivery destinations and cost</legend><label>Delivers to<select id="post-country-add"><option value="">Add a country…</option>${COUNTRY_CODES.map(code=>`<option value="${code}">${countryNames.of(code)} (${code})</option>`).join('')}</select></label><div id="post-delivery-countries"></div><label>Delivery cost<input name="shippingPrice" inputmode="decimal" placeholder="0 for free delivery"></label><p class="small muted">In the listing currency. Your location is separate.</p></fieldset></details><label>Expires in<select name="expiration">${EXPIRY_CHOICES.map(option=>`<option value="${option.value}">${option.label}</option>`).join('')}<option value="keep" hidden disabled>Keep current</option></select></label><label>Photos & files<input id="post-files" type="file" multiple aria-describedby="post-file-help"></label><p id="post-file-help" class="small muted">Up to 4 files · 8 MB each</p><ul id="post-file-list" class="post-file-list"></ul><details class="post-image-link"><summary>Image link</summary><label><span class="sr-only">Image link</span><input name="image" type="url" placeholder="https://…" autocomplete="off"></label></details><button id="post-submit" class="button primary">Preview listing</button></form><section id="post-preview" hidden><div id="post-preview-content"></div><p class="small muted">Your listing and attached files will be public.</p><div class="post-preview-actions"><button id="post-edit" type="button" class="button secondary">Edit</button><button id="post-publish" type="button" class="button primary">Publish listing</button></div></section><p id="post-progress" class="small muted" role="status"></p><p id="post-error" class="error" role="alert"></p>`;
  const form=dialog.querySelector('form'),submit=dialog.querySelector<HTMLButtonElement>('#post-submit'),error=dialog.querySelector('#post-error'),progress=dialog.querySelector('#post-progress'),fileInput=dialog.querySelector<HTMLInputElement>('#post-files'),fileList=dialog.querySelector('#post-file-list');
  const preview=dialog.querySelector<HTMLElement>('#post-preview'),previewContent=dialog.querySelector('#post-preview-content'),editButton=dialog.querySelector<HTMLButtonElement>('#post-edit'),publish=dialog.querySelector<HTMLButtonElement>('#post-publish');
  const sideButtons=[...dialog.querySelectorAll<HTMLButtonElement>('[data-post-side]')];
  let draftId=crypto.randomUUID(),editing=null,pendingEvent,pendingShipping,shippingTouched=false,busy=false,pendingOpen=false,currencyTouched=false,uploader,uploadController,filePosition;
  let reviewedValues:Record<string,unknown>|undefined,reviewOwner:string|undefined,localFiles:ReturnType<typeof createDraftFiles>|undefined;
  let areaTouched=false,areaPreview:ReturnType<typeof setupServiceAreaPicker>|undefined;
  const selectedCountries=new Set<string>();let removeExistingDelivery=false,initialTransportType='',preservedTransportTags:string[]=[];
  const deliveryFields=dialog.querySelector<HTMLFieldSetElement>('#post-delivery-fields'),countryAdd=dialog.querySelector<HTMLSelectElement>('#post-country-add'),countryList=dialog.querySelector<HTMLDivElement>('#post-delivery-countries'),removeDelivery=dialog.querySelector<HTMLButtonElement>('#post-remove-delivery');
  function changedDelivery(){shippingTouched=true;pendingEvent=null;pendingShipping=null;}
  function controlState(){return composerControlState({busy,editing:!!editing,shippingEnabled:formFields(form).shippingEnabled.checked,category:formFields(form).category.value});}
  function paintDelivery(){const enabled=formFields(form).shippingEnabled.checked;deliveryFields.hidden=!enabled;deliveryFields.disabled=controlState().deliveryDisabled;countryList.replaceChildren();for(const code of selectedCountries){const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent=`${countryNames.of(code)} ×`;button.setAttribute('aria-label',`Remove ${countryNames.of(code)}`);button.onclick=()=>{selectedCountries.delete(code);changedDelivery();paintDelivery();};countryList.append(button);}for(const option of countryAdd.options)option.disabled=selectedCountries.has(option.value);}
  formFields(form).shippingEnabled.onchange=()=>{changedDelivery();paintDelivery();};
  countryAdd.onchange=()=>{if(countryAdd.value){selectedCountries.add(countryAdd.value);countryAdd.value='';changedDelivery();paintDelivery();}};
  removeDelivery.onclick=()=>{removeExistingDelivery=true;formFields(form).shippingEnabled.checked=false;changedDelivery();paintDelivery();removeDelivery.hidden=true;dialog.querySelector('#post-delivery-hint').textContent='Existing delivery will be removed when you publish.';};
  const areaPicker=setupServiceAreaPicker({onChange:()=>{areaTouched=true;pendingEvent=null;pendingShipping=null;}});
  const areaEditor=domElement('details',undefined,'post-service-areas');areaEditor.append(domElement('summary','Transport areas'),areaPicker.element);
  formFields(form).location.closest('label').after(areaEditor);
  function syncAreaEditor(){const transport=formFields(form).category.value==='transport';dialog.querySelector<HTMLElement>('#post-transport-type').hidden=!transport;formFields(form).transportType.disabled=controlState().transportDisabled;areaEditor.hidden=formFields(form).category.value!=='transport'&&!areaTouched&&!editing?.serviceAreas;if(dialog.open&&!form.hidden&&!areaEditor.hidden&&areaEditor.open)void areaPicker.show();else areaPicker.hide();}
  areaEditor.ontoggle=syncAreaEditor;
  formFields(form).category.addEventListener('change',syncAreaEditor);
  const selection=createAttachmentSelection(async(file,options)=>{
    if(!uploader){const module=await loadUploader();uploader=module.createMediaUploader({signEvent:draft=>account.messaging.signEvent(draft),getCacheMiB:()=>Number(byId('map-cache')?.value)||128,onProgress:step=>{const phase={preparing:'Preparing',uploading:'Uploading',verifying:'Checking',complete:'Checking'}[step.phase]||'Uploading';progress.textContent=`${phase} file ${filePosition.index+1} of ${filePosition.total}…`;}});}
    return uploader.upload(file,options);
  });
  function releasePreview(){localFiles?.close();localFiles=undefined;void areaPreview?.destroy();areaPreview=undefined;previewContent.replaceChildren();}
  function paintSide(){for(const button of sideButtons){const selected=button.dataset.postSide===formFields(form).side.value;button.setAttribute('aria-checked',String(selected));button.tabIndex=selected?0:-1;}}
  function chooseSide(button:HTMLButtonElement){if(busy)return;formFields(form).side.value=button.dataset.postSide;pendingEvent=null;pendingShipping=null;paintSide();}
  for(const button of sideButtons){button.onclick=()=>chooseSide(button);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?sideButtons[0]:event.key==='End'?sideButtons[1]:sideButtons.find(other=>other!==button);chooseSide(next);next.focus();};}
  function paintFiles(){fileList.replaceChildren(...selection.items().map((entry,index)=>{const row=document.createElement('li'),name=document.createElement('span'),remove=document.createElement('button');name.textContent=entry.file.name;remove.type='button';remove.className='text-button';remove.textContent='Remove';remove.disabled=busy;remove.setAttribute('aria-label',`Remove ${entry.file.name}`);remove.onclick=()=>{selection.remove(index);pendingEvent=null;pendingShipping=null;paintFiles()};row.append(name,remove);return row}));}
  function syncKeepOption(){const keep=formFields(form).expiration.querySelector<HTMLOptionElement>('option[value=keep]');keep.hidden=!editing;keep.disabled=controlState().keepDisabled;keep.textContent=editing?`Keep current (${relativeExpiry(editing.expiration)?.replace(/^Expires /,'')||'never'})`:'Keep current';}
  const setBusy=value=>{busy=value;for(const field of form.elements)(field as HTMLInputElement).disabled=value;editButton.disabled=value;publish.disabled=value;paintFiles();if(!value){paintDelivery();syncAreaEditor();syncKeepOption();}publish.textContent=value?(editing?'Saving…':'Publishing…'):(editing?'Save changes':'Publish listing');};
  function showEditor(){syncKeepOption();releasePreview();reviewedValues=undefined;reviewOwner=undefined;form.hidden=false;preview.hidden=true;dialog.classList.remove('showing-preview');dialog.querySelector('h2').textContent=editing?'Edit listing':'Post a listing';error.textContent='';progress.textContent='';syncAreaEditor();}
  function drawPreview(){
    releasePreview();
    const draft=pendingEvent||(editing?revisedListingDraft(reviewedValues,editing):listingDraft(reviewedValues,{identifier:draftId}));
    localFiles=createDraftFiles(selection.items().map(item=>item.file));
    const delivery=deliveryPreviewLabel(reviewedValues.shipping,String(reviewedValues.currency||'EUR'));if(delivery)previewContent.append(domElement('p',delivery,'small muted'));
    previewContent.append(renderComposerPreview(draft,localFiles.items,{priceNode}));
    form.hidden=true;preview.hidden=false;dialog.classList.add('showing-preview');dialog.querySelector('h2').textContent='Preview';publish.textContent=editing?'Save changes':'Publish listing';
    areaPicker.hide();const areas=parseServiceAreas(draft.tags);if(areas){areaPreview=setupServiceAreaPicker({value:areas,readOnly:true});const media=previewContent.querySelector('.detail-media');if(!draft.tags.some(tag=>tag[0]==='image')&&!localFiles.items.some(file=>file.image)&&media){media.classList.add('detail-area-media');media.replaceChildren(areaPreview.element);}else previewContent.append(areaPreview.element);void areaPreview.show();}
  }
  editButton.onclick=()=>{showEditor();formFields(form).title.focus();};
  dialog.querySelector<HTMLButtonElement>('#post-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{uploadController?.abort();releasePreview();areaPicker.hide();});
  form.addEventListener('input',event=>{if((event.target as HTMLInputElement).name.startsWith('shipping'))shippingTouched=true;pendingEvent=null;pendingShipping=null;if((event.target as HTMLInputElement).name==='currency')currencyTouched=true;});
  fileInput.onchange=()=>{try{selection.add(fileInput.files);pendingEvent=null;pendingShipping=null;error.textContent='';paintFiles()}catch(cause){error.textContent=cause.message}finally{fileInput.value=''}};
  form.onsubmit=event=>{
    event.preventDefault();if(busy)return;
    const values:Record<string,unknown>=Object.fromEntries(new FormData(form));error.textContent='';progress.textContent='';
    try{if(editing&&(values.transportType===undefined||values.transportType===initialTransportType)){if(values.transportType===initialTransportType)delete values.transportType;values.tags=[...String(values.tags||'').split(','),...preservedTransportTags];}else if(editing&&values.transportType==='')values.transportType='none';if(!editing||formFields(form).shippingEnabled.checked||removeExistingDelivery)values.shipping=validateDelivery(formFields(form).shippingEnabled.checked?{countries:[...selectedCountries],price:formFields(form).shippingPrice.value.trim()}:null);if(areaTouched)values.serviceAreas=areaPicker.validate();listingDraft(values,{identifier:draftId});reviewedValues=values;reviewOwner=account.state().ownerPubkey;drawPreview();const heading=dialog.querySelector('h2');heading.tabIndex=-1;heading.focus();heading.scrollIntoView({block:'start'});}
    catch(cause){releasePreview();reviewedValues=undefined;error.textContent=cause.message;}
  };
  publish.onclick=async()=>{
    if(busy||!reviewedValues)return;
    if(!account.state().canSign){pendingOpen=true;account.showAccount({posting:true});return;}
    error.textContent='';progress.textContent='';
    const owner=account.state().ownerPubkey;
    try{if(isPreview())throw new Error('Switch to the live market to post.');if(reviewOwner&&reviewOwner!==owner)throw new Error('Your profile changed. Edit and preview the listing again.');if(editing&&editing.author!==owner)throw new Error('Sign in with the profile that owns this listing.');}
    catch(cause){error.textContent=cause.message;return;}
    const values={...reviewedValues};if(pendingEvent&&pendingEvent.pubkey!==owner||pendingShipping&&pendingShipping.pubkey!==owner){pendingEvent=null;pendingShipping=null;}uploadController=new AbortController();const active=uploadController;setBusy(true);
    try {
      const files=await selection.uploadAll({signal:active.signal,onFile:(index,total)=>{filePosition={index,total}}});
      if(active.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      if(account.state().ownerPubkey!==owner)throw new Error('Your profile changed. Edit and preview the listing again.');
      progress.textContent='Publishing listing…';const publication=await signedListingPublication(values,{previous:editing,identifier:draftId,attachments:files,pendingEvent,pendingShipping,onShipping:event=>{pendingShipping=event;},signEvent:draft=>account.messaging.signEvent(draft)});const signed=publication.event;parseEvent(signed);pendingEvent=signed;pendingShipping=publication.shipping;
      if(active.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      const receipts=await account.messaging.publishSignedEvents([...(pendingShipping?[pendingShipping]:[]),signed]);const receipt=receipts.at(-1);onPublished(signed,receipt);pendingEvent=null;pendingShipping=null;editing=null;draftId=crypto.randomUUID();form.reset();shippingTouched=false;selectedCountries.clear();removeExistingDelivery=false;removeDelivery.hidden=true;paintDelivery();selection.clear();currencyTouched=false;areaPicker.setValue(null);areaTouched=false;areaEditor.open=false;showEditor();paintSide();dialog.close();
    } catch(cause){error.textContent=cause.name==='AbortError'?'Upload stopped. Your draft and selected files are still here.':cause.message||'Could not publish. Your draft is still here.';}
    finally{uploadController=null;setBusy(false);progress.textContent='';}
  };
  function open(){pendingOpen=false;account.closeAccount();if(!reviewedValues&&!currencyTouched&&formFields(form).currency.value!==defaultCurrency()){formFields(form).currency.value=defaultCurrency();pendingEvent=null;pendingShipping=null;}error.textContent='';paintSide();if(reviewedValues)drawPreview();dialog.showModal();syncAreaEditor();}
  function edit(listing){if(listing.author!==account.state().ownerPubkey)return;editing=listing;draftId=listing.identifier;pendingEvent=null;pendingShipping=null;selection.clear();paintFiles();const fields=formFields(form);for(const key of ['side','title','description','price','currency','location'])fields[key].value=listing[key]??'';fields.category.value=String(listing.category).toLowerCase();if(!fields.category.value)fields.category.value='other';fields.image.value=listing.imageUrl||'';initialTransportType=listing.category==='transport'?courierListingType(listing)||'':'';preservedTransportTags=(listing.tags||[]).filter(isTransportTag);fields.transportType.value=initialTransportType;fields.tags.value=(listing.tags||[]).filter(tag=>tag!==listing.category&&(listing.category!=='transport'||!isTransportTag(tag))).join(', ');fields.expiration.value='keep';fields.shippingEnabled.checked=false;fields.shippingPrice.value='';selectedCountries.clear();shippingTouched=false;removeExistingDelivery=false;removeDelivery.hidden=!listing.originalTags?.some(tag=>tag[0]==='shipping_option');paintDelivery();dialog.querySelector('#post-delivery-hint').textContent=listing.originalTags?.some(tag=>tag[0]==='shipping_option')?'Existing delivery options are kept unless you change these fields.':'Choose destinations and a fixed delivery cost.';areaPicker.setValue(listing.serviceAreas??null);areaTouched=false;areaEditor.open=!!listing.serviceAreas;currencyTouched=true;showEditor();open();}
  function hasAreaDraft(){try{return !!areaPicker.validate();}catch{return true;}}
  function prefill(values){
    const fields=formFields(form);
    if(busy||editing||reviewedValues||shippingTouched||selectedCountries.size||fields.shippingEnabled.checked||fields.shippingPrice.value.trim()||fields.transportType.value||selection.items().length||hasAreaDraft()||['title','description','price','location','image','tags','expiration'].some(key=>fields[key].value.trim())){
      open();error.textContent='Your current draft is still here. Finish it before starting another listing.';return false;
    }
    // A service announcement is an ordinary editable listing; publishing still
    // requires the normal explicit preview and Publish action.
    for(const key of ['side','category','title','description','price','location'])fields[key].value=String(values[key]??'');
    const incomingTags=Array.isArray(values.tags)?values.tags:String(values.tags||'').split(',');fields.transportType.value=values.category==='transport'?courierListingType({tags:incomingTags})||'':'';fields.tags.value=incomingTags.filter(tag=>values.category!=='transport'||!isTransportTag(tag)).join(', ');
    areaPicker.setValue(values.serviceAreas??null);areaTouched=Object.hasOwn(values,'serviceAreas');areaEditor.open=!!values.serviceAreas;
    showEditor();open();return true;
  }
  account.onReady(()=>{if(pendingOpen)open();});document.getElementById('post-button').onclick=open;
  window.addEventListener('pagehide',()=>{uploadController?.abort();releasePreview();void areaPicker.destroy();void uploader?.close()});
  return {open,edit,prefill,hide:({preservePending=false}={})=>{if(!preservePending)pendingOpen=false;dialog.hide();}};
}
