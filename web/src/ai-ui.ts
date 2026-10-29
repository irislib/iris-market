import { byId, element } from './dom.ts';
import { FeedFilterClient, FEED_MODELS } from './feed-filter/client.ts';
import { searchCondition, listingSearchTexts } from './search-condition.ts';
const $=byId;
const keyFor = listing => listing.eventId || listing.id;
interface SearchListing {id:string;eventId?:string;title:string;description?:string;side?:string;category?:string;location?:string;tags?:string[];price?:string|number;currency?:string}
interface AIOptions {getCandidates:()=>SearchListing[];onChange:()=>void;onTextSearch?:(query:string)=>void;fetchMoreCandidates?:()=>Promise<boolean>;client?:Pick<FeedFilterClient,'info'|'load'|'classify'|'dispose'>;hasWebGPU?:()=>boolean}
interface SourceRequest {epoch:number;done:boolean;more?:boolean;error?:unknown}
export function setupAI({ getCandidates, onChange, onTextSearch, fetchMoreCandidates, client = new FeedFilterClient(), hasWebGPU=()=>!!globalThis.navigator&&'gpu' in globalThis.navigator }:AIOptions) {
  let scores = new Map(), showAll = false, phase:'idle'|'loading'|'searching'='idle', generation = 0, submittedQuery='', paused=false;
  let targetMatches=24,sourceExhausted=false;
  let sourceEpoch=0,sourceRequest:SourceRequest|null=null,wakeCandidates:(()=>void)|null=null;
  const progress=element('progress');progress.id='ai-download-progress';progress.max=1;progress.hidden=true;progress.setAttribute('aria-label','Model download');
  $('ai-options').append(progress);
  const enabled = () => $('search-mode').value === 'ai';
  const threshold = () => $('ai-model').value === 'qwen35' ? .5 : Number($('ai-threshold').value);
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
    $('ai-threshold').disabled = $('ai-model').value === 'qwen35';
    const query=$('search').value.trim(),download=FEED_MODELS[$('ai-model').value]?.downloadMB;
    $('search-run').disabled = phase==='loading';
    $('search-run').textContent = !active ? 'Search' : phase==='loading' ? 'Loading model…' : needsCPU() ? 'Use CPU model' : !client.info ? `${query?'Load & search':'Load model'} · ${download} MB` : 'Search with AI';
    progress.hidden=phase!=='loading';
    if(active&&!busy&&!$('ai-error').textContent){
      $('ai-progress').textContent = needsCPU() ? 'Qwen is unavailable in this browser. Use the smaller CPU model.' : submittedQuery&&!candidates.length ? 'Refresh listings or clear filters to search.' : '';
    }
    $('ai-progress').hidden=busy||!$('ai-progress').textContent;
    if(active)$('search').setAttribute('aria-describedby','ai-progress');else $('search').removeAttribute('aria-describedby');
    $('search').placeholder = active ? 'Describe what you’re looking for' : 'Search listings';
    wakeCandidates?.();
  };
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
    generation++;sourceEpoch++;wakeCandidates?.();if(unload)client.dispose();phase='idle';paused=!reset;progress.hidden=true;$('ai-progress').textContent='';
    if(reset){scores.clear();submittedQuery='';showAll=false;sourceExhausted=false;targetMatches=24;$('ai-error').textContent='';}
    refresh();onChange();
  }
  async function run({continuation=false}={}) {
    if (!enabled()) { onTextSearch?.($('search').value.trim()); onChange(); return; }
    if(phase==='loading'||continuation&&phase!=='idle')return;
    if(continuation&&!submittedQuery)return;
    if(needsCPU()){$('ai-model').value='deberta';stop();return;}
    const current = ++generation;
    wakeCandidates?.();
    paused=false;
    if(!continuation){sourceEpoch++;submittedQuery=$('search').value.trim();scores.clear();showAll=false;sourceExhausted=false;targetMatches=24;}
    else targetMatches=matchCount()+24;
    $('ai-error').textContent='';
    phase=client.info?'searching':'loading';onChange();
    if(client.info&&!submittedQuery){phase='idle';refresh();return;}
    try {
      if (!client.info) {
        phase='loading';progress.removeAttribute('value');$('ai-progress').textContent='Loading model…';refresh();
        const model = $('ai-model').value;
        await client.load(model, model === 'deberta' ? 'wasm' : 'webgpu', (message,details) => {
          if (current === generation) {
            $('ai-progress').textContent = message;
            if(details&&Number.isFinite(details.total)&&details.total>0)progress.value=Math.min(1,details.loaded/details.total);else progress.removeAttribute('value');
            refresh();
          }
        });
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
          const result=await client.classify(condition,text);
          if(current!==generation)return;
          if(!Number.isFinite(result.score))throw new Error('The model returned an invalid decision');
          score=Math.max(score,result.score);
          if(score>=threshold())break;
        }
        scores.set(keyFor(item),score);onChange();
      }
    } catch (error) {
      if (current === generation) { paused=true;client.dispose(); $('ai-error').textContent = `${error.message || 'Search failed'}. Show all listings or switch to Text to continue browsing.`; }
    } finally { if (current === generation) { phase='idle';$('ai-progress').textContent='';refresh();onChange(); } }
  }
  $('search-mode').onclick = () => {
    const active=!enabled();$('search-mode').value=active?'ai':'text';$('search-mode').setAttribute('aria-pressed',String(active));
    if(active)return run();stop({reset:true});
  };
  // Editing waits for Submit; clearing is an immediate cancellation/reset.
  $('search').addEventListener('input',()=>{
    if(!$('search').value.trim()){stop({reset:true,unload:phase!=='idle'});onTextSearch?.('');onChange();}
    else refresh();
  });
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
  $('search-run').onclick = () => run();
  $('ai-model').onchange = () => stop();
  $('ai-threshold').onchange = () => { refresh(); onChange(); };
  $('ai-stop').onclick = () => stop();
  $('ai-unload').onclick = () => stop();
  $('ai-show-all').onclick = () => { showAll = !showAll; refresh(); onChange(); };
  window.addEventListener('pagehide', () => { generation++;sourceEpoch++;wakeCandidates?.();client.dispose(); });
  const pagination=()=>{const rows=candidates(),remaining=rows.filter(listing=>!scores.has(keyFor(listing))).length;return{hasMore:enabled()&&!!submittedQuery&&!showAll&&(remaining>0||!!fetchMoreCandidates&&!sourceExhausted),loading:phase!=='idle',paused,error:$('ai-error').textContent,remaining,reviewed:rows.length-remaining,matches:matchCount(),target:targetMatches};};
  return { enabled, query:()=>submittedQuery, searching:()=>phase!=='idle', loadMore:()=>run({continuation:true}), pagination, isVisible: listing => !enabled() || showAll || !submittedQuery || scores.has(keyFor(listing))&&scores.get(keyFor(listing))>=threshold(), refresh, stop: () => stop({reset:true}) };
}
