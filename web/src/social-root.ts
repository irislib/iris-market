import {GRAPH_BOOTSTRAP} from './graph-bootstrap.ts'

/** Results must come from the verified profile loader, never raw relay JSON or
 * the unsigned bootstrap graph. This controller selects a root, not badges. */
export interface RootContext {
  contextPubkey:string;
  coverage:{rootLoaded:boolean;directFollows:number|null};
  lists?:ReadonlyMap<string,{event:{id:string;created_at:number};follows:readonly string[]|null}>;
}
export interface SocialRootState<T extends RootContext> {
  root:string;identity:string|null;source:'default'|'identity'|'override';pending:boolean;context:T|null;
}
interface RootOptions<T extends RootContext> {
  defaultRoot?:string;initialContext?:string;initialIdentity?:string|null;
  loadContext:(owner:string,options:{signal:AbortSignal})=>Promise<T>;
  onChange?:(state:Readonly<SocialRootState<T>>)=>void;
}
const publicKey=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
interface Observation<T> {context:T;nonempty:boolean;revision?:{id:string;at:number}}

/** A new/empty profile gets useful discovery immediately. A verified nonempty
 * personal graph replaces it in the background, without an EOSE/UI barrier. */
export function createSocialRootController<T extends RootContext>({defaultRoot=GRAPH_BOOTSTRAP.root,initialContext,initialIdentity=null,loadContext,onChange=()=>{}}:RootOptions<T>) {
  if(!publicKey(defaultRoot))throw new Error('Invalid default social root')
  let identity=publicKey(initialIdentity)?initialIdentity:null
  let override=publicKey(initialContext)&&initialContext!==defaultRoot&&initialContext!==identity?initialContext:null
  let pending=false,disposed=false,generation=0,request:AbortController|null=null
  const known=new Map<string,Observation<T>>()
  function state():Readonly<SocialRootState<T>> {
    const own=identity?known.get(identity):null
    if(override)return Object.freeze({root:override,identity,source:'override',pending:false,context:null})
    if(own?.nonempty)return Object.freeze({root:identity,identity,source:'identity',pending,context:own.context})
    return Object.freeze({root:defaultRoot,identity,source:'default',pending,context:null})
  }
  function emit(){if(!disposed)onChange(state())}
  function cancel(){generation++;request?.abort();request=null;pending=false}
  function remember(context:T){
    if(!publicKey(context?.contextPubkey))return false
    if(context.coverage?.rootLoaded!==true||!Number.isSafeInteger(context.coverage.directFollows)||context.coverage.directFollows<0){
      const previous=known.get(context.contextPubkey)
      // The loader may have invalidated old edges after a newer unsupported
      // signed list. Retain the selected root, but never restore old badges over
      // its freshly returned graph. A rejected lookup instead retains context.
      if(previous){known.set(context.contextPubkey,{...previous,context});return true}
      return false
    }
    const owner=context.contextPubkey,record=context.lists?.get(owner),previous=known.get(owner)
    const revision=record&&publicKey(record.event?.id)&&Number.isSafeInteger(record.event.created_at)?{id:record.event.id,at:record.event.created_at}:undefined
    if(previous?.revision&&revision&&(revision.at<previous.revision.at||revision.at===previous.revision.at&&revision.id>previous.revision.id))return false
    if(!known.has(owner)&&known.size>=8)known.delete(known.keys().next().value)
    known.set(owner,{context,nonempty:context.coverage.directFollows>0,revision})
    return true
  }
  function refresh(){
    if(disposed)return
    cancel()
    if(!identity||override){emit();return}
    const owner=identity,ticket=generation,controller=new AbortController()
    request=controller;pending=true;emit()
    // Start after publishing the synchronous root choice. Neither signing in nor
    // selecting a network awaits this optional lookup.
    void Promise.resolve().then(()=>{
      if(disposed||ticket!==generation||controller.signal.aborted)return null
      return loadContext(owner,{signal:controller.signal})
    }).then(context=>{
      if(disposed||ticket!==generation||owner!==identity||override)return
      if(context?.contextPubkey===owner)remember(context)
    }).catch(()=>{
      // Missing/unsupported data is not an empty list. Keep a previous known
      // nonempty graph through temporary network failures.
    }).finally(()=>{
      if(disposed||ticket!==generation)return
      request=null;pending=false;emit()
    })
  }
  return{
    state,
    setIdentity(owner:string|null,previousOwner?:string|null){
      if(disposed)return
      const next=publicKey(owner)?owner:null,previous=publicKey(previousOwner)?previousOwner:identity
      // Existing storage used one context key for automatic and manual choices.
      // A current/previous identity is automatic; unrelated explicit choices stay.
      const oldOverride=override
      if(override&&(override===next||override===previous))override=null
      if(next===identity){if(oldOverride!==override||!request&&!known.has(next)&&!override)refresh();return}
      cancel();identity=next;refresh()
    },
    selectContext(root:string){
      if(disposed)return
      if(!publicKey(root))throw new Error('Invalid social context')
      cancel();override=root===identity?null:root;refresh()
    },
    useAutomatic(){if(disposed)return;cancel();override=null;refresh()},
    refresh,
    /** Reuse a result already loaded by the app; no duplicate relay query. */
    observe(context:T){
      if(disposed||context?.contextPubkey!==identity)return
      if(remember(context))emit()
    },
    dispose(){cancel();disposed=true;known.clear()},
  }
}
