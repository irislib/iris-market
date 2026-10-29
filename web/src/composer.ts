import { createSurface } from './surface.ts';
import { byId, element as domElement, formFields } from './dom.ts';
import { LISTING_KIND, parseEvent } from './market.ts';
import { nhashDecode, toHex } from '@hashtree/core';
import { createDraftFiles, renderComposerPreview } from './composer-preview.ts';
import { expirationFromInput, expirationInput, listingPublishedAt } from './listing-dates.ts';
import {serviceAreaTags,parseServiceAreas} from './service-area.ts';
import {setupServiceAreaPicker} from './service-area-ui.ts';

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
export function listingDraft(values, { identifier=crypto.randomUUID(), createdAt=Math.floor(Date.now()/1000), attachments=[] }={}) {
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
  for(const label of extraTags)if(label!==values.category)tags.push(['t',label]);
  const expiration=expirationFromInput(values.expiration,createdAt);
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
  const draft=listingDraft(values,{identifier:previous.identifier,createdAt:Math.max(Math.floor(Date.now()/1000),previous.createdAt+1),attachments});
  draft.tags.find(tag=>tag[0]==='published_at')[1]=String(listingPublishedAt(previous)??previous.createdAt);
  const replaced=new Set(['d','title','market','price','location','status','published_at','expiration']);
  for(const tag of previous.originalTags||[]){
    if(Object.hasOwn(values,'serviceAreas')&&(tag[0]==='service_area'||tag[0]==='g'&&['pickup','destination'].includes(tag[2])))continue;
    if(replaced.has(tag[0])||tag[0]==='t'&&(tag[1]===previous.category||Object.hasOwn(values,'tags'))||tag[0]==='image'&&tag[1]===previous.imageUrl)continue;
    if(!draft.tags.some(value=>JSON.stringify(value)===JSON.stringify(tag)))draft.tags.push([...tag]);
  }
  return draft;
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
  dialog.innerHTML=`<button class="dialog-close icon-button" id="post-close" aria-label="Close listing editor">×</button><h2>Post a listing</h2><form id="post-form"><div class="post-side-tabs" role="radiogroup" aria-label="Listing type"><button type="button" role="radio" data-post-side="offer" aria-checked="true">Selling</button><button type="button" role="radio" data-post-side="request" aria-checked="false" tabindex="-1">Buying</button></div><input type="hidden" name="side" value="offer"><label>Category<select name="category"><option value="other">Other</option><option value="home">Home</option><option value="tech">Tech</option><option value="services">Services</option><option value="transport">Transport</option><option value="work">Work</option></select></label><label>Title<input name="title" maxlength="160" required autocomplete="off"></label><label>Description<textarea name="description" rows="4" maxlength="12000"></textarea></label><div class="form-pair"><label>Price<input name="price" inputmode="decimal" placeholder="Negotiable"></label><label>Currency<input name="currency" maxlength="12" autocapitalize="characters"></label></div><label>Location <span class="muted">· optional</span><input name="location" maxlength="160" placeholder="City or area" autocomplete="off"></label><label>Tags <span class="muted">· optional</span><input name="tags" maxlength="488" placeholder="For example: courier, parcel" autocomplete="off"></label><label>Expires <span class="muted">· optional</span><input name="expiration" type="datetime-local"></label><label>Photos & files<input id="post-files" type="file" multiple aria-describedby="post-file-help"></label><p id="post-file-help" class="small muted">Up to 4 files · 8 MB each</p><ul id="post-file-list" class="post-file-list"></ul><details class="post-image-link"><summary>Image link</summary><label><span class="sr-only">Image link</span><input name="image" type="url" placeholder="https://…" autocomplete="off"></label></details><button id="post-submit" class="button primary">Preview listing</button></form><section id="post-preview" hidden><div id="post-preview-content"></div><p class="small muted">Your listing and attached files will be public.</p><div class="post-preview-actions"><button id="post-edit" type="button" class="button secondary">Edit</button><button id="post-publish" type="button" class="button primary">Publish listing</button></div></section><p id="post-progress" class="small muted" role="status"></p><p id="post-error" class="error" role="alert"></p>`;
  const form=dialog.querySelector('form'),submit=dialog.querySelector<HTMLButtonElement>('#post-submit'),error=dialog.querySelector('#post-error'),progress=dialog.querySelector('#post-progress'),fileInput=dialog.querySelector<HTMLInputElement>('#post-files'),fileList=dialog.querySelector('#post-file-list');
  const preview=dialog.querySelector<HTMLElement>('#post-preview'),previewContent=dialog.querySelector('#post-preview-content'),editButton=dialog.querySelector<HTMLButtonElement>('#post-edit'),publish=dialog.querySelector<HTMLButtonElement>('#post-publish');
  const sideButtons=[...dialog.querySelectorAll<HTMLButtonElement>('[data-post-side]')];
  let draftId=crypto.randomUUID(),editing=null,pendingEvent,busy=false,pendingOpen=false,currencyTouched=false,uploader,uploadController,filePosition;
  let reviewedValues:Record<string,unknown>|undefined,reviewOwner:string|undefined,localFiles:ReturnType<typeof createDraftFiles>|undefined;
  let areaTouched=false,areaPreview:ReturnType<typeof setupServiceAreaPicker>|undefined;
  const areaPicker=setupServiceAreaPicker({onChange:()=>{areaTouched=true;pendingEvent=null;}});
  const areaEditor=domElement('details',undefined,'post-service-areas');areaEditor.append(domElement('summary','Transport areas'),areaPicker.element);
  formFields(form).location.closest('label').after(areaEditor);
  function syncAreaEditor(){areaEditor.hidden=formFields(form).category.value!=='transport'&&!areaTouched&&!editing?.serviceAreas;if(dialog.open&&!form.hidden&&!areaEditor.hidden&&areaEditor.open)void areaPicker.show();else areaPicker.hide();}
  areaEditor.ontoggle=syncAreaEditor;
  formFields(form).category.addEventListener('change',syncAreaEditor);
  const selection=createAttachmentSelection(async(file,options)=>{
    if(!uploader){const module=await loadUploader();uploader=module.createMediaUploader({signEvent:draft=>account.messaging.signEvent(draft),getCacheMiB:()=>Number(byId('map-cache')?.value)||128,onProgress:step=>{const phase={preparing:'Preparing',uploading:'Uploading',verifying:'Checking',complete:'Checking'}[step.phase]||'Uploading';progress.textContent=`${phase} file ${filePosition.index+1} of ${filePosition.total}…`;}});}
    return uploader.upload(file,options);
  });
  function releasePreview(){localFiles?.close();localFiles=undefined;void areaPreview?.destroy();areaPreview=undefined;previewContent.replaceChildren();}
  function paintSide(){for(const button of sideButtons){const selected=button.dataset.postSide===formFields(form).side.value;button.setAttribute('aria-checked',String(selected));button.tabIndex=selected?0:-1;}}
  function chooseSide(button:HTMLButtonElement){if(busy)return;formFields(form).side.value=button.dataset.postSide;pendingEvent=null;paintSide();}
  for(const button of sideButtons){button.onclick=()=>chooseSide(button);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?sideButtons[0]:event.key==='End'?sideButtons[1]:sideButtons.find(other=>other!==button);chooseSide(next);next.focus();};}
  function paintFiles(){fileList.replaceChildren(...selection.items().map((entry,index)=>{const row=document.createElement('li'),name=document.createElement('span'),remove=document.createElement('button');name.textContent=entry.file.name;remove.type='button';remove.className='text-button';remove.textContent='Remove';remove.disabled=busy;remove.setAttribute('aria-label',`Remove ${entry.file.name}`);remove.onclick=()=>{selection.remove(index);pendingEvent=null;paintFiles()};row.append(name,remove);return row}));}
  const setBusy=value=>{busy=value;for(const field of form.elements)(field as HTMLInputElement).disabled=value;editButton.disabled=value;publish.disabled=value;paintFiles();publish.textContent=value?(editing?'Saving…':'Publishing…'):(editing?'Save changes':'Publish listing');};
  function showEditor(){releasePreview();reviewedValues=undefined;reviewOwner=undefined;form.hidden=false;preview.hidden=true;dialog.classList.remove('showing-preview');dialog.querySelector('h2').textContent=editing?'Edit listing':'Post a listing';error.textContent='';progress.textContent='';syncAreaEditor();}
  function drawPreview(){
    releasePreview();
    const draft=editing?revisedListingDraft(reviewedValues,editing):listingDraft(reviewedValues,{identifier:draftId});
    localFiles=createDraftFiles(selection.items().map(item=>item.file));
    previewContent.append(renderComposerPreview(draft,localFiles.items,{priceNode}));
    form.hidden=true;preview.hidden=false;dialog.classList.add('showing-preview');dialog.querySelector('h2').textContent='Preview';publish.textContent=editing?'Save changes':'Publish listing';
    areaPicker.hide();const areas=parseServiceAreas(draft.tags);if(areas){areaPreview=setupServiceAreaPicker({value:areas,readOnly:true});const media=previewContent.querySelector('.detail-media');if(!draft.tags.some(tag=>tag[0]==='image')&&!localFiles.items.some(file=>file.image)&&media){media.classList.add('detail-area-media');media.replaceChildren(areaPreview.element);}else previewContent.append(areaPreview.element);void areaPreview.show();}
  }
  editButton.onclick=()=>{showEditor();formFields(form).title.focus();};
  dialog.querySelector<HTMLButtonElement>('#post-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{uploadController?.abort();releasePreview();areaPicker.hide();});
  form.addEventListener('input',event=>{pendingEvent=null;if((event.target as HTMLInputElement).name==='currency')currencyTouched=true;});
  fileInput.onchange=()=>{try{selection.add(fileInput.files);pendingEvent=null;error.textContent='';paintFiles()}catch(cause){error.textContent=cause.message}finally{fileInput.value=''}};
  form.onsubmit=event=>{
    event.preventDefault();if(busy)return;
    const values:Record<string,unknown>=Object.fromEntries(new FormData(form));error.textContent='';progress.textContent='';
    try{if(areaTouched)values.serviceAreas=areaPicker.validate();listingDraft(values,{identifier:draftId});reviewedValues=values;reviewOwner=account.state().ownerPubkey;drawPreview();const heading=dialog.querySelector('h2');heading.tabIndex=-1;heading.focus();heading.scrollIntoView({block:'start'});}
    catch(cause){releasePreview();reviewedValues=undefined;error.textContent=cause.message;}
  };
  publish.onclick=async()=>{
    if(busy||!reviewedValues)return;
    if(!account.state().canSign){pendingOpen=true;account.showAccount({posting:true});return;}
    error.textContent='';progress.textContent='';
    const owner=account.state().ownerPubkey;
    try{if(isPreview())throw new Error('Switch to the live market to post.');if(reviewOwner&&reviewOwner!==owner)throw new Error('Your profile changed. Edit and preview the listing again.');if(editing&&editing.author!==owner)throw new Error('Sign in with the profile that owns this listing.');}
    catch(cause){error.textContent=cause.message;return;}
    const values={...reviewedValues};if(pendingEvent?.pubkey!==owner)pendingEvent=null;uploadController=new AbortController();const active=uploadController;setBusy(true);
    try {
      const files=await selection.uploadAll({signal:active.signal,onFile:(index,total)=>{filePosition={index,total}}});
      if(active.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      if(account.state().ownerPubkey!==owner)throw new Error('Your profile changed. Edit and preview the listing again.');
      const draft=editing?revisedListingDraft(values,editing,files):listingDraft(values,{identifier:draftId,attachments:files});
      progress.textContent='Publishing listing…';const signed=pendingEvent||await account.messaging.signEvent(draft);parseEvent(signed);
      if(active.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      pendingEvent=signed;const receipt=await account.messaging.publishSignedEvent(signed);onPublished(signed,receipt);pendingEvent=null;editing=null;draftId=crypto.randomUUID();form.reset();selection.clear();currencyTouched=false;areaPicker.setValue(null);areaTouched=false;areaEditor.open=false;showEditor();paintSide();dialog.close();
    } catch(cause){error.textContent=cause.name==='AbortError'?'Upload stopped. Your draft and selected files are still here.':cause.message||'Could not publish. Your draft is still here.';}
    finally{uploadController=null;setBusy(false);progress.textContent='';}
  };
  function open(){pendingOpen=false;account.closeAccount();if(!reviewedValues&&!currencyTouched&&formFields(form).currency.value!==defaultCurrency()){formFields(form).currency.value=defaultCurrency();pendingEvent=null;}error.textContent='';paintSide();if(reviewedValues)drawPreview();dialog.showModal();syncAreaEditor();}
  function edit(listing){if(listing.author!==account.state().ownerPubkey)return;editing=listing;draftId=listing.identifier;pendingEvent=null;selection.clear();paintFiles();const fields=formFields(form);for(const key of ['side','title','description','price','currency','location'])fields[key].value=listing[key]??'';fields.category.value=String(listing.category).toLowerCase();if(!fields.category.value)fields.category.value='other';fields.image.value=listing.imageUrl||'';fields.tags.value=(listing.tags||[]).filter(tag=>tag!==listing.category).join(', ');fields.expiration.value=expirationInput(listing.expiration);areaPicker.setValue(listing.serviceAreas??null);areaTouched=false;areaEditor.open=!!listing.serviceAreas;currencyTouched=true;showEditor();open();}
  function hasAreaDraft(){try{return !!areaPicker.validate();}catch{return true;}}
  function prefill(values){
    const fields=formFields(form);
    if(busy||editing||reviewedValues||selection.items().length||hasAreaDraft()||['title','description','price','location','image','tags','expiration'].some(key=>fields[key].value.trim())){
      open();error.textContent='Your current draft is still here. Finish it before starting another listing.';return false;
    }
    // A service announcement is an ordinary editable listing; publishing still
    // requires the normal explicit preview and Publish action.
    for(const key of ['side','category','title','description','price','location'])fields[key].value=String(values[key]??'');
    fields.tags.value=Array.isArray(values.tags)?values.tags.join(', '):String(values.tags||'');
    areaPicker.setValue(values.serviceAreas??null);areaTouched=Object.hasOwn(values,'serviceAreas');areaEditor.open=!!values.serviceAreas;
    showEditor();open();return true;
  }
  account.onReady(()=>{if(pendingOpen)open();});document.getElementById('post-button').onclick=open;
  window.addEventListener('pagehide',()=>{uploadController?.abort();releasePreview();void areaPicker.destroy();void uploader?.close()});
  return {open,edit,prefill,hide:({preservePending=false}={})=>{if(!preservePending)pendingOpen=false;dialog.hide();}};
}
