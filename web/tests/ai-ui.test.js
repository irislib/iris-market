import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAI} from '../src/ai-ui.ts';

class Element extends EventTarget {
  constructor(value=''){super();this.value=value;this.textContent='';this.hidden=false;this.disabled=false;this.attributes=new Map();this.children=[];}
  append(...children){this.children.push(...children);}
  setAttribute(name,value){this.attributes.set(name,value);}
  removeAttribute(name){this.attributes.delete(name);}
  focus(){this.focused=true;}
}
const bicycle={id:'bicycle',title:'Bicycle',description:'City bicycle',side:'offer',category:'transport'};
function fixture({rows=[bicycle],query='',gpu=true,client:provided,fetchMoreCandidates,onTextSearch}={}){
  const elements=new Map(),calls=[];
  const field=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  globalThis.document={querySelector:selector=>field(selector.slice(1)),createElement:()=>new Element()};globalThis.window=new EventTarget();
  field('search-mode').value='ai';field('search').value=query;field('ai-model').value='deberta';field('ai-threshold').value='0.5';
  const client=provided??{info:null,async load(model,device,progress){calls.push(['load',model,device]);progress('Downloading model…');this.info={model,device};return this.info;},async classify(condition,text){calls.push(['classify',condition,text]);return{score:.8};},dispose(){calls.push(['dispose']);this.info=null;}};
  const ui=setupAI({getCandidates:()=>rows,onChange:()=>ui.refresh(),client,hasWebGPU:()=>gpu,fetchMoreCandidates,onTextSearch});ui.refresh();
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
  await ui.loadMore();assert.equal(fetches,1);assert.equal(ui.pagination().paused,true);assert.match(field('ai-error').textContent,/Remaining listings unavailable/);
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
