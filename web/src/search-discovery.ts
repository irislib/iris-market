import type { SeenTags, SearchTagExpansion } from './seen-tags.ts'
interface DiscoveryClient {
  searchTags(query:string,extraTags?:readonly string[],expansion?:SearchTagExpansion):readonly string[]
  tagCatalogue:Pick<SeenTags,'entries'>
}
interface DiscoveryAI {
  enabled():boolean
  planTags(query:string,tags:readonly string[],signal?:AbortSignal):Promise<readonly string[]>
}
/** Coordinates only submitted searches. Retrieval failures never change AI/model/result state. */
export function createSearchDiscovery({getClient,getAI}:{getClient:()=>DiscoveryClient|null|undefined;getAI:()=>DiscoveryAI|null|undefined}) {
  let current:{client:DiscoveryClient;query:string;expansion:SearchTagExpansion}|undefined
  let controller=new AbortController()
  function reset(){controller.abort();controller=new AbortController();current=undefined}
  function update(query:string,expansion:SearchTagExpansion){
    const client=getClient()
    if(!client){reset();return}
    if(current?.client===client&&current.query===query&&current.expansion===expansion)return
    reset()
    const search=current={client,query,expansion},signal=controller.signal
    client.searchTags(query,undefined,expansion)
    const ai=getAI()
    if(!query||expansion!=='expanded'||!ai?.enabled())return
    const tags=client.tagCatalogue.entries().flatMap(entry=>entry.spellings).slice(0,128)
    void Promise.resolve().then(()=>signal.aborted?[]:ai.planTags(query,tags,signal)).then(selected=>{
      if(!signal.aborted&&current===search&&getClient()===client&&getAI()===ai&&ai.enabled()&&selected.length)client.searchTags(query,selected,expansion)
    }).catch(()=>{/* Optional tag planning must not unload the model or clear confirmed results. */})
  }
  return{update,reset,dispose:reset}
}
