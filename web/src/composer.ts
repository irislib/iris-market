import { byId, element as domElement, formFields } from './dom.ts';
import { LISTING_KIND, parseEvent } from './market.ts';
import { nhashDecode, toHex } from '@hashtree/core';

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
  const tags=[['d',identifier],['title',title],['market',values.side],['t',values.category],['price',price,currency],['status','active']];
  if(location)tags.push(['location',location]);if(image)tags.push(['image',image]);
  for(const file of files){
    if(file.isImage)tags.push(['image',file.url]);
    tags.push(['imeta',`url ${file.url}`,`x ${file.sha256}`,`m ${file.mime}`,`size ${file.size}`,`alt ${file.name}`],['r',file.fileLink]);
  }
  return {kind:LISTING_KIND,created_at:createdAt,tags,content};
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

export function setupComposer({account,isPreview,onPublished,defaultCurrency=()=> 'EUR',loadUploader=()=>import('./uploads.ts')}) {
  const dialog=document.createElement('dialog');dialog.className='composer-dialog';dialog.setAttribute('aria-label','Post a listing');
  dialog.innerHTML=`<button class="dialog-close icon-button" id="post-close" aria-label="Close listing editor">×</button><h2>Post a listing</h2><form id="post-form"><div class="form-pair"><label>Type<select name="side"><option value="offer">Selling</option><option value="request">Buying</option></select></label><label>Category<select name="category"><option value="other">Other</option><option value="home">Home</option><option value="tech">Tech</option><option value="services">Services</option><option value="transport">Transport</option><option value="work">Work</option></select></label></div><label>Title<input name="title" maxlength="160" required autocomplete="off"></label><label>Description<textarea name="description" rows="4" maxlength="12000"></textarea></label><div class="form-pair"><label>Price<input name="price" inputmode="decimal" placeholder="Negotiable"></label><label>Currency<input name="currency" maxlength="12" autocapitalize="characters"></label></div><label>Location <span class="muted">· optional</span><input name="location" maxlength="160" placeholder="City or area" autocomplete="off"></label><label>Photos & files<input id="post-files" type="file" multiple aria-describedby="post-file-help"></label><p id="post-file-help" class="small muted">Up to 4 files · 8 MB each</p><ul id="post-file-list" class="post-file-list"></ul><details class="post-image-link"><summary>Image link</summary><label><span class="sr-only">Image link</span><input name="image" type="url" placeholder="https://…" autocomplete="off"></label></details><p class="small muted">Your listing and attached files are public.</p><p id="post-progress" class="small muted" role="status"></p><p id="post-error" class="error" role="alert"></p><button id="post-submit" class="button primary">Publish listing</button></form>`;
  document.body.append(dialog);const form=dialog.querySelector('form'),submit=dialog.querySelector('#post-submit'),error=dialog.querySelector('#post-error'),progress=dialog.querySelector('#post-progress'),fileInput=dialog.querySelector<HTMLInputElement>('#post-files'),fileList=dialog.querySelector('#post-file-list');
  let draftId=crypto.randomUUID(),pendingEvent,busy=false,pendingOpen=false,currencyTouched=false,uploader,uploadController,filePosition;
  const selection=createAttachmentSelection(async(file,options)=>{
    if(!uploader){const module=await loadUploader();uploader=module.createMediaUploader({signEvent:draft=>account.messaging.signEvent(draft),getCacheMiB:()=>Number(byId('map-cache')?.value)||128,onProgress:step=>{const phase={preparing:'Preparing',uploading:'Uploading',verifying:'Checking',complete:'Ready'}[step.phase]||'Uploading';progress.textContent=`${phase} file ${filePosition.index+1} of ${filePosition.total}…`;}});}
    return uploader.upload(file,options);
  });
  function paintFiles(){fileList.replaceChildren(...selection.items().map((entry,index)=>{const row=document.createElement('li'),name=document.createElement('span'),remove=document.createElement('button');name.textContent=entry.file.name;remove.type='button';remove.className='text-button';remove.textContent='Remove';remove.disabled=busy;remove.setAttribute('aria-label',`Remove ${entry.file.name}`);remove.onclick=()=>{selection.remove(index);pendingEvent=null;paintFiles()};row.append(name,remove);return row}));}
  const setBusy=value=>{busy=value;for(const field of form.elements)(field as HTMLInputElement).disabled=value;paintFiles();submit.textContent=value?'Publishing…':'Publish listing';};
  dialog.querySelector<HTMLButtonElement>('#post-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>uploadController?.abort());
  form.addEventListener('input',event=>{pendingEvent=null;if((event.target as HTMLInputElement).name==='currency')currencyTouched=true;});
  fileInput.onchange=()=>{try{selection.add(fileInput.files);pendingEvent=null;error.textContent='';paintFiles()}catch(cause){error.textContent=cause.message}finally{fileInput.value=''}};
  form.onsubmit=async event=>{
    event.preventDefault();if(busy)return;
    const values=Object.fromEntries(new FormData(form));error.textContent='';progress.textContent='';
    try { if(isPreview())throw new Error('Switch to the live market to post.');listingDraft(values,{identifier:draftId}); }
    catch(cause){error.textContent=cause.message;return;}
    const owner=account.state().ownerPubkey;if(pendingEvent?.pubkey!==owner)pendingEvent=null;uploadController=new AbortController();const active=uploadController;setBusy(true);
    try {
      const files=await selection.uploadAll({signal:active.signal,onFile:(index,total)=>{filePosition={index,total}}});
      if(active.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      if(account.state().ownerPubkey!==owner)throw new Error('Account changed. Review your draft before publishing.');
      const draft=listingDraft(values,{identifier:draftId,attachments:files});
      progress.textContent='Publishing listing…';const signed=pendingEvent||await account.messaging.signEvent(draft);parseEvent(signed);
      if(active.signal.aborted)throw new DOMException('Upload cancelled','AbortError');
      pendingEvent=signed;const receipt=await account.messaging.publishSignedEvent(signed);onPublished(signed,receipt);pendingEvent=null;draftId=crypto.randomUUID();form.reset();selection.clear();currencyTouched=false;dialog.close();
    } catch(cause){error.textContent=cause.name==='AbortError'?'Upload stopped. Your draft and selected files are still here.':cause.message||'Could not publish. Your draft is still here.';}
    finally{uploadController=null;setBusy(false);progress.textContent='';}
  };
  function open(){if(!account.state().canSign){pendingOpen=true;account.showAccount({posting:true});return}pendingOpen=false;account.closeAccount();if(!currencyTouched&&formFields(form).currency.value!==defaultCurrency()){formFields(form).currency.value=defaultCurrency();pendingEvent=null;}error.textContent='';dialog.showModal();}
  account.onReady(()=>{if(pendingOpen)open();});document.getElementById('post-button').onclick=open;
  window.addEventListener('pagehide',()=>{uploadController?.abort();void uploader?.close()});
  return {open};
}
