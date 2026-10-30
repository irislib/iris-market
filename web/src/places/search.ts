import {MapBlockCache} from '../map/cache.ts';
import {createMapPlaceSearchSource,type MapPlaceSearchManifest} from './index.ts';
import {matchesMapSearchQuery} from './mapSearchText.ts';
import type {SearchResult} from './types.ts';
import manifest from './manifest.json' with {type:'json'};
import labels from './labels.json' with {type:'json'};

/** Search runs locally over verified public catalog blocks; no user query or GPS is uploaded. */
export function createPlaceSearch({source,timeoutMs=15000}:{source?:{search(query:string,limit:number):Promise<SearchResult[]>};timeoutMs?:number}={}) {
  let cache:MapBlockCache|null=null,closed=false;
  const local=(query:string)=>labels.labels.filter(place=>matchesMapSearchQuery({name:place.name,type:place.kind,displayName:place.name} as SearchResult,query)).slice(0,8).map(place=>({name:place.name,displayName:place.name,lat:place.lat,lng:place.lng,type:place.kind,class:'place'}));
  return {
    async search(input:string):Promise<SearchResult[]> {
      const query=input.trim().slice(0,160);if(closed||query.length<2)return[];
      let timer:ReturnType<typeof setTimeout>;
      try {
        if(!source){cache??=new MapBlockCache({cacheMiB:64});const blocks=cache;source=createMapPlaceSearchSource(manifest as MapPlaceSearchManifest,{store:{get:hash=>blocks.get(hash),has:async()=>false,put:async()=>false,delete:async()=>false}});}
        const results=await Promise.race([source.search(query,8),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Place search unavailable')),timeoutMs);})]);
        return closed?[]:results.length?results:local(query);
      }catch{return closed?[]:local(query);}finally{clearTimeout(timer);}
    },
    async close(){closed=true;await cache?.close();},
  };
}
