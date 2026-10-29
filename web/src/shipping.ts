// Read-only subset of the draft GammaMarkets/market-spec shipping references.
// A location on a product is not a shipping origin. Country tags on pickup
// options are also not a promise of delivery to those countries.
import {verifyEvent, type Event, type Filter} from 'nostr-tools';
import type {MarketListing} from './market.ts';

export const SHIPPING_LIMITS=Object.freeze({listings:1000,references:64,perListing:12,records:1024,deletions:2048,events:1024,eventBytes:32768,queryBytes:2*1024*1024,queries:8,timeoutMs:6000});
export const COUNTRY_CODES=Object.freeze('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const countries=new Set(COUNTRY_CODES),hex=/^[0-9a-f]{64}$/,encoder=new TextEncoder();
const seconds=()=>Math.floor(Date.now()/1000),cancelled=()=>new DOMException('Shipping lookup cancelled.','AbortError');
export type ShippingQuery=(filters:Filter[],options?:{signal?:AbortSignal;deadline?:number;limit?:number;cache?:'cache-first'|'network-only'|'cache-only'})=>Promise<{events:Event[];complete?:boolean}>;
export interface ShippingReference {address:string;kind:30405|30406;author:string;identifier:string}
export interface ShippingOption {
  reference:string;eventId:string;author:string;identifier:string;createdAt:number;
  title:string;service:'standard'|'express'|'overnight'|'pickup';countries:string[];regions:string[];
  price:string;currency:string;pickupLocation?:string;geohash?:string;
}
export interface ListingShipping {destinations:string[];options:ShippingOption[];pickupAvailable:boolean;unknown:boolean}
type ListingInput=Pick<MarketListing,'id'|'originalTags'|'status'|'expiration'>;
interface RecordValue {event:Event;reference:ShippingReference;expiration:number|null;active:boolean;unsupported:boolean;option?:ShippingOption;references:ShippingReference[];truncated:boolean}
interface Deletion {author:string;at:number}
const assert=(valid:unknown,message='Invalid shipping record.'):void=>{if(!valid)throw new Error(message);};
const single=(tags:readonly (readonly string[])[],name:string)=>{const found=tags.filter(tag=>tag[0]===name);assert(found.length<=1);return found[0];};
const newer=(a:Event,b?:Event)=>!b||a.created_at>b.created_at||a.created_at===b.created_at&&a.id<b.id;

export function countryCode(value:string):string|null {const code=typeof value==='string'?value.trim().toUpperCase():'';return countries.has(code)?code:null;}
export function parseShippingReference(value:string):ShippingReference|null {
  if(typeof value!=='string'||encoder.encode(value).length>240)return null;
  const match=/^(30405|30406):([a-f0-9]{64}):(.+)$/.exec(value);
  if(!match||encoder.encode(match[3]).length>160||/[\u0000-\u001f\u007f]/.test(match[3]))return null;
  return {address:value,kind:Number(match[1]) as 30405|30406,author:match[2],identifier:match[3]};
}
function references(tags:readonly (readonly string[])[],collection=false) {
  const values=tags.filter(tag=>tag[0]==='shipping_option'),unique=new Map<string,ShippingReference>();let truncated=values.length>SHIPPING_LIMITS.perListing;
  for(const tag of values.slice(0,SHIPPING_LIMITS.perListing)){
    const ref=parseShippingReference(tag[1]);
    if(!ref||collection&&ref.kind!==30406){truncated=true;continue;}
    unique.set(ref.address,ref);
  }
  return {references:[...unique.values()],truncated};
}
function verified(input:Event,now:number):Event {
  assert(input&&[5,30405,30406].includes(input.kind)&&hex.test(input.id)&&hex.test(input.pubkey)&&/^[a-f0-9]{128}$/.test(input.sig));
  assert(Number.isSafeInteger(input.created_at)&&input.created_at>=0&&input.created_at<=now+300);
  assert(typeof input.content==='string'&&input.content.length<=SHIPPING_LIMITS.eventBytes&&Array.isArray(input.tags)&&input.tags.length<=128&&input.tags.every(tag=>Array.isArray(tag)&&tag.length>0&&tag.length<=256&&tag.every(value=>typeof value==='string'&&value.length<=2048)));
  assert(input.tags.reduce((size,tag)=>size+tag.reduce((sum,value)=>sum+value.length,0),input.content.length)<=SHIPPING_LIMITS.eventBytes);
  // Re-copy wire fields so nostr-tools' cached verification symbol is never trusted.
  const event={id:input.id,pubkey:input.pubkey,created_at:input.created_at,kind:input.kind,content:input.content,tags:input.tags.map(tag=>[...tag]),sig:input.sig};
  assert(encoder.encode(JSON.stringify(event)).length<=SHIPPING_LIMITS.eventBytes&&verifyEvent(event));return event;
}
function parseRecord(event:Event):RecordValue {
  const d=single(event.tags,'d');assert(d?.length===2);
  const reference=parseShippingReference(`${event.kind}:${event.pubkey}:${d[1]}`);assert(reference);
  const result:RecordValue={event,reference,expiration:null,active:true,unsupported:false,references:[],truncated:false};
  // Keep the latest signed address even when its fields are unsupported. An old
  // valid option must not reappear behind a newer malformed/disabled revision.
  try{
    const expiration=single(event.tags,'expiration');
    if(expiration){assert(expiration.length===2&&/^\d+$/.test(expiration[1]));result.expiration=Number(expiration[1]);assert(Number.isSafeInteger(result.expiration));}
    const status=single(event.tags,'status'),visibility=single(event.tags,'visibility');
    result.active=(!status||status[1]==='active')&&(!visibility||['on-sale','pre-order'].includes(visibility[1]));
    const title=single(event.tags,'title');assert(title?.length===2&&title[1].trim()&&Array.from(title[1]).length<=160);
    if(event.kind===30405){Object.assign(result,references(event.tags,true));return result;}
    const service=single(event.tags,'service'),price=single(event.tags,'price'),country=single(event.tags,'country'),region=single(event.tags,'region');
    assert(service?.length===2&&['standard','express','overnight','pickup'].includes(service[1]));
    assert(price?.length===3&&/^\d+(?:\.\d+)?$/.test(price[1])&&price[1].length<=24&&Number.isFinite(Number(price[1]))&&/^[A-Za-z]{3,12}$/.test(price[2]));
    assert(country&&country.length>=2&&country.slice(1).every(code=>countries.has(code)));
    const regions=region?.slice(1)??[];
    assert(regions.length<=64&&regions.every(code=>/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code)&&country.slice(1).includes(code.slice(0,2))));
    const location=single(event.tags,'location'),g=single(event.tags,'g');
    assert(!location||location.length===2&&location[1].trim()&&Array.from(location[1]).length<=240);
    assert(!g||g.length===2&&/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(g[1]));
    assert(service[1]!=='pickup'||location||g);
    result.option={reference:reference.address,eventId:event.id,author:event.pubkey,identifier:reference.identifier,createdAt:event.created_at,title:title[1].trim(),service:service[1] as ShippingOption['service'],countries:[...new Set(country.slice(1))],regions,price:price[1],currency:price[2].toUpperCase(),...(service[1]==='pickup'&&location?{pickupLocation:location[1]}:{}),...(g?{geohash:g[1]}:{})};
  }catch{result.unsupported=true;result.option=undefined;result.references=[];}
  return result;
}

export function validateShippingOptionEvent(input:Event):ShippingOption {
  const record=parseRecord(verified(input,seconds()));
  assert(input.kind===30406&&!record.unsupported&&record.option);
  return record.option;
}

/** Country coverage only, not a price quote or a package/region eligibility check. */
export function matchesShippingDestination(info:ListingShipping|undefined,value:string,{includeUnknown=false}={}):boolean {
  const country=countryCode(value);if(!country)return false;
  return !!info?.destinations.includes(country)||includeUnknown&&(!info||info.unknown);
}

/** Feed this only listings already verified by parseEvent/MarketRelayClient. */
export function createShippingResolver({query,now=seconds}:{query:ShippingQuery;now?:()=>number}) {
  const records=new Map<string,RecordValue>(),byEventId=new Map<string,RecordValue>(),addressDeletes=new Map<string,Deletion>(),eventDeletes=new Map<string,Deletion>();
  const checkedUntil=new Map<string,number>(),completeReferences=new Map<string,boolean>();
  function removed(record:RecordValue):boolean {
    const byAddress=addressDeletes.get(record.reference.address),byId=eventDeletes.get(record.event.id);
    return !![byAddress,byId].some(item=>item?.author===record.event.pubkey&&item.at>=record.event.created_at);
  }
  function usable(record:RecordValue):boolean {return record.active&&(record.expiration===null||record.expiration>now())&&!removed(record);}
  function forListing(listing:ListingInput):ListingShipping {
    const info:ListingShipping={destinations:[],options:[],pickupAvailable:false,unknown:false};
    if(listing.status!=='active'||listing.expiration!==null&&listing.expiration<=now())return info;
    const refs=references(listing.originalTags);info.unknown=refs.truncated||!refs.references.length;
    const options=new Map<string,ShippingOption>();
    function visit(ref:ShippingReference,depth:number){
      const record=records.get(ref.address);if(!record){info.unknown=true;return;}
      if(!usable(record))return;
      if(record.unsupported){info.unknown=true;return;}
      if(record.option)options.set(ref.address,record.option);
      else if(depth===0){info.unknown ||= record.truncated;for(const child of record.references)visit(child,1);}
    }
    for(const ref of refs.references)visit(ref,0);
    info.options=structuredClone([...options.values()]);info.pickupAvailable=info.options.some(option=>option.service==='pickup');
    info.destinations=[...new Set(info.options.filter(option=>option.service!=='pickup').flatMap(option=>option.countries))].sort();return info;
  }
  async function load(listings:readonly ListingInput[],{signal,refresh=false}:{signal?:AbortSignal;refresh?:boolean}={}) {
    if(signal?.aborted)throw cancelled();
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason??cancelled());signal?.addEventListener('abort',abort,{once:true});
    const deadline=Date.now()+SHIPPING_LIMITS.timeoutMs;let timer:ReturnType<typeof setTimeout>;
    const cutoff=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=new Error('Shipping lookup timed out.');reject(error);controller.abort(error);},SHIPPING_LIMITS.timeoutMs);});
    const cancellation=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason??cancelled()),{once:true}));
    // An empty reference set finishes without entering Promise.race.
    void cutoff.catch(()=>{});void cancellation.catch(()=>{});
    const selected=listings.slice(0,SHIPPING_LIMITS.listings),requested=new Map<string,ShippingReference>();
    let limited=listings.length>selected.length,incomplete=false,hasMore=false,queries=0,events=0,bytes=0,reserved=checkedUntil.size;
    function add(ref:ShippingReference){
      if(requested.has(ref.address))return false;
      if(!refresh&&(checkedUntil.get(ref.address)??0)>Date.now()){incomplete ||= completeReferences.get(ref.address)!==true;return false;}
      if(!checkedUntil.has(ref.address)&&reserved>=SHIPPING_LIMITS.records||!records.has(ref.address)&&records.size>=SHIPPING_LIMITS.records){limited=true;return false;}
      if(requested.size>=SHIPPING_LIMITS.references){limited=true;hasMore=true;return false;}
      if(!checkedUntil.has(ref.address))reserved++;
      requested.set(ref.address,ref);return true;
    }
    function admit(input:Event){
      let event:Event;try{event=verified(input,now());}catch{return;}
      if(event.kind===5){
        // Deletions only affect explicitly queried addresses/events by their owner.
        for(const tag of event.tags){
          const ref=tag[0]==='a'?requested.get(tag[1]):undefined;
          const candidate=tag[0]==='e'?byEventId.get(tag[1]):undefined;
          const target=candidate&&requested.has(candidate.reference.address)?candidate:undefined;
          const author=ref?.author??target?.event.pubkey;if(author!==event.pubkey)continue;
          const store=ref?addressDeletes:eventDeletes,key=ref?.address??target.event.id,previous=store.get(key);
          if(!previous&&store.size>=SHIPPING_LIMITS.deletions){limited=true;continue;}
          if(!previous||event.created_at>previous.at)store.set(key,{author,at:event.created_at});
        }
        return;
      }
      let record:RecordValue;try{record=parseRecord(event);}catch{return;}
      if(!requested.has(record.reference.address))return;
      const previous=records.get(record.reference.address);
      if(!previous&&records.size>=SHIPPING_LIMITS.records){limited=true;return;}
      if(newer(event,previous?.event)){if(previous)byEventId.delete(previous.event.id);records.set(record.reference.address,record);byEventId.set(event.id,record);}
    }
    async function run(filters:Filter[]){
      if(!filters.length)return null;if(controller.signal.aborted)throw controller.signal.reason;
      if(queries++>=SHIPPING_LIMITS.queries||events>=SHIPPING_LIMITS.events||bytes>=SHIPPING_LIMITS.queryBytes){limited=true;return null;}
      const report=await Promise.race([query(filters,{signal:controller.signal,deadline,limit:Math.min(512,SHIPPING_LIMITS.events-events),cache:'cache-first'}),cutoff,cancellation]);
      if(controller.signal.aborted)throw controller.signal.reason;
      incomplete ||= report.complete!==true;const accepted:Event[]=[];
      for(const event of report.events){
        if(++events>SHIPPING_LIMITS.events){limited=true;break;}
        if(typeof event?.content!=='string'||event.content.length>SHIPPING_LIMITS.eventBytes||!Array.isArray(event.tags)||event.tags.length>128||!event.tags.every(tag=>Array.isArray(tag)&&tag.length<=256&&tag.every(value=>typeof value==='string'&&value.length<=2048))){limited=true;continue;}
        if(event.tags.reduce((size,tag)=>size+tag.reduce((sum,value)=>sum+value.length,0),event.content.length)>SHIPPING_LIMITS.eventBytes){limited=true;continue;}
        let size:number;try{size=encoder.encode(JSON.stringify(event)).length;}catch{continue;}
        bytes+=size;if(bytes>SHIPPING_LIMITS.queryBytes){limited=true;break;}accepted.push(event);
      }
      // Apply revisions before ID deletions regardless of result arrival order.
      for(const event of accepted.filter(event=>event?.kind!==5))admit(event);
      for(const event of accepted.filter(event=>event?.kind===5))admit(event);
      return report;
    }
    async function lookup(refs:ShippingReference[]){
      for(let offset=0;offset<refs.length;offset+=32){const group=refs.slice(offset,offset+32),report=await run(group.flatMap(ref=>[
        {kinds:[ref.kind],authors:[ref.author],'#d':[ref.identifier],limit:8},
        {kinds:[5],authors:[ref.author],'#a':[ref.address],limit:8},
      ]));if(report)for(const ref of group){checkedUntil.set(ref.address,Date.now()+(report.complete===true?60000:5000));completeReferences.set(ref.address,report.complete===true);}}
    }
    async function lookupIdDeletions(refs:ShippingReference[]){
      const observed=refs.flatMap(ref=>{const record=records.get(ref.address);return record?[record.event]:[];});
      for(let offset=0;offset<observed.length;offset+=64){
        const group=observed.slice(offset,offset+64),report=await run([{kinds:[5],authors:[...new Set(group.map(event=>event.pubkey))],'#e':group.map(event=>event.id),limit:128}]);
        if(report?.complete!==true)for(const event of group){const ref=byEventId.get(event.id)?.reference.address;if(ref){completeReferences.set(ref,false);checkedUntil.set(ref,Date.now()+5000);}}
      }
    }
    try{
      const roots=new Map<string,ShippingReference>();
      for(const listing of selected){if(listing.status!=='active'||listing.expiration!==null&&listing.expiration<=now())continue;const refs=references(listing.originalTags);limited ||= refs.truncated;for(const ref of refs.references){roots.set(ref.address,ref);add(ref);}}
      const first=[...requested.values()];await lookup(first);
      // Check ID deletions before following a collection's provider references.
      await lookupIdDeletions(first);
      const children:ShippingReference[]=[];
      for(const ref of roots.values()){const record=records.get(ref.address);if(ref.kind===30405&&record&&usable(record)&&!record.unsupported){limited ||= record.truncated;for(const child of record.references)if(add(child))children.push(child);}}
      await lookup(children);
      // Address deletions were queried alongside each reference. NIP-09 also
      // permits exact event-ID deletion; request only observed reference winners.
      await lookupIdDeletions(children);
      return {byListing:new Map(selected.map(listing=>[listing.id,forListing(listing)])),incomplete,limited,hasMore};
    }catch(error){
      for(const ref of requested.keys()){completeReferences.set(ref,false);checkedUntil.set(ref,Date.now()+5000);}
      throw error;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
  }
  // Explicit refresh retries even a recently incomplete lookup. Keep signed
  // winners and deletion tombstones so older relay replays cannot resurrect it.
  function invalidate(){checkedUntil.clear();completeReferences.clear();}
  return {load,forListing,invalidate};
}
