import type { SeenTags, SearchTagExpansion } from './seen-tags.ts'
interface DiscoveryClient {
  searchTags(query:string,extraTags?:readonly string[],expansion?:SearchTagExpansion,extraTerms?:readonly string[]):readonly string[]
  tagCatalogue:Pick<SeenTags,'entries'>
}
interface DiscoveryAI {
  enabled():boolean
  canPlanTags?():boolean
  topicPlanning?():boolean
  planTags(query:string,tags:readonly string[],signal?:AbortSignal):Promise<readonly string[]>
}
type TopicPlan=(query:string,tags:readonly string[],signal:AbortSignal)=>Promise<{tags:string[];terms:string[]}>
/** Coordinates only submitted searches. Retrieval failures never change AI/model/result state. */
export function createSearchDiscovery({getClient,getAI,planTopics}:{planTopics?:TopicPlan;getClient:()=>DiscoveryClient|null|undefined;getAI:()=>DiscoveryAI|null|undefined}) {
  let current:{client:DiscoveryClient;query:string;expansion:SearchTagExpansion;planned:boolean;topicStage:number}|undefined
  let controller=new AbortController()
  function reset(){controller.abort();controller=new AbortController();current=undefined}
  function update(query:string,expansion:SearchTagExpansion){
    const client=getClient()
    if(!client){reset();return}
    if(current?.client!==client||current.query!==query||current.expansion!==expansion){
      reset()
      current={client,query,expansion,planned:false,topicStage:0}
      client.searchTags(query,undefined,expansion)
    }
    const search=current,signal=controller.signal,ai=getAI()
    if(!query||expansion!=='expanded'||!ai?.enabled())return
    const live=()=>!signal.aborted&&current===search&&getClient()===client&&getAI()===ai&&ai.enabled()
    if(planTopics&&ai.topicPlanning?.()){
      if(search.topicStage===2||!/^\p{L}+$/u.test(query.trim()))return
      const tags=client.tagCatalogue.entries().flatMap(entry=>entry.spellings).slice(0,128)
      const stage=tags.length?2:1
      if(stage<=search.topicStage)return
      search.topicStage=stage
      void planTopics(query,tags,signal).then(plan=>{
        if(live()&&ai.topicPlanning()&&search.topicStage===stage&&(plan.tags.length||plan.terms.length))
          client.searchTags(query,plan.tags,expansion,plan.terms)
      }).catch(()=>{/* The literal retrieval already runs. */})
      return
    }
    if(search.planned||ai.canPlanTags?.()===false)return
    const tags=client.tagCatalogue.entries().flatMap(entry=>entry.spellings).slice(0,128)
    if(!tags.length)return
    // A cold link can arrive before either the model or signed tag evidence.
    // Run the optional planner once both exist without restarting relay history.
    search.planned=true
    void Promise.resolve().then(()=>signal.aborted?[]:ai.planTags(query,tags,signal)).then(selected=>{
      if(live()&&ai.canPlanTags?.()!==false&&selected.length)client.searchTags(query,selected,expansion)
    }).catch(()=>{/* Optional tag planning must not unload the model or clear confirmed results. */})
  }
  return{update,reset,dispose:reset}
}
