import { deploymentBase } from './asset-url.ts'

/** Installation is optional; ordinary browsing survives unsupported/private modes. */
export async function registerPwa({serviceWorker=globalThis.navigator?.serviceWorker,href=globalThis.location?.href}: {serviceWorker?:Pick<ServiceWorkerContainer,'register'>;href?:string}={}) {
  if(!serviceWorker||!href)return null
  const base=deploymentBase(href)
  if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))return null
  try{
    // The browser waits for existing tabs to close before activating an update.
    // Never reload an active order, draft or signing prompt automatically.
    return await serviceWorker.register(new URL('sw.js',base).href,{scope:base.pathname,type:'module',updateViaCache:'none'})
  }catch{return null}
}
