import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAI,AI_MODE_STORAGE_KEY,AI_MODEL_STORAGE_KEY} from '../src/ai-ui.ts';
import {BrowserFeedFilterClient} from '../src/feed-filter/browser-client.ts';

class Element extends EventTarget {
  constructor(value=''){super();this.value=value;this.textContent='';this.hidden=false;this.disabled=false;this.attributes=new Map();this.children=[];this.styles=new Map();this.style={setProperty:(key,value)=>this.styles.set(key,value)};this.handlers=new Map();}
  addEventListener(name,listener,options){const list=this.handlers.get(name)||[];list.push(listener);this.handlers.set(name,list);super.addEventListener(name,listener,options);}
  append(...children){this.children.push(...children);}
  setAttribute(name,value){this.attributes.set(name,value);}
  removeAttribute(name){this.attributes.delete(name);}
  focus(){this.focused=true;}
}
const bicycle={id:'bicycle',title:'Bicycle',description:'City bicycle',side:'offer',category:'transport'};
function fixture({rows=[bicycle],query='',gpu=true,client:provided,fetchMoreCandidates,onTextSearch,autoPrepare=false,mode='ai',storage,saveData,browserClient}={}){
  const elements=new Map(),calls=[];
  const field=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  globalThis.document={querySelector:selector=>field(selector.slice(1)),createElement:()=>new Element()};globalThis.window=new EventTarget();
  field('search-mode').value=mode;field('search').value=query;field('ai-model').value='deberta';field('ai-threshold').value='0.5';
  const client=provided??{info:null,async load(model,device,progress){calls.push(['load',model,device]);progress('Downloading model…');this.info={model,device};return this.info;},async classify(condition,text){calls.push(['classify',condition,text]);return{score:.8};},dispose(){calls.push(['dispose']);this.info=null;}};
  const ui=setupAI({getCandidates:()=>rows,onChange:()=>ui.refresh(),client,hasWebGPU:()=>gpu,fetchMoreCandidates,onTextSearch,autoPrepare,storage,saveData,browserClient});ui.refresh();
  return{ui,client,calls,field,setRows(value){rows=value;ui.refresh();}};
}

test('empty AI search explicitly loads the model without classifying any listing',async()=>{
  const {field,calls}=fixture();
  assert.equal(field('search-run').textContent,'Load model · 87 MB');assert.equal(field('search-run').disabled,false);
  assert.equal(field('search').attributes.get('aria-describedby'),'ai-progress');
  await field('search-run').onclick();assert.deepEqual(calls,[['load','deberta','wasm']]);
  assert.equal(field('search-run').textContent,'Search with AI');assert.doesNotMatch(field('ai-progress').textContent,/ready/i);
  await field('search-run').onclick();assert.equal(calls.length,1);
});

test('typing a query enables explicit download and reviews the existing candidates',async()=>{
  const {field,calls,ui}=fixture();field('search').value='bicycle';field('search').dispatchEvent(new Event('input'));
  assert.equal(field('search-run').disabled,false);assert.equal(field('search-run').textContent,'Load & search · 87 MB');
  await field('search-run').onclick();assert.deepEqual(calls[0],['load','deberta','wasm']);assert.equal(calls[1][0],'classify');assert.match(calls[1][1],/bicycle/);
  assert.equal(field('search-run').textContent,'Search with AI');assert.equal(field('search-run').disabled,false);assert.equal(ui.isVisible(bicycle),true);
});

test('no candidates allows explicit preload, then becomes searchable when listings arrive',async()=>{
  const {field,calls,setRows}=fixture({rows:[],query:'bicycle'});
  assert.equal(field('search-run').disabled,false);assert.equal(field('search-run').textContent,'Load & search · 87 MB');assert.equal(field('ai-progress').textContent,'');
  await field('search-run').onclick();assert.equal(calls.filter(call=>call[0]==='classify').length,0);
  assert.equal(field('search-run').disabled,false);assert.doesNotMatch(field('ai-progress').textContent,/ready/i);
  setRows([bicycle]);assert.equal(field('search-run').disabled,false);assert.equal(field('search-run').textContent,'Search with AI');
  await field('search-run').onclick();assert.equal(calls.filter(call=>call[0]==='load').length,1);assert.equal(calls.filter(call=>call[0]==='classify').length,1);
});

test('unsupported WebGPU offers an explicit CPU model choice before downloading',async()=>{
  const {field,calls,ui}=fixture({query:'bicycle',gpu:false});field('ai-model').value='qwen35';ui.refresh();
  assert.equal(field('search-run').textContent,'Use CPU model');assert.match(field('ai-progress').textContent,/unavailable in this browser/);
  await field('search-run').onclick();assert.equal(field('ai-model').value,'deberta');assert.equal(calls.some(call=>call[0]==='load'),false);
  assert.equal(field('search-run').textContent,'Load & search · 87 MB');
});

test('mode changes refresh candidates and text search never loads a model',async()=>{
  const {field,calls,setRows,ui}=fixture({rows:[],query:'bicycle'});field('search-mode').onclick();
  assert.equal(field('search-run').textContent,'Search');assert.equal(field('search-run').disabled,false);assert.equal(field('ai-options').hidden,true);
  await field('search-run').onclick();assert.equal(calls.some(call=>call[0]==='load'),false);
  setRows([bicycle]);await field('search-mode').onclick();ui.refresh();assert.equal(field('search-run').disabled,false);assert.equal(calls.some(call=>call[0]==='load'),true);
});

test('typing preserves submitted results without starting classification',async()=>{
  const {field,ui,calls}=fixture({query:'bicycle'});await field('search-run').onclick();
  const count=calls.length;assert.equal(ui.query(),'bicycle');assert.equal(ui.isVisible(bicycle),true);
  field('search').value='chair';field('search').dispatchEvent(new Event('input'));
  assert.equal(ui.query(),'bicycle');assert.equal(ui.isVisible(bicycle),true);assert.equal(calls.length,count);
});

test('clearing a submitted query immediately resets matches and the summary',async()=>{
  const text=[];const {field,ui,client}=fixture({query:'bicycle',onTextSearch:value=>text.push(value)});
  await field('search-run').onclick();assert.equal(field('ai-summary').hidden,false);
  field('search').value='';field('search').dispatchEvent(new Event('input'));
  assert.equal(ui.query(),'');assert.equal(field('ai-summary').hidden,true);assert.equal(ui.pagination().hasMore,false);assert.equal(ui.isVisible({id:'unreviewed'}),true);assert.deepEqual(text,['']);assert(client.info);
});

test('clearing while classification is pending rejects its late result',async()=>{
  let finish;const client={info:{model:'deberta'},async load(){},classify:()=>new Promise(resolve=>finish=resolve),dispose(){this.info=null;}};
  const {field,ui}=fixture({query:'a bicycle',client});const run=field('search-run').onclick();
  for(let i=0;i<8&&!finish;i++)await Promise.resolve();assert(finish);
  field('search').value='';field('search').dispatchEvent(new Event('input'));finish({score:0});await run;
  assert.equal(ui.query(),'');assert.equal(ui.searching(),false);assert.equal(field('ai-summary').hidden,true);assert.equal(ui.isVisible(bicycle),true);
});

test('model failures keep unknowns hidden and offer explicit Show all',async()=>{
  const client={info:null,load:async()=>{throw Error('Download unavailable');},classify:async()=>({score:0}),dispose(){this.info=null;}};
  const {field,ui}=fixture({query:'bicycle',client});await field('search-run').onclick();
  assert.match(field('ai-error').textContent,/Download unavailable/);assert.match(field('ai-error').textContent,/Show all listings/);
  assert.equal(ui.pagination().paused,true);
  assert.equal(field('search-run').disabled,false);assert.equal(ui.isVisible(bicycle),false);assert.equal(field('ai-show-all').hidden,false);
  field('ai-show-all').onclick();assert.equal(ui.isVisible(bicycle),true);
});

test('typing during preload preserves download and searches latest text after completion',async()=>{
  let complete,report,disposed=0;const conditions=[];
  const client={info:null,load(_model,_device,progress){report=progress;return new Promise(resolve=>complete=()=>{this.info={model:'deberta'};resolve(this.info);});},async classify(condition){conditions.push(condition);return{score:.8};},dispose(){disposed++;this.info=null;}};
  const {field,ui}=fixture({client});const run=field('search-run').onclick();
  const progress=field('ai-options').children.find(node=>node.id==='ai-download-progress');assert.equal(progress.hidden,false);
  report('Downloading DeBERTa · 4 / 8 MB · 50%',{loaded:4000000,total:8000000});assert.equal(progress.value,.5);
  field('search').value='chair';field('search').dispatchEvent(new Event('input'));field('search').value='bicycle';field('search').dispatchEvent(new Event('input'));
  assert.equal(disposed,0);assert.equal(ui.query(),'');complete();await run;
  assert.equal(conditions.length,1);assert.match(conditions[0],/bicycle/);assert.doesNotMatch(conditions[0],/chair/);assert.equal(ui.query(),'bicycle');assert.equal(progress.hidden,true);assert.doesNotMatch(field('ai-progress').textContent,/ready/i);
});

test('explicit Stop cancels an empty-query download without a false error',async()=>{
  let rejectLoad,disposed=0;
  const client={info:null,load:()=>new Promise((_,reject)=>rejectLoad=reject),classify:async()=>{throw Error('Must not classify');},dispose(){disposed++;rejectLoad(Error('Stopped'));}};
  const {field,ui}=fixture({client});const run=field('search-run').onclick();assert.equal(field('ai-stop').hidden,false);
  field('ai-stop').onclick();await run;assert.equal(disposed,1);assert.equal(ui.searching(),false);assert.equal(field('search-run').disabled,false);assert.equal(field('ai-error').textContent,'');assert.equal(field('ai-options').children[0].hidden,true);
});


test('submission hides unknowns and infinite-scroll pages collect 24 matches each',async()=>{
  const rows=Array.from({length:53},(_,i)=>({...bicycle,id:`listing-${i}`}));let resolve,started,classified=0;
  const pending=new Promise(done=>started=done);
  const client={info:{model:'deberta'},load:async()=>{},async classify(){classified++;if(classified===1){started();return new Promise(done=>resolve=done);}return{score:.8};},dispose(){this.info=null;}};
  const {field,ui}=fixture({rows,query:'bicycle',client});assert.equal(ui.isVisible(rows[0]),true);
  const run=field('search-run').onclick();await pending;assert.equal(ui.query(),'bicycle');assert.equal(ui.isVisible(rows[0]),false);assert.equal(ui.isVisible(rows[52]),false);
  assert.equal(ui.pagination().loading,true);resolve({score:.8});await run;
  assert.equal(classified,24);assert.equal(ui.pagination().remaining,29);assert.equal(ui.pagination().hasMore,true);assert.equal(ui.isVisible(rows[0]),true);assert.equal(ui.isVisible(rows[1]),true);
  field('search').value='unsubmitted draft';field('search').dispatchEvent(new Event('input'));await ui.loadMore();
  assert.equal(classified,48);assert.equal(ui.query(),'bicycle');assert.equal(ui.pagination().remaining,5);assert.equal(ui.isVisible(rows[0]),true);
  await ui.loadMore();assert.equal(classified,53);assert.equal(ui.pagination().hasMore,false);assert.equal(ui.pagination().reviewed,53);assert.equal(ui.isVisible(rows[52]),true);
  assert.equal(field('search-run').textContent,'Search with AI');assert.doesNotMatch(field('ai-summary-text').textContent,/next 12/);
});

test('sparse matches scan beyond 24 candidates until each matching window is filled',async()=>{
  const rows=Array.from({length:150},(_,i)=>({...bicycle,id:`sparse-${i}`}));let classified=0;
  const client={info:{model:'deberta'},load:async()=>{},classify:async()=>({score:++classified%3===0?.9:.05}),dispose(){this.info=null;}};
  const {field,ui}=fixture({rows,query:'a bicycle',client});await field('search-run').onclick();
  assert.equal(classified,72);assert.equal(rows.filter(ui.isVisible).length,24);assert.equal(ui.pagination().matches,24);assert.equal(ui.pagination().target,24);
  await ui.loadMore();assert.equal(classified,144);assert.equal(rows.filter(ui.isVisible).length,48);assert.equal(ui.pagination().target,48);
  await ui.loadMore();assert.equal(classified,150);assert.equal(ui.pagination().matches,50);assert.equal(ui.pagination().hasMore,false);
});

test('match collection fetches older candidates and stops once filled or source exhausted',async()=>{
  const initial=Array.from({length:10},(_,i)=>({...bicycle,id:`initial-${i}`})),older=Array.from({length:24},(_,i)=>({...bicycle,id:`older-${i}`}));let classified=0,fetches=0,harness;
  const client={info:{model:'deberta'},load:async()=>{},classify:async()=>({score:++classified<=10?.1:.9}),dispose(){this.info=null;}};
  harness=fixture({rows:initial,query:'a bicycle',client,fetchMoreCandidates:async()=>{fetches++;if(fetches===1){harness.setRows([...initial,...older]);return true;}return false;}});
  await harness.field('search-run').onclick();assert.equal(classified,34);assert.equal(fetches,1);assert.equal(harness.ui.pagination().matches,24);
  await harness.ui.loadMore();assert.equal(fetches,2);assert.equal(classified,34);assert.equal(harness.ui.pagination().hasMore,false);
  await harness.ui.loadMore();assert.equal(fetches,2);
});

test('older inventory failure pauses without automatic retry or revealing unknown listings',async()=>{
  let fetches=0;const client={info:{model:'deberta'},load:async()=>{},classify:async()=>({score:.1}),dispose(){this.info=null;}};
  const {field,ui}=fixture({query:'bicycle',client,fetchMoreCandidates:async()=>{fetches++;throw Error('Listings unavailable');}});
  await field('search-run').onclick();assert.equal(fetches,1);assert.equal(ui.pagination().paused,true);assert.match(ui.pagination().error,/Listings unavailable/);assert.equal(ui.isVisible(bicycle),false);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
async function until(check){for(let i=0;i<40&&!check();i++)await Promise.resolve();assert(check(),'expected asynchronous progress');}

test('new candidates stream into classification before their source page finishes',async()=>{
  const source=deferred(),texts=[];let fetches=0;
  const client={info:{model:'deberta'},load:async()=>{},async classify(_condition,text){texts.push(text);return{score:.9};},dispose(){this.info=null;}};
  const {field,ui,setRows}=fixture({rows:[],query:'bicycle',client,fetchMoreCandidates:()=>{fetches++;return source.promise;}});
  const run=field('search-run').onclick();await until(()=>fetches===1);
  assert.equal(field('ai-summary-text').textContent,'Searching…');
  setRows([bicycle]);await until(()=>ui.isVisible(bicycle));
  assert.equal(ui.searching(),true);assert.equal(field('ai-summary-text').textContent,'Searching… · 1 match');
  const second={...bicycle,id:'second'};setRows([bicycle,second]);await until(()=>ui.isVisible(second));
  assert.equal(field('ai-summary-text').textContent,'Searching… · 2 matches');
  assert.equal(fetches,1,'incoming candidates do not start parallel pagination');
  source.resolve(false);await run;
  assert.equal(texts.length,2);assert.equal(ui.pagination().hasMore,false);
  assert.equal(field('ai-summary-text').textContent,'2 matches');
});

test('Stop settles a source wait immediately and its late failure cannot change a new query',async()=>{
  const source=deferred(),texts=[];let fetches=0;
  const client={info:{model:'deberta'},async load(){this.info={model:'deberta'};},async classify(condition){texts.push(condition);return{score:.9};},dispose(){this.info=null;}};
  const {field,ui,setRows}=fixture({rows:[],query:'bicycle',client,fetchMoreCandidates:()=>++fetches===1?source.promise:Promise.resolve(false)});
  let stopped=false;const old=field('search-run').onclick().then(()=>{stopped=true;});await until(()=>fetches===1);
  field('ai-stop').onclick();await until(()=>stopped);
  assert.equal(field('ai-summary-text').textContent,'Search paused · 0 matches');
  field('search').value='chair';const next=field('search-run').onclick();
  setRows([{...bicycle,id:'chair',title:'Chair'}]);await until(()=>texts.length===1);
  assert.match(texts[0],/chair/);assert.equal(fetches,1,'a new query shares the outstanding source operation');
  source.reject(Error('Old relay failed'));await Promise.all([old,next]);
  assert.equal(fetches,2);assert.equal(field('ai-error').textContent,'');assert.equal(ui.query(),'chair');assert.equal(ui.pagination().matches,1);
});

test('a late source failure after a full match window is handled on continuation',async()=>{
  const source=deferred();let fetches=0;
  const client={info:{model:'deberta'},load:async()=>{},classify:async()=>({score:.9}),dispose(){this.info=null;}};
  const {field,ui,setRows}=fixture({rows:[],query:'bicycle',client,fetchMoreCandidates:()=>{fetches++;return source.promise;}});
  let finished=false;const run=field('search-run').onclick().then(()=>{finished=true;});await until(()=>fetches===1);
  setRows(Array.from({length:24},(_,i)=>({...bicycle,id:`stream-${i}`})));await until(()=>finished);await run;
  assert.equal(ui.pagination().matches,24);assert.equal(ui.searching(),false);
  source.reject(Error('Remaining listings unavailable'));await Promise.resolve();
  await ui.loadMore();assert.equal(fetches,1);assert.equal(ui.pagination().paused,true);assert.equal(field('ai-error').textContent,'');assert.match(ui.pagination().error,/Listings unavailable/);assert.match(field('ai-progress').textContent,/Load more to retry/);assert(client.info,'a source error must not unload the model');
  assert.equal(field('ai-summary-text').textContent,'Search paused · 24 matches');
  field('ai-show-all').onclick();assert.equal(field('ai-summary-text').textContent,'Showing all listings');
});

test('a new query ignores stale exhaustion and reviews the final arriving page',async()=>{
  const source=deferred(),conditions=[];let fetches=0,harness;
  const client={info:{model:'deberta'},load:async()=>{},async classify(condition){conditions.push(condition);return{score:.9};},dispose(){this.info=null;}};
  harness=fixture({rows:[],query:'bicycle',client,fetchMoreCandidates:()=>{
    if(++fetches===1)return source.promise;
    harness.setRows([{...bicycle,id:'chair',title:'Chair'}]);return Promise.resolve(false);
  }});
  let oldFinished=false;const old=harness.field('search-run').onclick().then(()=>{oldFinished=true;});await until(()=>fetches===1);
  harness.field('search').value='chair';const next=harness.field('search-run').onclick();await until(()=>oldFinished);
  assert.equal(fetches,1);source.resolve(false);await Promise.all([old,next]);
  assert.equal(fetches,2,'stale exhaustion does not suppress the new query source');
  assert.equal(conditions.length,1);assert.match(conditions[0],/chair/);
  assert.equal(harness.ui.pagination().matches,1);assert.equal(harness.ui.pagination().hasMore,false);
});

test('Stop keeps confirmed matches and pagination resumes the submitted query',async()=>{
  const rows=[bicycle,{...bicycle,id:'second'}];let rejectCurrent,started,count=0;const conditions=[];
  const pending=new Promise(done=>started=done);
  const client={info:{model:'deberta'},load:async function(){this.info={model:'deberta'};return this.info;},async classify(condition){conditions.push(condition);if(++count===1||count>2)return{score:.9};started();return new Promise((_,reject)=>rejectCurrent=reject);},dispose(){this.info=null;rejectCurrent?.(Error('Stopped'));}};
  const {field,ui}=fixture({rows,query:'bicycle',client});const run=field('search-run').onclick();await pending;
  assert.equal(ui.isVisible(rows[0]),true);assert.equal(ui.isVisible(rows[1]),false);field('ai-stop').onclick();await run;
  assert.equal(ui.isVisible(rows[0]),true);assert.equal(ui.isVisible(rows[1]),false);assert.equal(field('ai-error').textContent,'');assert.equal(ui.pagination().hasMore,true);assert.equal(ui.pagination().paused,true);
  field('search').value='chair';field('search').dispatchEvent(new Event('input'));await ui.loadMore();assert.match(conditions.at(-1),/bicycle/);assert.equal(ui.query(),'bicycle');assert.equal(ui.isVisible(rows[1]),true);assert.equal(ui.pagination().paused,false);
  field('search').value='';field('search').dispatchEvent(new Event('input'));assert.equal(ui.query(),'');assert.equal(field('ai-summary').hidden,true);assert.equal(ui.isVisible(rows[1]),true);
});


test('text mode commits only on Enter or Search, never while typing',async()=>{
  const submitted=[];const {field,calls}=fixture({query:'chair',onTextSearch:value=>submitted.push(value)});
  field('search-mode').value='text';
  field('search').dispatchEvent(new Event('input'));
  assert.deepEqual(submitted,[]);
  const enter=new Event('keydown');Object.defineProperty(enter,'key',{value:'Enter'});
  field('search').dispatchEvent(enter);assert.deepEqual(submitted,['chair']);
  field('search').value='  desk  ';field('search').dispatchEvent(new Event('input'));
  assert.deepEqual(submitted,['chair']);
  await field('search-run').onclick();assert.deepEqual(submitted,['chair','desk']);
  assert.equal(calls.length,0,'text search never loads or queries a model');
});


test('topic matching can recover from vague title evidence using the description',async()=>{
 const texts=[];const client={info:{model:'deberta'},load:async()=>{},async classify(condition,text){texts.push(text);return{score:text.includes('Categories:')?.9:.1};},dispose(){this.info=null;}};
 const {field,ui}=fixture({query:'electronics',client});await field('search-run').onclick();
 assert.equal(texts.length,2);assert.equal(ui.isVisible(bicycle),true);
});

const memoryStorage=values=>{const data=new Map(Object.entries(values||{}));return{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};

test('background preparation shows circular progress, enables available AI and never submits typed text',async()=>{
  let finish,report;const calls=[];
  const client={info:null,load(model,_device,progress){calls.push('load');report=progress;return new Promise(resolve=>finish=()=>{this.info={model};resolve(this.info);});},async classify(){calls.push('classify');return{score:.9};},dispose(){}};
  const {ui,field}=fixture({mode:'text',autoPrepare:true,client});await until(()=>!!finish);
  assert.equal(field('search-mode').attributes.get('data-loading'),'true');assert.equal(field('search-run').disabled,false);
  report('Downloading…',{loaded:40,total:100});assert.equal(field('search-mode').styles.get('--ai-download'),'0.4');assert.equal(field('search-mode').attributes.get('data-indeterminate'),'false');
  field('search').value='bicycle';field('search').dispatchEvent(new Event('input'));assert.deepEqual(calls,['load']);finish();await ui.ready;
  assert.equal(ui.enabled(),true);assert.equal(ui.query(),'');assert.equal(field('search-mode').attributes.get('data-loading'),'false');assert.deepEqual(calls,['load']);
  await field('search-run').onclick();assert.deepEqual(calls,['load','classify']);
});

test('explicit enabled and disabled choices survive refresh, with off preventing any automatic model load',async()=>{
  const storage=memoryStorage();const first=fixture({mode:'text',storage});await first.ui.ready;await first.field('search-mode').onclick();
  assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'on');
  const reloaded=fixture({mode:'text',storage,autoPrepare:true});assert.equal(reloaded.ui.enabled(),true);await reloaded.ui.ready;
  assert.equal(reloaded.calls.filter(call=>call[0]==='load').length,1);reloaded.field('search-mode').onclick();assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'off');
  const off=fixture({mode:'text',storage,autoPrepare:true});await off.ui.ready;assert.equal(off.ui.enabled(),false);assert.equal(off.calls.length,0);
});

test('data saver and preview suppress automatic downloads while an explicit action remains available',async()=>{
  const saver=fixture({mode:'text',autoPrepare:true,saveData:()=>true});await saver.ui.ready;assert.equal(saver.calls.length,0);
  await saver.field('search-mode').onclick();assert.equal(saver.calls.filter(call=>call[0]==='load').length,1);
  const preview=fixture({mode:'text',autoPrepare:false});await preview.ui.ready;assert.equal(preview.calls.length,0);
});

test('turning AI off during background loading cannot be undone by its late completion',async()=>{
  let rejectLoad;const storage=memoryStorage({[AI_MODE_STORAGE_KEY]:'on'});
  const client={info:null,load:()=>new Promise((_,reject)=>rejectLoad=reject),async classify(){throw Error('Must not classify');},dispose(){rejectLoad?.(Error('Stopped'));}};
  const {ui,field}=fixture({storage,autoPrepare:true,client});await until(()=>!!rejectLoad);field('search-mode').onclick();await ui.ready;
  assert.equal(ui.enabled(),false);assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'off');assert.equal(field('ai-error').textContent,'');
});

test('a submitted text search is preserved when background AI finishes',async()=>{
  let finish;const queries=[];
  const client={info:null,load(model){return new Promise(resolve=>finish=()=>{this.info={model};resolve(this.info);});},async classify(){throw Error('Must not classify');},dispose(){}};
  const {ui,field}=fixture({mode:'text',query:'bicycle',client,autoPrepare:true,onTextSearch:query=>queries.push(query)});await until(()=>!!finish);
  await field('search-run').onclick();finish();await ui.ready;assert.equal(ui.enabled(),false);assert.deepEqual(queries,['bicycle']);assert.equal(ui.query(),'');
});

test('restored browser provider auto-loads only an already available model and never loads DeBERTa',async()=>{
  let creates=0,prompts=0;const session={destroy(){},async clone(){return{destroy(){},async prompt(){prompts++;return 'true';}};}};
  const browserClient=new BrowserFeedFilterClient({getAPI:()=>({availability:async()=> 'available',create:async()=>{creates++;return session;}})});
  const storage=memoryStorage({[AI_MODE_STORAGE_KEY]:'on',[AI_MODEL_STORAGE_KEY]:'browser'});
  const {ui,field,calls}=fixture({mode:'text',query:'bicycle',storage,browserClient,autoPrepare:true});await ui.ready;
  assert.equal(field('ai-model').value,'browser');assert.equal(ui.enabled(),true);assert.equal(creates,1);assert.equal(prompts,0);assert.equal(calls.length,0);
  await field('search-run').onclick();assert.equal(prompts,1);assert.equal(field('ai-threshold').disabled,true);browserClient.dispose();
});

test('only trusted search activation can prepare a selected downloadable browser model; focus, scroll and typing do not classify',async()=>{
  let creates=0,prompts=0;const session={destroy(){},async clone(){return{destroy(){},async prompt(){prompts++;return 'true';}};}};
  const browserClient=new BrowserFeedFilterClient({getAPI:()=>({availability:async()=> 'downloadable',create:async()=>{creates++;return session;}}),hasActivation:()=>true});
  const storage=memoryStorage({[AI_MODE_STORAGE_KEY]:'on',[AI_MODEL_STORAGE_KEY]:'browser'});
  const {ui,field}=fixture({storage,browserClient,autoPrepare:true});await ui.ready;assert.equal(creates,0);
  field('search').dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('scroll'));field('search').dispatchEvent(new Event('click'));assert.equal(creates,0);
  const saved=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userActivation:{isActive:true}}});
  try{field('search').handlers.get('click')[0]({isTrusted:true});assert.equal(creates,1);await until(()=>!!browserClient.info);
    field('search').value='bicycle';field('search').dispatchEvent(new Event('input'));assert.equal(prompts,0);await field('search-run').onclick();assert.equal(prompts,1);
  }finally{if(saved)Object.defineProperty(globalThis,'navigator',saved);else delete globalThis.navigator;browserClient.dispose();}
});

test('classification passes the exact signed listing revision to the pinned decision cache',async()=>{
  const options=[],client={info:{model:'deberta'},async load(){},async classify(_condition,_text,value){options.push(value);return{score:.9};},dispose(){}};
  const {field}=fixture({query:'bicycle',rows:[{...bicycle,eventId:'a'.repeat(64)}],client});await field('search-run').onclick();assert.deepEqual(options,[{eventId:'a'.repeat(64)}]);
});

test('relevance scores expose only current submitted query/model/revision decisions',async()=>{
  const row={...bicycle,eventId:'a'.repeat(64)},client={info:{model:'deberta'},async load(){},async classify(){return{score:.83};},dispose(){this.info=null;}};
  const {ui,field}=fixture({query:'a bicycle',rows:[row],client});assert.equal(ui.scoreFor(row),undefined);await field('search-run').onclick();
  assert.equal(ui.scoreFor(row),.83);assert.equal(ui.scoreFor({...row,eventId:'b'.repeat(64)}),undefined);
  field('search').value='unsubmitted edit';field('search').dispatchEvent(new Event('input'));assert.equal(ui.query(),'a bicycle');assert.equal(ui.scoreFor(row),.83);
  field('ai-show-all').onclick();assert.equal(ui.scoreFor(row),undefined);field('ai-show-all').onclick();assert.equal(ui.scoreFor(row),.83);
  field('ai-error').textContent='Search failed';assert.equal(ui.scoreFor(row),undefined);field('ai-error').textContent='';
  field('ai-model').onchange();assert.equal(ui.scoreFor(row),undefined);assert.equal(ui.query(),'');
  field('search-mode').onclick();assert.equal(ui.scoreFor(row),undefined);
});


test('submitted AI searches hold a model lease across source waits and release on completion, empty query and Stop',async()=>{
  let pins=0,releases=0,fetches=0;const source=deferred();
  const client={info:{model:'deberta'},pin(){pins++;let done=false;return()=>{if(!done){done=true;pins--;releases++;}};},async load(){this.info={model:'deberta'};},async classify(){return{score:.9,cached:true};},dispose(){this.info=null;}};
  const {field,ui,setRows}=fixture({rows:[],query:'chair',client,fetchMoreCandidates:()=>{fetches++;return source.promise;}});
  const run=field('search-run').onclick();await until(()=>fetches===1);assert.equal(pins,1);
  setRows([{...bicycle,title:'Chair'}]);await until(()=>ui.pagination().matches===1);assert.equal(pins,1,'cache-hit work followed by a source wait remains pinned');
  source.resolve(false);await run;assert.equal(pins,0);assert.equal(releases,1);
  field('search').value='';await field('search-run').onclick();assert.equal(pins,0);assert.equal(releases,2,'the empty already-loaded path releases its lease');
  const waiting=deferred();let stopped=false;const second=fixture({rows:[],query:'desk',client,fetchMoreCandidates:()=>waiting.promise});
  const pending=second.field('search-run').onclick().then(()=>{stopped=true;});await until(()=>pins===1);
  second.field('ai-stop').onclick();await until(()=>stopped);await pending;assert.equal(pins,0);assert.equal(client.info,null);assert.equal(releases,3);
});

test('a remembered Browser choice survives unavailable, missing and failed probes without silently loading DeBERTa',async()=>{
  for(const getAPI of [()=>undefined,()=>({availability:async()=> 'unavailable',create:async()=>{throw Error('must not load');}}),()=>({availability:async()=>{throw Error('transient probe failure');},create:async()=>{throw Error('must not load');}})]) {
    const storage=memoryStorage({[AI_MODE_STORAGE_KEY]:'on',[AI_MODEL_STORAGE_KEY]:'browser'});
    const browserClient=new BrowserFeedFilterClient({getAPI});
    const {ui,field,calls}=fixture({mode:'text',storage,browserClient,autoPrepare:true});
    assert.equal(field('ai-model').value,'browser','restore before the asynchronous probe so an early Search cannot load another model');await ui.ready;
    assert.equal(field('ai-model').value,'browser');assert.equal(storage.getItem(AI_MODEL_STORAGE_KEY),'browser');
    assert.equal(ui.enabled(),true);assert.equal(calls.length,0,'no alternative model is prepared');
    assert.match(field('ai-error').textContent,/Browser AI is unavailable.*Reload to retry/);
    assert.equal(field('ai-model').children.some(option=>option.value==='browser'&&/unavailable/.test(option.textContent)),true);
    await field('search-run').onclick();assert.equal(calls.length,0,'an explicit search still cannot silently choose DeBERTa');
    ui.stop();
  }
});

test('an unavailable remembered Browser choice preserves explicit Off',async()=>{
  const storage=memoryStorage({[AI_MODE_STORAGE_KEY]:'off',[AI_MODEL_STORAGE_KEY]:'browser'});
  const {ui,field,calls}=fixture({mode:'ai',storage,browserClient:new BrowserFeedFilterClient({getAPI:()=>undefined}),autoPrepare:true});await ui.ready;
  assert.equal(ui.enabled(),false);assert.equal(field('ai-model').value,'browser');assert.equal(calls.length,0);
  assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'off');
});


test('a relay pagination failure preserves model and decisions and manual retry resumes without reclassification',async()=>{
  const good={...bicycle,id:'known-match'},bad={...bicycle,id:'known-negative',title:'No match'},next={...bicycle,id:'new-match'};
  const modelInfo={model:'deberta'};let fetches=0,disposals=0,classified=0,harness;
  const client={info:modelInfo,load:async()=>{throw Error('must reuse the loaded model');},async classify(_condition,text){classified++;return{score:text.includes('No match')?.1:.9};},dispose(){disposals++;this.info=null;}};
  harness=fixture({rows:[good,bad],query:'a bicycle',client,fetchMoreCandidates:async()=>{
    if(++fetches===1)throw Error('Private relay error details');
    harness.setRows([good,bad,next]);return false;
  }});
  await harness.field('search-run').onclick();
  assert.equal(fetches,1);assert.equal(classified,2);assert.equal(disposals,0);assert.equal(client.info,modelInfo);
  assert.equal(harness.ui.pagination().paused,true);assert.equal(harness.ui.pagination().hasMore,true);
  assert.equal(harness.ui.pagination().matches,1);assert.equal(harness.ui.scoreFor(good),.9);assert.equal(harness.ui.scoreFor(bad),.1);
  assert.equal(harness.ui.isVisible(good),true);assert.equal(harness.ui.isVisible(bad),false);
  assert.equal(harness.field('ai-error').textContent,'');assert.doesNotMatch(harness.ui.pagination().error,/Private relay/);
  harness.field('search').value='an unsubmitted edit';await harness.ui.loadMore();
  assert.equal(fetches,2);assert.equal(classified,3,'known decisions survive the retry');assert.equal(disposals,0);
  assert.equal(harness.ui.query(),'a bicycle');assert.equal(harness.ui.pagination().matches,2);assert.equal(harness.ui.pagination().target,24);
  assert.equal(harness.ui.pagination().paused,false);assert.equal(harness.ui.pagination().error,'');assert.equal(harness.ui.pagination().hasMore,false);
});

test('an actual classification failure still disposes the model and reports an AI error',async()=>{
  let disposals=0;
  const client={info:{model:'deberta'},load:async()=>{},classify:async()=>{throw Error('Inference failed');},dispose(){disposals++;this.info=null;}};
  const {field,ui}=fixture({query:'a bicycle',client});await field('search-run').onclick();
  assert.equal(disposals,1);assert.equal(client.info,null);assert.equal(ui.pagination().paused,true);
  assert.match(field('ai-error').textContent,/Inference failed.*Show all/);
});

test('automatic enabling and a user model switch survive a failed Browser load and refresh',async()=>{
  const storage=memoryStorage();
  const browserClient=new BrowserFeedFilterClient({getAPI:()=>({availability:async()=> 'available',create:async()=>{throw Error('Browser preparation timed out');}})});
  const first=fixture({mode:'text',storage,browserClient,autoPrepare:true});await first.ui.ready;
  assert.equal(first.ui.enabled(),true);assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'on','automatic enabling is a durable mode choice');
  first.field('ai-model').value='browser';first.field('ai-model').onchange();
  assert.equal(storage.getItem(AI_MODEL_STORAGE_KEY),'browser');assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'on');
  await first.field('search-run').onclick();assert.match(first.field('ai-error').textContent,/Browser preparation timed out/);
  const reloaded=fixture({mode:'text',storage,browserClient:new BrowserFeedFilterClient({getAPI:()=>undefined}),autoPrepare:true});await reloaded.ui.ready;
  assert.equal(reloaded.ui.enabled(),true);assert.equal(reloaded.field('ai-model').value,'browser');assert.equal(reloaded.calls.length,0);
});

test('model selection persists current Off instead of enabling AI on reload',async()=>{
  const storage=memoryStorage({[AI_MODE_STORAGE_KEY]:'off'});
  const first=fixture({mode:'ai',storage});await first.ui.ready;
  first.field('ai-model').value='browser';first.field('ai-model').onchange();
  assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'off');
  const reloaded=fixture({mode:'ai',storage,autoPrepare:true,browserClient:new BrowserFeedFilterClient({getAPI:()=>undefined})});await reloaded.ui.ready;
  assert.equal(reloaded.ui.enabled(),false);assert.equal(reloaded.field('ai-model').value,'browser');assert.equal(reloaded.calls.length,0);
});

test('a legacy remembered model with a missing mode migrates to On without downloading unavailable Browser AI',async()=>{
  for(const model of ['browser','deberta']) {
    const storage=memoryStorage({[AI_MODEL_STORAGE_KEY]:model});
    const {ui,field,calls}=fixture({mode:'text',storage,autoPrepare:false,browserClient:new BrowserFeedFilterClient({getAPI:()=>undefined})});
    assert.equal(ui.enabled(),true);assert.equal(field('ai-model').value,model);await ui.ready;
    assert.equal(storage.getItem(AI_MODE_STORAGE_KEY),'on');assert.equal(calls.length,0);
  }
});
