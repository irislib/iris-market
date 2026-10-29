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
function fixture({rows=[bicycle],query='',gpu=true,client:provided}={}){
  const elements=new Map(),calls=[];
  const field=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  globalThis.document={querySelector:selector=>field(selector.slice(1)),createElement:()=>new Element()};globalThis.window=new EventTarget();
  field('search-mode').value='ai';field('search').value=query;field('ai-model').value='deberta';field('ai-threshold').value='0.5';
  const client=provided??{info:null,async load(model,device,progress){calls.push(['load',model,device]);progress('Downloading model…');this.info={model,device};return this.info;},async classify(condition,text){calls.push(['classify',condition,text]);return{score:.8};},dispose(){calls.push(['dispose']);this.info=null;}};
  const ui=setupAI({getCandidates:()=>rows,onChange:()=>ui.refresh(),client,hasWebGPU:()=>gpu});ui.refresh();
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


test('submission hides unknowns and infinite-scroll pages classify 24 candidates each',async()=>{
  const rows=Array.from({length:53},(_,i)=>({...bicycle,id:`listing-${i}`}));let resolve,started,classified=0;
  const pending=new Promise(done=>started=done);
  const client={info:{model:'deberta'},load:async()=>{},async classify(){classified++;if(classified===1){started();return new Promise(done=>resolve=done);}return{score:classified%2?.8:.1};},dispose(){this.info=null;}};
  const {field,ui}=fixture({rows,query:'bicycle',client});assert.equal(ui.isVisible(rows[0]),true);
  const run=field('search-run').onclick();await pending;assert.equal(ui.query(),'bicycle');assert.equal(ui.isVisible(rows[0]),false);assert.equal(ui.isVisible(rows[52]),false);
  assert.equal(ui.pagination().loading,true);resolve({score:.8});await run;
  assert.equal(classified,24);assert.equal(ui.pagination().remaining,29);assert.equal(ui.pagination().hasMore,true);assert.equal(ui.isVisible(rows[0]),true);assert.equal(ui.isVisible(rows[1]),false);
  field('search').value='unsubmitted draft';field('search').dispatchEvent(new Event('input'));await ui.loadMore();
  assert.equal(classified,48);assert.equal(ui.query(),'bicycle');assert.equal(ui.pagination().remaining,5);assert.equal(ui.isVisible(rows[0]),true);
  await ui.loadMore();assert.equal(classified,53);assert.equal(ui.pagination().hasMore,false);assert.equal(ui.pagination().reviewed,53);assert.equal(ui.isVisible(rows[52]),true);
  assert.equal(field('search-run').textContent,'Search with AI');assert.doesNotMatch(field('ai-summary-text').textContent,/next 12/);
});

test('Stop keeps confirmed matches and pagination resumes the submitted query',async()=>{
  const rows=[bicycle,{...bicycle,id:'second'}];let rejectCurrent,started,count=0;const conditions=[];
  const pending=new Promise(done=>started=done);
  const client={info:{model:'deberta'},load:async function(){this.info={model:'deberta'};return this.info;},async classify(condition){conditions.push(condition);if(++count===1||count>2)return{score:.9};started();return new Promise((_,reject)=>rejectCurrent=reject);},dispose(){this.info=null;rejectCurrent?.(Error('Stopped'));}};
  const {field,ui}=fixture({rows,query:'bicycle',client});const run=field('search-run').onclick();await pending;
  assert.equal(ui.isVisible(rows[0]),true);assert.equal(ui.isVisible(rows[1]),false);field('ai-stop').onclick();await run;
  assert.equal(ui.isVisible(rows[0]),true);assert.equal(ui.isVisible(rows[1]),false);assert.equal(field('ai-error').textContent,'');assert.equal(ui.pagination().hasMore,true);assert.equal(ui.pagination().paused,true);
  field('search').value='chair';field('search').dispatchEvent(new Event('input'));await ui.loadMore();assert.match(conditions.at(-1),/bicycle/);assert.equal(ui.query(),'bicycle');assert.equal(ui.isVisible(rows[1]),true);assert.equal(ui.pagination().paused,false);
  field('search').value='';field('search').dispatchEvent(new Event('input'));assert.equal(ui.query(),'bicycle');await field('search-run').onclick();assert.equal(ui.query(),'');assert.equal(ui.isVisible(rows[1]),true);
});
