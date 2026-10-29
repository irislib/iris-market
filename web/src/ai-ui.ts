import { byId, element } from './dom.ts';
import { FeedFilterClient, FEED_MODELS } from './feed-filter/client.ts';
import {BrowserFeedFilterClient} from './feed-filter/browser-client.ts';
import {planBrowserTags} from './feed-filter/browser-tags.ts';
import { searchCondition, listingSearchTexts } from './search-condition.ts';
const $=byId;
const keyFor = listing => listing.eventId || listing.id;
export const AI_MODE_STORAGE_KEY='market-ai-mode-v1',AI_MODEL_STORAGE_KEY='market-ai-model-v1';
interface SearchListing {id:string;eventId?:string;title:string;description?:string;side?:string;category?:string;location?:string;tags?:string[];price?:string|number;currency?:string}
interface AIOptions {getCandidates:()=>SearchListing[];onChange:()=>void;onTextSearch?:(query:string)=>void;fetchMoreCandidates?:()=>Promise<boolean>;client?:Pick<FeedFilterClient,'info'|'load'|'classify'|'dispose'>;browserClient?:BrowserFeedFilterClient;hasWebGPU?:()=>boolean;autoPrepare?:boolean;storage?:Pick<Storage,'getItem'|'setItem'>;saveData?:()=>boolean}
interface SourceRequest {epoch:number;done:boolean;more?:boolean;error?:unknown}
export function setupAI({ getCandidates, onChange, onTextSearch, fetchMoreCandidates, client = new FeedFilterClient(), browserClient=new BrowserFeedFilterClient(),hasWebGPU=()=>!!globalThis.navigator&&'gpu' in globalThis.navigator,autoPrepare=true,storage:providedStorage,saveData=()=>!!(globalThis.navigator as Navigator&{connection?:{saveData?:boolean}})?.connection?.saveData }:AIOptions) {
  let scores = new Map(), showAll = false, phase:'idle'|'loading'|'searching'='idle', generation = 0, submittedQuery='', paused=false;
  let storage=providedStorage;try{storage??=globalThis.localStorage;}catch{}
  const readSetting=(key:string)=>{try{return storage?.getItem(key);}catch{return null;}};
  const writeSetting=(key:string,value:string)=>{try{storage?.setItem(key,value);}catch{}};
  let preference=readSetting(AI_MODE_STORAGE_KEY),preferredModel=readSetting(AI_MODEL_STORAGE_KEY),textSubmitted=false,closed=false;
  let preparation:{model:string;runtime:typeof client|BrowserFeedFilterClient;promise:Promise<unknown>}|undefined,prepareGeneration=0,downloadFraction:number|undefined;
  const runtime=()=>$('ai-model').value==='browser'?browserClient:client;
  const setEnabled=(active:boolean)=>{$('search-mode').value=active?'ai':'text';$('search-mode').setAttribute('aria-pressed',String(active));};
  if(preference==='on'||preference==='off')setEnabled(preference==='on');
  if(preferredModel==='deberta')$('ai-model').value='deberta';
  let targetMatches=24,sourceExhausted=false;
  let sourceEpoch=0,sourceRequest:SourceRequest|null=null,wakeCandidates:(()=>void)|null=null;
  const progress=element('progress');progress.id='ai-download-progress';progress.max=1;progress.hidden=true;progress.setAttribute('aria-label','Model download');
  $('ai-options').append(progress);
  const enabled = () => $('search-mode').value === 'ai';
  const threshold = () => ['qwen35','browser'].includes($('ai-model').value) ? .5 : Number($('ai-threshold').value);
  const needsCPU = () => $('ai-model').value === 'qwen35' && !hasWebGPU();
  const candidates=()=>getCandidates().slice(0,1000);
  const matchCount=()=>candidates().filter(listing=>scores.has(keyFor(listing))&&scores.get(keyFor(listing))>=threshold()).length;
  const refresh = () => {
    const candidates = getCandidates(), active = enabled(), busy=phase!=='idle';
    const hidden = submittedQuery?candidates.filter(l => !scores.has(keyFor(l))||scores.get(keyFor(l))<threshold()).length:0;
    const matches=candidates.length-hidden,matchLabel=`${matches} ${matches===1?'match':'matches'}`;
    $('ai-options').hidden = !active;
    $('ai-summary').hidden = !active || (!submittedQuery && !busy);
    $('ai-summary-text').textContent = showAll ? 'Showing all listings' : phase==='loading' ? $('ai-progress').textContent : busy ? `Searching…${matches?` · ${matchLabel}`:''}` : `${paused?'Search paused · ':''}${matchLabel}`;
    $('ai-show-all').textContent = showAll ? 'Use AI matches' : 'Show all';
    $('ai-show-all').hidden = !submittedQuery||(!hidden&&!showAll&&!$('ai-error').textContent);
    $('ai-stop').hidden = !busy;
    $('ai-model').disabled = busy;
    $('ai-threshold').disabled = ['qwen35','browser'].includes($('ai-model').value);
    const query=$('search').value.trim(),download=FEED_MODELS[$('ai-model').value]?.downloadMB;
    $('search-run').disabled = phase==='loading';
    $('search-run').textContent = !active ? 'Search' : phase==='loading' ? 'Loading model…' : needsCPU() ? 'Use CPU model' : !runtime().info ? $('ai-model').value==='browser' ? 'Use browser AI' : `${query?'Load & search':'Load model'} · ${download} MB` : 'Search with AI';
    const preparing=!!preparation||phase==='loading';
    $('search-mode').setAttribute('data-loading',String(preparing));$('search-mode').setAttribute('data-indeterminate',String(preparing&&downloadFraction===undefined));
    $('search-mode').setAttribute('aria-busy',String(preparing));$('search-mode').style?.setProperty('--ai-download',String(downloadFraction??0));
    $('search-mode').title=preparing?`Preparing AI${downloadFraction===undefined?'':` · ${Math.round(downloadFraction*100)}%`}`:active?'Turn off AI search':'Turn on AI search';
    progress.hidden=phase!=='loading';
    if(active&&!busy&&!$('ai-error').textContent){
      $('ai-progress').textContent = needsCPU() ? 'Qwen is unavailable in this browser. Use the smaller CPU model.' : submittedQuery&&!candidates.length ? 'Refresh listings or clear filters to search.' : '';
    }
    $('ai-progress').hidden=busy||!$('ai-progress').textContent;
    if(active)$('search').setAttribute('aria-describedby','ai-progress');else $('search').removeAttribute('aria-describedby');
    $('search').placeholder = active ? 'Describe what you’re looking for' : 'Search listings';
    wakeCandidates?.();
  };
  function prepareModel():Promise<unknown> {
    const selected=runtime(),model=$('ai-model').value;
    if(selected.info)return Promise.resolve(selected.info);
    if(preparation?.runtime===selected&&preparation.model===model)return preparation.promise;
    const current=++prepareGeneration;downloadFraction=undefined;
    let loading:Promise<unknown>;
    try{loading=selected.load(model,model==='deberta'?'wasm':model==='browser'?'auto':'webgpu',(message,details)=>{
      if(current!==prepareGeneration||closed)return;
      $('ai-progress').textContent=message;
      downloadFraction=details&&Number.isFinite(details.total)&&details.total>0?Math.min(1,Math.max(0,details.loaded/details.total)):undefined;
      if(downloadFraction!==undefined)progress.value=downloadFraction;else progress.removeAttribute('value');refresh();
    });}catch(error){return Promise.reject(error);}
    const promise=Promise.resolve(loading).finally(()=>{if(current===prepareGeneration){preparation=undefined;downloadFraction=undefined;refresh();}});
    preparation={model,runtime:selected,promise};refresh();return promise;
  }
  // Relay pages can remain pending after verified events have already arrived.
  // Keep one source operation, but wake classification on each candidate update.
  function requestCandidates() {
    const request:SourceRequest={epoch:sourceEpoch,done:false};sourceRequest=request;
    void Promise.resolve().then(()=>fetchMoreCandidates()).then(more=>{request.more=more;},error=>{request.error=error instanceof Error?error:new Error('Could not load more listings');}).then(()=>{
      request.done=true;
      if(request.epoch===sourceEpoch&&request.more===false)sourceExhausted=true;
      wakeCandidates?.();
      if(request.epoch===sourceEpoch){refresh();onChange();}
    });
    return request;
  }
  function waitForCandidates(current:number,request:SourceRequest) {
    return new Promise<void>(resolve=>{
      const wake=()=>{
        if(current!==generation||request.done||matchCount()>=targetMatches||candidates().some(listing=>!scores.has(keyFor(listing)))){
          if(wakeCandidates===wake)wakeCandidates=null;
          resolve();
        }
      };
      wakeCandidates=wake;wake();
    });
  }
  function stop({reset=false,unload=true}={}) {
    generation++;sourceEpoch++;wakeCandidates?.();if(unload){prepareGeneration++;preparation=undefined;downloadFraction=undefined;client.dispose();browserClient.dispose();}phase='idle';paused=!reset;progress.hidden=true;$('ai-progress').textContent='';
    if(reset){scores.clear();submittedQuery='';showAll=false;sourceExhausted=false;targetMatches=24;$('ai-error').textContent='';}
    refresh();onChange();
  }
  async function run({continuation=false}={}) {
    if (!enabled()) { textSubmitted=true;onTextSearch?.($('search').value.trim()); onChange(); return; }
    if(phase==='loading'||continuation&&phase!=='idle')return;
    if(continuation&&!submittedQuery)return;
    if(needsCPU()){$('ai-model').value='deberta';stop();return;}
    const current = ++generation;
    const selected=runtime();
    wakeCandidates?.();
    paused=false;
    if(!continuation){sourceEpoch++;submittedQuery=$('search').value.trim();scores.clear();showAll=false;sourceExhausted=false;targetMatches=24;}
    else targetMatches=matchCount()+24;
    $('ai-error').textContent='';
    phase=selected.info?'searching':'loading';onChange();
    if(selected.info&&!submittedQuery){phase='idle';refresh();return;}
    try {
      if (!selected.info) {
        phase='loading';progress.removeAttribute('value');$('ai-progress').textContent='Loading model…';refresh();
        await prepareModel();
      }
      if (current !== generation) return;
      // Use the latest query, including edits made while the model was downloading.
      const query=continuation?submittedQuery:$('search').value.trim();
      if(query!==submittedQuery){submittedQuery=query;scores.clear();onChange();}
      if(!query||!enabled())return;
      const condition=searchCondition(query);let sourceRequests=0;
      phase='searching';
      while(matchCount()<targetMatches) {
        if (current !== generation) return;
        const item=candidates().find(listing=>!scores.has(keyFor(listing)));
        if(!item){
          if(sourceRequest?.done){
            const completed=sourceRequest;sourceRequest=null;
            if(completed.epoch===sourceEpoch){
              if(completed.error)throw completed.error;
              if(completed.more===false)sourceExhausted=true;
            }
            continue;
          }
          if(!sourceRequest){
            if(!fetchMoreCandidates||sourceExhausted||sourceRequests>=32)break;
            sourceRequests++;requestCandidates();
          }
          $('ai-progress').textContent='Searching…';refresh();
          await waitForCandidates(current,sourceRequest);
          if(current!==generation)return;
          continue;
        }
        $('ai-progress').textContent = 'Searching…'; refresh();
        let score=0;
        for(const text of listingSearchTexts(item,query,$('ai-model').value)){
          const result=await selected.classify(condition,text,{eventId:item.eventId});
          if(current!==generation)return;
          if(!Number.isFinite(result.score))throw new Error('The model returned an invalid decision');
          score=Math.max(score,result.score);
          if(score>=threshold())break;
        }
        scores.set(keyFor(item),score);onChange();
      }
    } catch (error) {
      if (current === generation) { paused=true;selected.dispose(); $('ai-error').textContent = `${error.message || 'Search failed'}. Show all listings or switch to Text to continue browsing.`; }
    } finally { if (current === generation) { phase='idle';$('ai-progress').textContent='';refresh();onChange(); } }
  }
  $('search-mode').onclick = () => {
    const active=!enabled();preference=active?'on':'off';writeSetting(AI_MODE_STORAGE_KEY,preference);setEnabled(active);
    if(active)return run();stop({reset:true});
  };
  // Editing waits for Submit; clearing is an immediate cancellation/reset.
  $('search').addEventListener('input',()=>{
    if(!$('search').value.trim()){stop({reset:true,unload:phase!=='idle'});onTextSearch?.('');onChange();}
    else refresh();
  });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
  const activateBrowser=(event:Event)=>{
    if(!event.isTrusted||!globalThis.navigator?.userActivation?.isActive||!enabled()||$('ai-model').value!=='browser'||browserClient.info||preparation||closed)return;
    void prepareModel().catch(error=>{if(!closed&&enabled()){$('ai-error').textContent=error.message||'Could not prepare browser AI.';refresh();}});
  };
  $('search').addEventListener('click',activateBrowser);$('search').addEventListener('keydown',activateBrowser);
  $('search-run').onclick = () => run();
  $('ai-model').onchange = () => {preferredModel=$('ai-model').value;writeSetting(AI_MODEL_STORAGE_KEY,preferredModel);stop({reset:true});};
  $('ai-threshold').onchange = () => { refresh(); onChange(); };
  $('ai-stop').onclick = () => stop();
  $('ai-unload').onclick = () => {preference='off';writeSetting(AI_MODE_STORAGE_KEY,preference);setEnabled(false);stop({reset:true});};
  $('ai-show-all').onclick = () => { showAll = !showAll; refresh(); onChange(); };
  window.addEventListener('pagehide', () => {closed=true;generation++;sourceEpoch++;prepareGeneration++;wakeCandidates?.();client.dispose();browserClient.dispose();});
  const ready=Promise.resolve().then(async()=>{
    const available=await browserClient.probe();if(closed)return;
    if(available!=='unavailable'){
      const option=element('option','Browser model · on device');option.value='browser';$('ai-model').append(option);$('ai-model').closest?.('label')?.removeAttribute('hidden');
      if(preferredModel==='browser')$('ai-model').value='browser';
    }
    if(!autoPrepare||preference==='off'||phase!=='idle'||preferredModel==='browser'&&available==='unavailable')return;
    if(!runtime().info&&(saveData()||$('ai-model').value==='browser'&&available!=='available'))return;
    try{await prepareModel();if(!closed&&preference!=='off'&&!textSubmitted){setEnabled(true);refresh();onChange();}}
    catch{/* Background preparation is optional. Explicit Search can retry without blocking Browse. */}
  });
  const pagination=()=>{const rows=candidates(),remaining=rows.filter(listing=>!scores.has(keyFor(listing))).length;return{hasMore:enabled()&&!!submittedQuery&&!showAll&&(remaining>0||!!fetchMoreCandidates&&!sourceExhausted),loading:phase!=='idle',paused,error:$('ai-error').textContent,remaining,reviewed:rows.length-remaining,matches:matchCount(),target:targetMatches};};
  const scoreFor=(listing:SearchListing):number|undefined=>{
    if(!enabled()||showAll||!submittedQuery||$('ai-error').textContent)return undefined;
    const score=scores.get(keyFor(listing));return Number.isFinite(score)?score:undefined;
  };
  const planTags=(query:string,tags:readonly string[],signal?:AbortSignal)=>{const epoch=generation;return planBrowserTags(query,tags,{info:enabled()&&$('ai-model').value==='browser'?browserClient.info:null,signal,isCurrent:()=>!closed&&generation===epoch&&enabled()&&$('ai-model').value==='browser'&&submittedQuery===query});};
  return { ready,planTags,enabled, query:()=>submittedQuery, searching:()=>phase!=='idle', loadMore:()=>run({continuation:true}), pagination, scoreFor, isVisible: listing => !enabled() || showAll || !submittedQuery || scores.has(keyFor(listing))&&scores.get(keyFor(listing))>=threshold(), refresh, stop: () => stop({reset:true}) };
}
