/** Marketplace hints live inside encrypted kind-14 messages, never carrier tags. */
export interface MessageContext {thread_id:string;order_id?:string;listing?:string}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validMessageContext(value:unknown):value is MessageContext {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const c=value as Record<string,unknown>;
  if(Object.keys(c).some(key=>!['thread_id','order_id','listing'].includes(key))||typeof c.thread_id!=='string'||!UUID.test(c.thread_id))return false;
  if(c.order_id!==undefined&&(typeof c.order_id!=='string'||!new RegExp(`^[a-f0-9]{64}:${c.thread_id}$`).test(c.order_id)))return false;
  if(c.listing!==undefined&&(typeof c.listing!=='string'||c.listing.length>512||!/^30402:[a-f0-9]{64}:[^\x00-\x1f\x7f]+$/.test(c.listing)))return false;
  return true;
}
export function contextTags(context?:MessageContext):string[][] {
  if(!context)return [];
  if(!validMessageContext(context))throw new Error('Invalid conversation context.');
  return [['iris-market-context','1',JSON.stringify(context)]];
}
export function messageContext(tags:string[][]):MessageContext|undefined {
  const found=tags.filter(tag=>tag[0]==='iris-market-context');
  if(found.length!==1||found[0].length!==3||found[0][1]!=='1'||found[0][2].length>1024)return;
  try {const c:unknown=JSON.parse(found[0][2]);return validMessageContext(c)?c:undefined;}catch{return;}
}
/** Listing cards use author:identifier; encrypted context carries a kind-qualified address. */
export function listingContext(id:string,threadID=crypto.randomUUID()):MessageContext {
  const context={thread_id:threadID,listing:id.startsWith('30402:')?id:`30402:${id}`};
  if(!validMessageContext(context))throw new Error('Invalid listing conversation.');
  return context;
}
export function orderContext(id:string):MessageContext {return {thread_id:id.slice(65),order_id:id};}
export function messageThreadKey(message:{orderId?:string;context?:MessageContext}):string {
  return message.orderId?`order:${message.orderId}`:message.context?.order_id?`order:${message.context.order_id}`:message.context?`thread:${message.context.thread_id}`:'general';
}
export function groupMessageThreads<T extends {createdAt?:number;orderId?:string;context?:MessageContext}>(messages:T[]):Array<{key:string;context?:MessageContext;messages:T[]}> {
  const groups=new Map<string,{key:string;context?:MessageContext;messages:T[]}>();
  for(const message of messages){const key=messageThreadKey(message);let group=groups.get(key);if(!group){group={key,context:message.context??(message.orderId?orderContext(message.orderId):undefined),messages:[]};groups.set(key,group);}group.messages.push(message);}
  return [...groups.values()].sort((a,b)=>(b.messages.at(-1)?.createdAt??0)-(a.messages.at(-1)?.createdAt??0));
}
