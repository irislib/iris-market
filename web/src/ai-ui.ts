import {spaceSellers} from './seller-spacing.ts';
import { byId, element } from './dom.ts';
import { FeedFilterClient } from './feed-filter/client.ts';
import {BrowserFeedFilterClient} from './feed-filter/browser-client.ts';
import {planBrowserTags} from './feed-filter/browser-tags.ts';
import { listingSearchText, scoreSearchListing } from './search-condition.ts';
import {homeFeedConditions,homeProductText,homeFeedPreferences,type HomeFeedPreferences} from './home-feed.ts';
const $=byId;
const keyFor = listing => listing.eventId || listing.id;
export const AI_MODE_STORAGE_KEY='market-ai-mode-v1',AI_MODEL_STORAGE_KEY='market-ai-model-v1';
interface SearchListing {id:string;author?:string;eventId?:string;title:string;description?:string;side?:string;category?:string;location?:string;tags?:string[];price?:string|number;currency?:string}
interface AIOptions {getCandidates:()=>SearchListing[];onChange:()=>void;onTextSearch?:(query:string)=>void;onSubmit?:(query:string)=>void;fetchMoreCandidates?:()=>Promise<boolean>;client?:Pick<FeedFilterClient,'info'|'load'|'classify'|'dispose'>&{pin?:()=>()=>void;selectSearchHead?:FeedFilterClient['selectSearchHead'];startSearchWorker?:FeedFilterClient['startSearchWorker']};browserClient?:BrowserFeedFilterClient;hasWebGPU?:()=>boolean;autoPrepare?:boolean;storage?:Pick<Storage,'getItem'|'setItem'>;saveData?:()=>boolean;homeFeed?:HomeFeedPreferences;isHomeVisible?:()=>boolean}
interface SourceRequest {epoch:number;done:boolean;more?:boolean;error?:unknown}
export function setupAI({ getCandidates, onChange, onTextSearch, onSubmit, fetchMoreCandidates, client = new FeedFilterClient(), browserClient=new BrowserFeedFilterClient(),hasWebGPU=()=>!!globalThis.navigator&&'gpu' in globalThis.navigator,autoPrepare=true,storage:providedStorage,saveData=()=>!!(globalThis.navigator as Navigator&{connection?:{saveData?:boolean}})?.connection?.saveData,homeFeed,isHomeVisible=()=>true }:AIOptions) {
  let scores = new Map(), showAll = false, phase:'idle'|'loading'|'searching'='idle', generation = 0, submittedQuery='', paused=false, waitingCandidates=false;
  let home=homeFeed?homeFeedPreferences(homeFeed):{enabled:false,prompt:''},homeContext='',homeStopped=false,homeScheduled=false,homeReviewLimit=240,homeWasVisible=isHomeVisible(),browserAvailable=false;
  const homeRequested=()=>enabled()&&home.enabled&&!submittedQuery&&isHomeVisible();
  const homeActive=()=>homeRequested()&&!!(runtime().info||homeContext||preparation||phase==='loading');
  const curationActive=()=>!!submittedQuery||homeActive();
  let storage=providedStorage;try{storage??=globalThis.localStorage;}catch{}
  const readSetting=(key:string)=>{try{return storage?.getItem(key);}catch{return null;}};
  const writeSetting=(key:string,value:string)=>{try{storage?.setItem(key,value);}catch{}};
  let preference=readSetting(AI_MODE_STORAGE_KEY),preferredModel=readSetting(AI_MODEL_STORAGE_KEY),textSubmitted=false,closed=false;
  let preparation:{model:string;runtime:typeof client|BrowserFeedFilterClient;promise:Promise<unknown>}|undefined,prepareGeneration=0,downloadFraction:number|undefined;
  const runtime=()=>$('ai-model').value==='browser'?browserClient:client;
  const setEnabled=(active:boolean)=>{$('search-mode').value=active?'ai':'text';$('search-mode').setAttribute('aria-pressed',String(active));};
  // Older model selection saved no mode, even when automatic preparation had
  // enabled AI. Restore that choice without overriding an explicit Off.
  if(preference===null&&['browser','deberta'].includes(preferredModel)){preference='on';writeSetting(AI_MODE_STORAGE_KEY,preference);}
  if(preference==='on'||preference==='off')setEnabled(preference==='on');
  if(preferredModel==='deberta')$('ai-model').value='deberta';
  let browserOption:HTMLOptionElement|undefined;
  if(preferredModel==='browser'){
    browserOption=element('option','Browser model · checking availability');browserOption.value='browser';$('ai-model').append(browserOption);$('ai-model').value='browser';$('ai-model').closest?.('label')?.removeAttribute('hidden');
  }
  let testEpoch=0,testBusy=false,testRequested=false,testController:AbortController|null=null,testOwnsLoad=false,testRuntime:ReturnType<typeof runtime>|undefined;
  let testProgress:((message:string,details?:{loaded:number;total?:number})=>void)|undefined;
  let targetMatches=24,sourceExhausted=false,sourceError:string|null=null;
  let sourceEpoch=0,sourceRequest:SourceRequest|null=null,wakeCandidates:(()=>void)|null=null;
  let sourceErrorVisible=false,runController:AbortController|null=null;
  let activeRun:{query:string;promise:Promise<void>}|null=null;
  const progress=element('progress');progress.id='ai-download-progress';progress.max=1;progress.hidden=true;progress.setAttribute('aria-label','Model download');
  $('ai-summary').append(progress);
  const enabled = () => $('search-mode').value === 'ai';
  const threshold = () => ['qwen35','browser'].includes($('ai-model').value) ? .5 : Number($('ai-threshold').value);
  const needsCPU = () => $('ai-model').value === 'qwen35' && !hasWebGPU();
  const candidates=getCandidates;
  const matches=(listing:SearchListing)=>{const score=scores.get(keyFor(listing));return typeof score==='number'&&score>=threshold();};
  const matchCount=(rows=candidates())=>rows.reduce((count,item)=>count+Number(matches(item)),0);
  const reviewedCount=(rows:SearchListing[])=>new Set(rows.map(keyFor).filter(key=>scores.has(key))).size;
  const refresh = () => {
    const candidates = getCandidates(), active = enabled(), busy=phase!=='idle';
    const hidden = curationActive()?candidates.filter(l => !matches(l)).length:0;
    const count=candidates.length-hidden,matchLabel=`${count} ${count===1?'match':'matches'}`;

    $('ai-summary').hidden = !active || (!curationActive() && !busy);
    const activity = `${homeActive()?'For you · ':''}${matchLabel} · ${homeActive()?reviewedCount(candidates):scores.size} checked`;
    $('ai-summary-text').textContent = showAll ? 'Showing all listings' : phase==='loading' ? `${$('ai-progress').textContent || 'Loading model…'} · ${activity}` : `${waitingCandidates&&busy?'Waiting for listings · ':paused&&!sourceError?'Search paused · ':''}${activity}`;
    $('ai-show-all').textContent = showAll ? 'Use AI matches' : 'Show all';
    $('ai-show-all').hidden = !curationActive()||(!hidden&&!showAll&&!$('ai-error').textContent);
    $('ai-stop').hidden = !busy;
    $('ai-model').disabled = busy;
    $('ai-threshold').disabled = ['qwen35','browser'].includes($('ai-model').value);
    $('search-run').disabled = phase==='loading'||testBusy;
    $('ai-test-run').disabled=busy||testBusy;$('ai-test-run').textContent=testBusy?'Testing…':'Test';$('ai-test-run').setAttribute('aria-busy',String(testBusy));$('ai-test-cancel').hidden=!testBusy;
    $('search-run').textContent = 'Search';
    $('search-run').setAttribute('aria-busy',String(phase==='loading'));
    const preparing=!!preparation||phase==='loading';
    $('search-mode').setAttribute('data-loading',String(preparing));$('search-mode').setAttribute('data-indeterminate',String(preparing&&downloadFraction===undefined));
    $('search-mode').setAttribute('aria-busy',String(preparing));$('search-mode').style?.setProperty('--ai-download',String(downloadFraction??0));
    $('search-mode').title=preparing?`Preparing AI${downloadFraction===undefined?'':` · ${Math.round(downloadFraction*100)}%`}`:active?'Turn off AI search':'Turn on AI search';
    progress.hidden=phase!=='loading'||downloadFraction===undefined;
    if(active&&!busy&&!$('ai-error').textContent){
      $('ai-progress').textContent = needsCPU() ? 'Qwen is unavailable in this browser. Use the smaller CPU model.' : submittedQuery&&!candidates.length&&!sourceError ? 'Refresh listings or clear filters to search.' : '';
    }
    $('ai-progress').hidden=busy||!$('ai-progress').textContent;
    $('ai-options').hidden=!active||($('ai-progress').hidden&&!$('ai-error').textContent);
    if(active)$('search').setAttribute('aria-describedby','ai-progress');else $('search').removeAttribute('aria-describedby');
    $('search').placeholder = active ? 'Describe what you’re looking for' : 'Search listings';
    wakeCandidates?.();
    scheduleHome();
  };
  function scheduleHome() {
    if(homeScheduled||closed||!homeRequested()||homeStopped||showAll||phase!=='idle'||activeRun||testBusy||$('search').value.trim()||reviewedCount(candidates())>=homeReviewLimit||matchCount()>=targetMatches||!candidates().some(l=>!scores.has(keyFor(l))))return;
    if(!runtime().info&&(matchCount()>0||!autoPrepare||saveData()||$('ai-model').value==='browser'&&!browserAvailable))return;
    homeScheduled=true;
    queueMicrotask(()=>{homeScheduled=false;if(!closed&&homeRequested()&&!homeStopped&&phase==='idle'&&!activeRun&&!$('search').value.trim())void run({homeRun:true,automatic:true});});
  }
  function prepareModel():Promise<unknown> {
    const selected=runtime(),model=$('ai-model').value;
    if(selected.info)return Promise.resolve(selected.info);
    if(preparation?.runtime===selected&&preparation.model===model)return preparation.promise;
    const current=++prepareGeneration;downloadFraction=undefined;
    let loading:Promise<unknown>;
    try{loading=selected.load(model,model==='deberta'?'wasm':model==='browser'?'auto':'webgpu',(message,details)=>{
      if(current!==prepareGeneration||closed)return;
      testProgress?.(message,details);
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
  function stop({reset=false,unload=true,finishCurrent=false}={}) {
    homeStopped=!reset;
    sourceError=null;sourceErrorVisible=false;
    generation++;if(!finishCurrent)runController?.abort();runController=null;activeRun=null;sourceEpoch++;wakeCandidates?.();if(unload){prepareGeneration++;preparation=undefined;downloadFraction=undefined;client.dispose();browserClient.dispose();}phase='idle';waitingCandidates=false;paused=!reset;progress.hidden=true;$('ai-progress').textContent='';
    if(reset){scores.clear();submittedQuery='';homeContext='';homeReviewLimit=240;showAll=false;sourceExhausted=false;targetMatches=24;$('ai-error').textContent='';}
    refresh();onChange();
  }
  function run({continuation=false,homeRun=false,automatic=false}={}):Promise<void> {
    if(testBusy)return Promise.resolve();
    homeRun ||= homeRequested()&&!$('search').value.trim();
    const query=continuation?submittedQuery:$('search').value.trim();
    if(!homeRun&&homeContext)stop({reset:true,unload:false});
    if(!homeRun&&!continuation)onSubmit?.(query);
    // Repeated Submit must not restart a running pass or queue the same work.
    // A loading pass already adopts the latest input once preparation finishes.
    if(enabled()&&activeRun&&(phase==='loading'||activeRun.query===query))return activeRun.promise;
    const promise=executeRun({continuation,homeRun,automatic});
    const active={query,promise};activeRun=active;
    void promise.finally(()=>{if(activeRun===active){activeRun=null;scheduleHome();}}).catch(()=>{});
    return promise;
  }
  async function executeRun({continuation=false,homeRun=false,automatic=false}={}) {
    if (!enabled()) { textSubmitted=true;onTextSearch?.($('search').value.trim()); onChange(); return; }
    if(phase==='loading'||continuation&&phase!=='idle')return;
    if(continuation&&!submittedQuery&&!homeRun)return;
    if(needsCPU()){$('ai-model').value='deberta';stop();return;}
    const current = ++generation;
    runController?.abort();
    const controller=new AbortController();runController=controller;
    const selected=runtime();
    const releaseModel='pin' in selected&&typeof selected.pin==='function'?selected.pin():()=>{};
    wakeCandidates?.();
    const sameQuery=homeRun?homeContext===home.prompt:!!submittedQuery&&$('search').value.trim()===submittedQuery&&!homeContext;
    const preserve=continuation||sameQuery,retrySource=preserve&&!!sourceError;
    sourceError=null;sourceErrorVisible=false;
    paused=false;waitingCandidates=false;
    homeStopped=false;
    if(!preserve){sourceEpoch++;submittedQuery=homeRun?'':$('search').value.trim();homeContext=homeRun?home.prompt:'';homeReviewLimit=240;scores.clear();showAll=false;sourceExhausted=false;targetMatches=24;}
    else if(!retrySource&&!automatic){targetMatches=matchCount()+24;if(homeRun)homeReviewLimit=reviewedCount(candidates())+240;}
    $('ai-error').textContent='';
    phase=selected.info?'searching':'loading';onChange();
    if(selected.info&&!submittedQuery&&!homeRun){phase='idle';refresh();releaseModel();if(runController===controller)runController=null;return;}
    let extraWorker:FeedFilterClient|null=null;
    try {
      if (!selected.info) {
        phase='loading';progress.removeAttribute('value');$('ai-progress').textContent='Loading model…';refresh();
        await prepareModel();
      }
      if (current !== generation) return;
      // Use the latest query, including edits made while the model was downloading.
      const query=homeRun?'':continuation?submittedQuery:$('search').value.trim();
      if(activeRun)activeRun.query=query;
      if(query!==submittedQuery){sourceEpoch++;submittedQuery=query;scores.clear();if(!homeRun)onSubmit?.(query);onChange();}
      if(!enabled()||!query&&!homeRun||homeRun&&!homeActive())return;
      const model=$('ai-model').value;
      const searchHead=!homeRun&&'selectSearchHead' in selected&&!!(await selected.selectSearchHead?.(query,controller.signal));
      if(current!==generation)return;
      const conditions=homeRun?homeFeedConditions(home.prompt,model):[];
      // Use the broadest selectable cutoff so changing strictness never needs a rescan.
      const cutoffs=Array.from($('ai-threshold').options??[],option=>Number(option.value));
      const broadestCutoff=cutoffs.length?Math.min(...cutoffs):0;
      const review=async (item:SearchListing,worker:Pick<FeedFilterClient,'classify'>|BrowserFeedFilterClient)=>{
        const classify=(condition:string,text:string)=>worker.classify(condition,text,{eventId:item.eventId,signal:controller.signal,searchHead});
        if(!homeRun)return scoreSearchListing(item,query,model,classify,controller.signal,broadestCutoff);
        const text=listingSearchText(item);
        let score=1,cached=true;
        for(const [index,{condition,exclude,productConfirmation}] of conditions.entries()){
          controller.signal.throwIfAborted();
          const input=productConfirmation?homeProductText(item):text;
          const result=await classify(condition,input);
          if(current!==generation)break;
          cached&&=!!result.cached;
          if(!Number.isFinite(result.score))throw new Error('The model returned an invalid decision');
          let evidence=result.score;
          // A product name can sound medical out of context. Require agreement
          // before this additional exclusion can lower the full-listing score.
          if(productConfirmation&&evidence>1-score){
            const confirmation=await classify(productConfirmation,input);
            if(current!==generation)break;
            if(!Number.isFinite(confirmation.score))throw new Error('The model returned an invalid decision');
            cached&&=!!confirmation.cached;
            evidence=Math.min(evidence,confirmation.score);
          }
          score=Math.min(score,exclude?1-evidence:evidence);
          if(score<threshold()&&index+1<conditions.length){
            // Remaining conditions can only lower this score. Resume from the
            // decision cache if the reader later asks for a broad enough feed.
            return {score:score<broadestCutoff?null:{upperBound:score},cached};
          }
        }
        return {score,cached};
      };
      let uncached=0,attemptedWorker=false;
      let sourceRequests=0,unpainted=0,painted=false,lastPaint=performance.now();
      phase='searching';refresh();
      let reviewRows:SearchListing[]|undefined,rows:SearchListing[]=[],position=0,visibleMatches=0,lastThreshold=threshold();
      let recentReviews:SearchListing[]=[],homeReviewed=0;
      let reviewBoundary=scores.size+(preserve?250:1000),previousMatches=matchCount();
      while(true) {
        if (current !== generation) return;
        if(homeRun&&!homeActive())break;
        const inventory=candidates();
        if(inventory!==reviewRows||lastThreshold!==threshold()){
          reviewRows=inventory;position=0;visibleMatches=matchCount(inventory);lastThreshold=threshold();
          if(homeRun)homeReviewed=reviewedCount(inventory);
          rows=homeRun&&$('sort').value==='suggested'
            ? spaceSellers(inventory.filter(item=>!scores.has(keyFor(item))),recentReviews)
            : inventory;
        }
        if(homeRun&&homeReviewed>=homeReviewLimit)break;
        if(visibleMatches>=targetMatches)break;
        while(position<rows.length&&scores.has(keyFor(rows[position])))position++;
        const item=rows[position];
        if(!homeRun&&scores.size>=reviewBoundary){
          if(visibleMatches<=previousMatches){
            paused=!!item||!!fetchMoreCandidates&&!sourceExhausted;
            break;
          }
          previousMatches=visibleMatches;reviewBoundary=scores.size+250;
        }
        if(!item){
          if(homeRun&&!continuation)break;
          if(sourceRequest?.done){
            const completed=sourceRequest;sourceRequest=null;
            if(completed.epoch===sourceEpoch){
              if(completed.error){paused=true;sourceError='Could not fetch more results.';sourceErrorVisible=retrySource;sourceExhausted=false;break;}
              if(completed.more===false)sourceExhausted=true;
              reviewRows=undefined;
            }
            await new Promise<void>(resolve=>setTimeout(resolve,0));
            continue;
          }
          if(!sourceRequest){
            if(!fetchMoreCandidates||sourceExhausted||sourceRequests>=32)break;
            sourceRequests++;requestCandidates();
          }
          waitingCandidates=true;$('ai-progress').textContent='Waiting for listings…';refresh();
          await waitForCandidates(current,sourceRequest);
          if(current!==generation)return;
          continue;
        }
        if(waitingCandidates){waitingCandidates=false;refresh();}
        $('ai-progress').textContent = homeRun?'Choosing listings…':'Searching…';
        if(!attemptedWorker&&uncached>=4&&rows.length-position>=16){
          attemptedWorker=true;
          if(!saveData()&&'startSearchWorker' in selected)extraWorker=selected.startSearchWorker?.()??null;
        }
        const next=rows[position+1];
        const pair=extraWorker?.info&&next&&keyFor(next)!==keyFor(item)&&!scores.has(keyFor(next))
          &&visibleMatches+1<targetMatches&&(homeRun?homeReviewed+1<homeReviewLimit:scores.size+1<reviewBoundary);
        const batch=pair?[item,next]:[item];
        const results=await Promise.all(batch.map(async (listing,index)=>{
          if(index===0)return review(listing,selected);
          try{return await review(listing,extraWorker);}
          catch(error){
            // Auxiliary failure must not lose a candidate. Retry on the main worker.
            if(current!==generation||controller.signal.aborted)throw error;
            extraWorker.dispose();extraWorker=null;
            return review(listing,selected);
          }
        }));
        if(current!==generation)return;
        const before=visibleMatches;
        for(const [index,{score,cached}] of results.entries()){
          if(score&&typeof score==='object'&&score.upperBound>=threshold()){
            reviewRows=undefined;
            continue;
          }
          if(homeRun&&!scores.has(keyFor(batch[index])))homeReviewed++;
          scores.set(keyFor(batch[index]),score);
          if(!cached)uncached++;
          if(typeof score==='number'&&score>=threshold()){visibleMatches++;sourceRequests=0;}
        }
        if(homeRun)recentReviews=recentReviews.concat(batch).slice(-2);
        position+=batch.length;unpainted+=batch.length;
        if(!painted||before===0&&visibleMatches>0||unpainted>=16||performance.now()-lastPaint>=100){
          onChange();painted=true;unpainted=0;lastPaint=performance.now();
          // Cached decisions can otherwise keep resolving in one microtask
          // chain, starving paint, input, Stop and a replacement query.
          await new Promise<void>(resolve=>setTimeout(resolve,0));
        }
      }
    } catch (error) {
      if (current === generation) { paused=true;homeStopped=true;selected.dispose(); $('ai-error').textContent = `${error.message || 'Search failed'}. Show all listings or switch to Text to continue browsing.`; }
    } finally { extraWorker?.dispose();releaseModel();if(runController===controller)runController=null;if (current === generation) { phase='idle';waitingCandidates=false;$('ai-progress').textContent='';refresh();onChange(); } }
  }
  $('search-mode').onclick = () => {
    const active=!enabled();preference=active?'on':'off';writeSetting(AI_MODE_STORAGE_KEY,preference);setEnabled(active);
    if(active)return run();stop({reset:true});
  };
  // Editing waits for Submit; clearing is an immediate cancellation/reset.
  $('search').addEventListener('input',()=>{
    if(!$('search').value.trim()){onSubmit?.('');stop({reset:true,unload:phase!=='idle'});onTextSearch?.('');onChange();}
    else refresh();
  });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
  const activateBrowser=(event:Event)=>{
    if(!event.isTrusted||!globalThis.navigator?.userActivation?.isActive||!enabled()||$('ai-model').value!=='browser'||browserClient.info||preparation||closed)return;
    void prepareModel().catch(error=>{if(!closed&&enabled()){$('ai-error').textContent=error.message||'Could not prepare browser AI.';refresh();}});
  };
  $('search').addEventListener('click',activateBrowser);$('search').addEventListener('keydown',activateBrowser);
  $('search-run').onclick = () => run();
  $('ai-model').onchange = () => {cancelTest();preferredModel=$('ai-model').value;writeSetting(AI_MODEL_STORAGE_KEY,preferredModel);preference=enabled()?'on':'off';writeSetting(AI_MODE_STORAGE_KEY,preference);stop({reset:true});};
  $('ai-threshold').onchange = () => {
    const cutoff=threshold();
    for(const [id,score] of scores)if(score&&typeof score==='object'&&score.upperBound>=cutoff)scores.delete(id);
    cancelTest();refresh();onChange();
  };
  $('ai-stop').onclick = () => stop();
  $('ai-unload').onclick = () => {cancelTest();preference='off';writeSetting(AI_MODE_STORAGE_KEY,preference);setEnabled(false);stop({reset:true});};
  $('ai-show-all').onclick = () => {
    showAll=!showAll;
    if(homeRequested()&&showAll&&phase!=='idle'){stop({unload:false});return;}
    if(!showAll&&homeRequested())homeStopped=false;
    refresh();onChange();
  };
  window.addEventListener('pagehide', () => {cancelTest();testObserver?.disconnect();closed=true;generation++;runController?.abort();runController=null;activeRun=null;sourceEpoch++;prepareGeneration++;wakeCandidates?.();client.dispose();browserClient.dispose();});
  const testSnapshot=()=>JSON.stringify([$('ai-model').value,$('ai-threshold').value,$('ai-test-query').value,$('ai-test-title').value,$('ai-test-description').value]);
  function cancelTest(message=''){
    testEpoch++;testController?.abort();testController=null;
    if(testBusy&&testOwnsLoad){prepareGeneration++;preparation=undefined;testRuntime?.dispose();}
    testOwnsLoad=false;testBusy=false;testProgress=undefined;testRuntime=undefined;
    $('ai-test-progress').hidden=true;$('ai-test-status').textContent=message;refresh();
  }
  async function runTest(){
    if(closed||testBusy)return;
    if(phase!=='idle'){$('ai-test-status').textContent='Stop the current search before testing.';return;}
    cancelTest();testRequested=true;
    const query=$('ai-test-query').value.trim(),title=$('ai-test-title').value.trim(),description=$('ai-test-description').value.trim();
    if(!query){$('ai-test-status').textContent='Enter a search to test.';return;}
    if(!title&&!description){$('ai-test-status').textContent='Enter an example listing title or description.';return;}
    if(query.length>200||title.length>160||description.length>1500){$('ai-test-status').textContent='Shorten the test inputs.';return;}
    if(needsCPU()){$('ai-test-status').textContent='This model needs WebGPU. Choose a supported model.';return;}
    const epoch=++testEpoch,snapshot=testSnapshot(),selected=runtime(),model=$('ai-model').value,cutoff=threshold(),started=performance.now();
    const controller=new AbortController();testController=controller;testRuntime=selected;testBusy=true;testOwnsLoad=!selected.info&&!preparation;
    const release='pin' in selected&&typeof selected.pin==='function'?selected.pin():()=>{};
    const current=()=>!closed&&testBusy&&epoch===testEpoch&&!controller.signal.aborted&&snapshot===testSnapshot();
    testProgress=(message,details)=>{if(!current())return;$('ai-test-status').textContent=message;const progress=$('ai-test-progress');progress.hidden=false;if(details&&Number.isFinite(details.total)&&details.total>0)progress.value=Math.max(0,Math.min(1,details.loaded/details.total));else progress.removeAttribute('value');};
    $('ai-test-status').textContent=selected.info?'Testing example…':'Loading model…';refresh();
    try{
      // Starts synchronously from the button, retaining browser download activation.
      if(!selected.info)await prepareModel();
      if(!current())return;
      if(!selected.info||selected.info.model!==model)throw Error('The selected model is not ready.');
      testOwnsLoad=false;$('ai-test-progress').hidden=true;$('ai-test-status').textContent='Testing example…';
      const searchHead='selectSearchHead' in selected&&!!(await selected.selectSearchHead?.(query,controller.signal));
      if(!current())return;
      const {score,cached}=await scoreSearchListing({title,description,side:'offer'},query,model,
        (condition,text)=>selected.classify(condition,text,{signal:controller.signal,searchHead}),controller.signal);
      if(!current())return;
      const label=model==='browser'?'Browser model':model==='deberta'?'DeBERTa':model==='qwen35'?'Qwen 3.5':selected.info.model;
      $('ai-test-status').textContent=`${score>=cutoff?'Match':'No match'} · ${label} · ${Math.round(performance.now()-started)} ms${cached?' · cached':''}`;
    }catch(error){if(current())$('ai-test-status').textContent=error instanceof Error?error.message:'Could not test this model.';}
    finally{release();if(epoch===testEpoch){testBusy=false;testController=null;testProgress=undefined;testOwnsLoad=false;testRuntime=undefined;$('ai-test-progress').hidden=true;refresh();}}
  }
  $('ai-test-run').onclick=()=>runTest();$('ai-test-cancel').onclick=()=>cancelTest('Test cancelled.');
  for(const id of ['ai-test-query','ai-test-title','ai-test-description'] as const)$(id).addEventListener('input',()=>cancelTest());
  $('ai-settings').addEventListener('toggle',()=>{if(!$('ai-settings').open)cancelTest();});
  const testObserver=typeof MutationObserver==='function'?new MutationObserver(()=>{if($('preferences-dialog').hidden)cancelTest();}):undefined;
  testObserver?.observe($('preferences-dialog'),{attributes:true,attributeFilter:['hidden']});
  const ready=Promise.resolve().then(async()=>{
    const available=await browserClient.probe();if(closed)return;
    browserAvailable=available==='available';
    if(available!=='unavailable'||preferredModel==='browser'||browserOption){
      const option=browserOption??element('option');option.textContent=available==='unavailable'?'Browser model · unavailable':'Browser model · on device';option.value='browser';if(!browserOption){$('ai-model').append(option);browserOption=option;}$('ai-model').closest?.('label')?.removeAttribute('hidden');
      if(preferredModel==='browser')$('ai-model').value='browser';
      if(preferredModel==='browser'&&available==='unavailable')$('ai-error').textContent='Browser AI is unavailable here. Reload to retry or choose DeBERTa.';
    }
    if(!autoPrepare||testRequested||preference==='off'||phase!=='idle'||preferredModel==='browser'&&available==='unavailable')return;
    if(!runtime().info&&(saveData()||$('ai-model').value==='browser'&&available!=='available'))return;
    try{await prepareModel();if(!closed&&!testRequested&&preference!=='off'&&!textSubmitted){preference='on';writeSetting(AI_MODE_STORAGE_KEY,preference);setEnabled(true);refresh();onChange();}}
    catch{/* Background preparation is optional. Explicit Search can retry without blocking Browse. */}
  });
  const pagination=(moreHomeInventory=false)=>{const rows=candidates(),remaining=rows.filter(listing=>!scores.has(keyFor(listing))).length;return{hasMore:enabled()&&curationActive()&&!showAll&&(remaining>0||(!homeActive()||moreHomeInventory)&&!!fetchMoreCandidates&&!sourceExhausted),loading:phase!=='idle',paused,error:sourceErrorVisible?sourceError:$('ai-error').textContent,remaining,reviewed:homeActive()?reviewedCount(rows):scores.size,matches:matchCount(),target:targetMatches};};
  const scoreFor=(listing:SearchListing):number|undefined=>{
    if(!enabled()||showAll||!curationActive()||$('ai-error').textContent)return undefined;
    const score=scores.get(keyFor(listing));return Number.isFinite(score)?score:undefined;
  };
  const planTags=(query:string,tags:readonly string[],signal?:AbortSignal)=>{const epoch=generation;return planBrowserTags(query,tags,{info:enabled()&&$('ai-model').value==='browser'?browserClient.info:null,signal,isCurrent:()=>!closed&&generation===epoch&&enabled()&&$('ai-model').value==='browser'&&submittedQuery===query});};
  function viewChanged(){const visible=isHomeVisible();if(!visible&&homeContext&&!homeStopped){stop({unload:false,finishCurrent:true});paused=false;}if(visible&&!homeWasVisible)homeStopped=false;homeWasVisible=visible;refresh();}
  document.addEventListener?.('visibilitychange',viewChanged);
  return { ready,planTags,topicPlanning:()=>$('ai-model').value==='deberta',canPlanTags:()=>runtime()===browserClient&&!!browserClient.info,enabled,homeActive,showingAll:()=>showAll,viewChanged,submit:(query:string)=>{$('search').value=query;return run();},homeFeed:()=>({...home}),setHomeFeed:(value:HomeFeedPreferences)=>{home=homeFeedPreferences(value);if(submittedQuery){refresh();onChange();}else stop({reset:true,unload:false});},query:()=>submittedQuery, searching:()=>phase!=='idle',loadMore:()=>run({continuation:true,homeRun:homeActive()}), pagination, scoreFor, isVisible: listing => !enabled() || showAll || !curationActive() || matches(listing), refresh, stop: () => stop({reset:true}) };
}
