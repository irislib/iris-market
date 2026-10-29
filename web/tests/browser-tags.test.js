import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_TAG_LIMITS,planBrowserTags} from '../src/feed-filter/browser-tags.ts';

const info={model:'browser',device:'browser',revision:'browser-managed',dtype:'browser-managed',loadMilliseconds:0};
function fixture({availability='available',output='["bicycle","Bike"]',prompt,create,isCurrent=()=>true}={}){
  const calls={availability:0,create:[],prompt:[],destroy:0};
  const api={async availability(){calls.availability++;return availability;},async create(options){calls.create.push(options);return create?create():{async prompt(input,options){calls.prompt.push({input,options});return prompt?prompt():output;},destroy(){calls.destroy++;}};}};
  return{calls,options:{info,isCurrent,getAPI:()=>api}};
}

test('optional planning uses only a selected loaded browser model and never triggers a model download',async()=>{
  const absent=fixture();assert.deepEqual(await planBrowserTags('bicycle',['bicycle'],{...absent.options,info:null}),[]);assert.equal(absent.calls.availability,0);
  const other=fixture();assert.deepEqual(await planBrowserTags('bicycle',['bicycle'],{...other.options,info:{model:'deberta'}}),[]);assert.equal(other.calls.availability,0);
  const downloading=fixture({availability:'downloadable'});assert.deepEqual(await planBrowserTags('bicycle',['bicycle'],downloading.options),[]);assert.equal(downloading.calls.create.length,0);
});

test('plans contain only exact observed tags, use a fresh session and leave literal retrieval to the caller',async()=>{
  const {calls,options}=fixture();assert.deepEqual(await planBrowserTags('A bike',['bicycle','Bike','chair'],options),['bicycle','Bike']);
  assert.equal(calls.create.length,1);assert.equal(calls.destroy,1);assert.match(calls.create[0].initialPrompts[0].content,/untrusted data/);
  assert.deepEqual(calls.prompt[0].options.responseConstraint,{type:'array',items:{type:'string',enum:['bicycle','Bike','chair']},uniqueItems:true,maxItems:8});
  assert.deepEqual(JSON.parse(calls.prompt[0].input),{query:'A bike',observedTags:['bicycle','Bike','chair']});
});

test('malformed, hallucinated, duplicate and oversized plans fall back without issuing queries',async()=>{
  for(const output of ['["unknown"]','["bicycle","bicycle"]','{"tags":["bicycle"]}','```json\n["bicycle"]\n```','true','x'.repeat(BROWSER_TAG_LIMITS.response+1),JSON.stringify(Array.from({length:9},(_,i)=>`tag${i}`))]){
    const {options}=fixture({output});assert.deepEqual(await planBrowserTags('A bike',['bicycle',...Array.from({length:9},(_,i)=>`tag${i}`)],options),[]);
  }
});

test('catalogue and query bounds prevent unbounded prompts',async()=>{
  const {calls,options}=fixture({output:'[]'});const tags=Array.from({length:500},(_,i)=>`tag${i}`);
  await planBrowserTags('A bike',tags,options);assert.equal(JSON.parse(calls.prompt[0].input).observedTags.length,128);
  assert.deepEqual(await planBrowserTags('x'.repeat(501),tags,options),[]);assert.equal(calls.create.length,1);
});

test('mode changes and cancellation discard late plans and destroy their session',async()=>{
  let finish,current=true;const {calls,options}=fixture({prompt:()=>new Promise(resolve=>finish=resolve),isCurrent:()=>current});
  const controller=new AbortController(),pending=planBrowserTags('Bike',['bicycle'],{...options,signal:controller.signal});
  for(let i=0;i<8&&!finish;i++)await Promise.resolve();assert(finish);current=false;controller.abort();assert.deepEqual(await pending,[]);assert.equal(calls.destroy,1);finish('["bicycle"]');
});

test('a stuck optional planner has a hard deadline and never delays retrieval indefinitely',{timeout:500},async()=>{
  const {calls,options}=fixture({prompt:()=>new Promise(()=>{})});assert.deepEqual(await planBrowserTags('Bike',['bicycle'],{...options,timeoutMs:10}),[]);assert.equal(calls.destroy,1);
});
