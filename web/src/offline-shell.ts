export interface ShellAsset {path:string;sha256:string;bytes:number}
interface ShellOptions {
  scope:string;revision:string;assets:readonly ShellAsset[];caches:CacheStorage;
  fetch:(request:Request)=>Promise<Response>;
}
const MAX_SHELL_BYTES=24*1024*1024
const sha=async(bytes:ArrayBuffer)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('')

export function createOfflineShell({scope,revision,assets,caches,fetch}:ShellOptions) {
  const base=new URL(scope),prefix=`iris-market-shell:${base.href}:`,name=prefix+revision
  if(!/^[a-f0-9]{64}$/.test(revision)||!base.pathname.endsWith('/')||assets.length>256||!assets.length)throw new Error('Invalid offline shell')
  const files=new Map<string,ShellAsset>();let total=0
  for(const asset of assets){
    if(!/^[a-zA-Z0-9_./-]+$/.test(asset.path)||asset.path.startsWith('/')||asset.path.split('/').some(part=>!part||part==='.'||part==='..')||!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isSafeInteger(asset.bytes)||asset.bytes<0)throw new Error('Invalid offline asset')
    total+=asset.bytes;if(total>MAX_SHELL_BYTES)throw new Error('Offline shell exceeds its storage bound')
    files.set(new URL(asset.path,base).href,asset)
  }
  const index=new URL('index.html',base).href
  if(!files.has(index))throw new Error('Offline shell requires its entry page')
  function navigation(url:URL) {
    if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname))return false
    const path=url.pathname.slice(base.pathname.length)
    return /^(?:|index\.html|saved|post|courier|settings(?:\/profile)?|wallet|orders(?:\/[A-Za-z0-9_-]+)?|messages(?:\/npub1[ac-hj-np-z02-9]{58})?|npub1[ac-hj-np-z02-9]{58}(?:\/[^/]+)?|naddr1[ac-hj-np-z02-9]+)$/.test(path)
  }
  function handles(request:Request) {
    if(request.method!=='GET')return false
    const url=new URL(request.url)
    return request.mode==='navigate'?navigation(url):!url.search&&files.has(url.href)
  }
  return {
    name,handles,
    async install(){
      // Verify the entire release before creating a usable cache. Arbitrary
      // responses, redirects and partially deployed bundles cannot become shell.
      const loaded:Array<[string,Response]>=[]
      for(const [url,asset] of files){
        const response=await fetch(new Request(url,{cache:'no-store',credentials:'omit',redirect:'error'}))
        if(!response.ok||response.type==='opaque'||response.redirected)throw new Error('Offline asset is unavailable')
        const declared=Number(response.headers.get('content-length'))
        if(declared>asset.bytes)throw new Error('Offline asset is larger than its release')
        const reader=response.body?.getReader();if(!reader)throw new Error('Offline asset has no body')
        const chunks:Uint8Array[]=[];let length=0
        try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>asset.bytes)throw new Error('Offline asset exceeded its bound');chunks.push(next.value)}}finally{await reader.cancel()}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
        if(length!==asset.bytes||await sha(bytes.buffer)!==asset.sha256)throw new Error('Offline asset failed release verification')
        const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length')
        loaded.push([url,new Response(bytes,{status:response.status,statusText:response.statusText,headers})])
      }
      const cache=await caches.open(name)
      try{for(const [url,response] of loaded)await cache.put(url,response)}catch(error){await caches.delete(name);throw error}
    },
    async activate(){for(const key of await caches.keys())if(key.startsWith(prefix)&&key!==name)await caches.delete(key)},
    async respond(request:Request){
      if(!handles(request))throw new Error('Request is outside the offline shell')
      const url=request.mode==='navigate'?index:request.url
      const cached=await(await caches.open(name)).match(url)
      if(cached)return cached
      // Cache eviction may occur under storage pressure. Do not save an
      // unverified network replacement into this immutable release cache.
      return fetch(new Request(url,{credentials:'omit'}))
    },
  }
}
