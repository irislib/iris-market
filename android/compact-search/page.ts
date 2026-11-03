import {FeedFilterClient} from '../../web/src/feed-filter/client.ts'
import {DecisionCache} from '../../web/src/feed-filter/decision-cache.ts'
import {listingSearchTexts,searchCondition} from '../../web/src/search-condition.ts'
import {planTopicFilters} from '../../web/src/semantic-discovery.ts'

const client=new FeedFilterClient({workerUrl:'/worker.js',decisionCache:new DecisionCache({store:null})})
let lastQuery:string|undefined, searchHead=false
async function request(action:string,input:any){
  if(action==='load'){await client.load('deberta','wasm');return {}}
  if(action==='plan'){
    const observed:string[]=input.tags.slice(0,128)
    const plan=await planTopicFilters(input.query,observed,new AbortController().signal)
    return {tags:plan.tags.filter(tag=>observed.includes(tag)).slice(0,4), terms:plan.terms.slice(0,2)}
  }
  if(action!=='review')throw Error('Unknown operation')
  const query=input.query
  if(query!==lastQuery){searchHead=await client.selectSearchHead(query);lastQuery=query}
  let score=0
  for(const text of listingSearchTexts(input.listing,query,'deberta')){
    const result=await client.classify(searchCondition(query,'deberta'),text,{searchHead})
    score=Math.max(score,result.score)
    if(score>=.5)break
  }
  return {score,show:score>=.5}
}
declare const IrisSearch:{ready():void;complete(id:number,json:string):void}
Object.assign(globalThis,{compactSearch:(id:number,action:string,input:any)=>{
  void request(action,input).then(value=>IrisSearch.complete(id,JSON.stringify(value)),
    ()=>IrisSearch.complete(id,JSON.stringify({failed:true})))
}})
IrisSearch.ready()
