import {createOfflineShell,type ShellAsset} from './offline-shell.ts'
declare const __MARKET_SHELL__:readonly ShellAsset[]
declare const __MARKET_REVISION__:string
const worker=self as unknown as ServiceWorkerGlobalScope
const shell=createOfflineShell({scope:worker.registration.scope,revision:__MARKET_REVISION__,assets:__MARKET_SHELL__,caches:worker.caches,fetch:request=>worker.fetch(request)})
worker.addEventListener('install',event=>event.waitUntil(shell.install()))
worker.addEventListener('activate',event=>event.waitUntil(shell.activate()))
worker.addEventListener('fetch',event=>{if(shell.handles(event.request))event.respondWith(shell.respond(event.request))})
