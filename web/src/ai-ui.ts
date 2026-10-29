import { byId, element } from './dom.ts';
import { FeedFilterClient } from './feed-filter/client.ts';
import {BrowserFeedFilterClient} from './feed-filter/browser-client.ts';
import {planBrowserTags} from './feed-filter/browser-tags.ts';
import { searchCondition, listingSearchTexts } from './search-condition.ts';
const $=byId;
const keyFor = listing => listing.eventId || listing.id;
export const AI_MODE_STORAGE_KEY='market-ai-mode-v1',AI_MODEL_STORAGE_KEY='market-ai-model-v1';
interface SearchListing {id:string;eventId?:string;title:string;description?:string;side?:string;category?:string;location?:string;tags?:string[];price?:string|number;currency?:string}
interface AIOptions {getCandidates:()=>SearchListing[];onChange:()=>void;onTextSearch?:(query:string)=>void;fetchMoreCandidates?:()=>Promise<boolean>;client?:Pick<FeedFilterClient,'info'|'load'|'classify'|'dispose'>&{pin?:()=>()=>void};browserClient?:BrowserFeedFilterClient;hasWebGPU?:()=>boolean;autoPrepare?:boolean;storage?:Pick<Storage,'getItem'|'setItem'>;saveData?:()=>boolean}
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
    $('ai-summary-text').textContent = showAll ? 'Showing all listings' : phase==='loading' ? $('ai-progress').textContent : busy ? `Searching…${matches?` · ${matchLabel}`:''}` : `${paused&&!sourceError?'Search paused · ':''}${matchLabel}`;
    $('ai-show-all').textContent = showAll ? 'Use AI matches' : 'Show all';
    $('ai-show-all').hidden = !submittedQuery||(!hidden&&!showAll&&!$('ai-error').textContent);
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
    progress.hidden=phase!=='loading';
    if(active&&!busy&&!$('ai-error').textContent){
      $('ai-progress').textContent = needsCPU() ? 'Qwen is unavailable in this browser. Use the smaller CPU model.' : submittedQuery&&!candidates.length&&!sourceError ? 'Refresh listings or clear filters to search.' : '';
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
  function stop({reset=false,unload=true}={}) {
    sourceError=null;sourceErrorVisible=false;
    generation++;runController?.abort();runController=null;activeRun=null;sourceEpoch++;wakeCandidates?.();if(unload){prepareGeneration++;preparation=undefined;downloadFraction=undefined;client.dispose();browserClient.dispose();}phase='idle';paused=!reset;progress.hidden=true;$('ai-progress').textContent='';
    if(reset){scores.clear();submittedQuery='';showAll=false;sourceExhausted=false;targetMatches=24;$('ai-error').textContent='';}
    refresh();onChange();
  }
  function run({continuation=false}={}):Promise<void> {
    if(testBusy)return Promise.resolve();
    const query=continuation?submittedQuery:$('search').value.trim();
    // Repeated Submit must not restart a running pass or queue the same work.
    // A loading pass already adopts the latest input once preparation finishes.
    if(enabled()&&activeRun&&(phase==='loading'||activeRun.query===query))return activeRun.promise;
    const promise=executeRun({continuation});
    const active={query,promise};activeRun=active;
    void promise.finally(()=>{if(activeRun===active)activeRun=null;}).catch(()=>{});
    return promise;
  }
  async function executeRun({continuation=false}={}) {
    if (!enabled()) { textSubmitted=true;onTextSearch?.($('search').value.trim()); onChange(); return; }
    if(phase==='loading'||continuation&&phase!=='idle')return;
    if(continuation&&!submittedQuery)return;
    if(needsCPU()){$('ai-model').value='deberta';stop();return;}
    const current = ++generation;
    runController?.abort();
    const controller=new AbortController();runController=controller;
    const selected=runtime();
    const releaseModel='pin' in selected&&typeof selected.pin==='function'?selected.pin():()=>{};
    wakeCandidates?.();
    const sameQuery=!!submittedQuery&&$('search').value.trim()===submittedQuery;
    const preserve=continuation||sameQuery,retrySource=preserve&&!!sourceError;
    sourceError=null;sourceErrorVisible=false;
    paused=false;
    if(!preserve){sourceEpoch++;submittedQuery=$('search').value.trim();scores.clear();showAll=false;sourceExhausted=false;targetMatches=24;}
    else if(!retrySource)targetMatches=matchCount()+24;
    $('ai-error').textContent='';
    phase=selected.info?'searching':'loading';onChange();
    if(selected.info&&!submittedQuery){phase='idle';refresh();releaseModel();if(runController===controller)runController=null;return;}
    try {
      if (!selected.info) {
        phase='loading';progress.removeAttribute('value');$('ai-progress').textContent='Loading model…';refresh();
        await prepareModel();
      }
      if (current !== generation) return;
      // Use the latest query, including edits made while the model was downloading.
      const query=continuation?submittedQuery:$('search').value.trim();
      if(activeRun)activeRun.query=query;
      if(query!==submittedQuery){sourceEpoch++;submittedQuery=query;scores.clear();onChange();}
      if(!query||!enabled())return;
      const condition=searchCondition(query,$('ai-model').value);let sourceRequests=0,unpainted=0,painted=false,lastPaint=performance.now();
      phase='searching';refresh();
      while(matchCount()<targetMatches) {
        if (current !== generation) return;
        const item=candidates().find(listing=>!scores.has(keyFor(listing)));
        if(!item){
          if(sourceRequest?.done){
            const completed=sourceRequest;sourceRequest=null;
            if(completed.epoch===sourceEpoch){
              if(completed.error){paused=true;sourceError='Could not fetch more results.';sourceErrorVisible=retrySource;sourceExhausted=false;break;}
              if(completed.more===false)sourceExhausted=true;
            }
            await new Promise<void>(resolve=>setTimeout(resolve,0));
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
        $('ai-progress').textContent = 'Searching…';
        let score=0;
        for(const text of listingSearchTexts(item,query,$('ai-model').value)){
          const result=await selected.classify(condition,text,{eventId:item.eventId,signal:controller.signal});
          if(current!==generation)return;
          if(!Number.isFinite(result.score))throw new Error('The model returned an invalid decision');
          score=Math.max(score,result.score);
          if(score>=threshold())break;
        }
        scores.set(keyFor(item),score);unpainted++;
        if(!painted||unpainted>=16||performance.now()-lastPaint>=12){
          onChange();painted=true;unpainted=0;lastPaint=performance.now();
          // Cached decisions can otherwise keep resolving in one microtask
          // chain, starving paint, input, Stop and a replacement query.
          await new Promise<void>(resolve=>setTimeout(resolve,0));
        }
      }
    } catch (error) {
      if (current === generation) { paused=true;selected.dispose(); $('ai-error').textContent = `${error.message || 'Search failed'}. Show all listings or switch to Text to continue browsing.`; }
    } finally { releaseModel();if(runController===controller)runController=null;if (current === generation) { phase='idle';$('ai-progress').textContent='';refresh();onChange(); } }
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
  $('ai-model').onchange = () => {cancelTest();preferredModel=$('ai-model').value;writeSetting(AI_MODEL_STORAGE_KEY,preferredModel);preference=enabled()?'on':'off';writeSetting(AI_MODE_STORAGE_KEY,preference);stop({reset:true});};
  $('ai-threshold').onchange = () => {cancelTest(); refresh(); onChange(); };
  $('ai-stop').onclick = () => stop();
  $('ai-unload').onclick = () => {cancelTest();preference='off';writeSetting(AI_MODE_STORAGE_KEY,preference);setEnabled(false);stop({reset:true});};
  $('ai-show-all').onclick = () => { showAll = !showAll; refresh(); onChange(); };
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
      let score=0,cached=true;
      for(const text of listingSearchTexts({title,description,side:'offer'},query,model)){
        const result=await selected.classify(searchCondition(query,model),text,{signal:controller.signal});
        if(!current())return;
        if(!Number.isFinite(result.score)||result.score<0||result.score>1)throw Error('The model returned an invalid decision.');
        cached&&=!!result.cached;score=Math.max(score,result.score);if(score>=cutoff)break;
      }
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
  const pagination=()=>{const rows=candidates(),remaining=rows.filter(listing=>!scores.has(keyFor(listing))).length;return{hasMore:enabled()&&!!submittedQuery&&!showAll&&(remaining>0||!!fetchMoreCandidates&&!sourceExhausted),loading:phase!=='idle',paused,error:sourceErrorVisible?sourceError:$('ai-error').textContent,remaining,reviewed:rows.length-remaining,matches:matchCount(),target:targetMatches};};
  const scoreFor=(listing:SearchListing):number|undefined=>{
    if(!enabled()||showAll||!submittedQuery||$('ai-error').textContent)return undefined;
    const score=scores.get(keyFor(listing));return Number.isFinite(score)?score:undefined;
  };
  const planTags=(query:string,tags:readonly string[],signal?:AbortSignal)=>{const epoch=generation;return planBrowserTags(query,tags,{info:enabled()&&$('ai-model').value==='browser'?browserClient.info:null,signal,isCurrent:()=>!closed&&generation===epoch&&enabled()&&$('ai-model').value==='browser'&&submittedQuery===query});};
  return { ready,planTags,enabled, query:()=>submittedQuery, searching:()=>phase!=='idle', loadMore:()=>run({continuation:true}), pagination, scoreFor, isVisible: listing => !enabled() || showAll || !submittedQuery || scores.has(keyFor(listing))&&scores.get(keyFor(listing))>=threshold(), refresh, stop: () => stop({reset:true}) };
}
