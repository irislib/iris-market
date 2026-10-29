import { verifyEvent, type Event } from 'nostr-tools/pure'

export type SearchTagExpansion = 'literal' | 'expanded'

export const TAG_LIMITS=Object.freeze({tags:512,events:2048,perEvent:16,authors:64,pairs:2048,queryTags:8,queryChars:2000,literalTags:4})
const generic=new Set(['nostr','market','marketplace','forsale','for sale','sale','sell','selling','buy','buying','offer','request','bitcoin','sats'])
const normal=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/^#+/,'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim()
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0
const tokens=(value:string)=>normal(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
const phrase=(query:string,term:string)=>` ${query} `.includes(` ${term} `)
const stopWords=new Set(['a','an','the','and','or','for','with','to','in','on','at','of','from','by','near','under','over','around','is','are','my','me','i','want','looking','find','show','please','that','can','ja','tai','alle','yli'])
/** Literal retrieval needs no previously observed inventory or model response. */
export function literalSearchTags(query:string):string[]{
  if(typeof query!=='string'||query.length>TAG_LIMITS.queryChars)return[]
  const words=tokens(query),text=words.join(' ')
  const valid=(tag:string)=>!!tag&&Array.from(tag).length<=60
  return [...new Set([...(valid(text)?[text]:[]),...words.filter(word=>valid(word)&&word.length>1&&!/^\d+$/.test(word)&&!stopWords.has(word))])].slice(0,TAG_LIMITS.literalTags)
}
interface Tag {spellings:Map<string,Set<string>>;authors:Set<string>}

/** Ephemeral, bounded public evidence. No queries, identities or browsing history are persisted. */
export class SeenTags {
  private tags=new Map<string,Tag>()
  private events=new Set<string>()
  private pairs=new Map<string,Set<string>>()
  observe(input:Event,now=Math.floor(Date.now()/1000)):boolean {
    try{
      if(input?.kind!==30402||this.events.has(input.id)||!Array.isArray(input.tags)||input.tags.length>2048||!Number.isSafeInteger(input.created_at)||input.created_at<0||input.created_at>now+300)return false
      const event={id:input.id,pubkey:input.pubkey,created_at:input.created_at,kind:input.kind,content:input.content,tags:input.tags.map(tag=>[...tag]),sig:input.sig}
      if(JSON.stringify(event).length>65536||!verifyEvent(event)||event.tags.filter(tag=>tag[0]==='d'&&tag[1]).length!==1||event.tags.filter(tag=>tag[0]==='title'&&tag[1]).length!==1)return false
      this.events.add(event.id);if(this.events.size>TAG_LIMITS.events)this.events.delete(this.events.values().next().value)
      const selected=new Map<string,string>()
      for(const tag of event.tags){
        if(tag[0]!=='t'||typeof tag[1]!=='string'||tag[1].startsWith('market:')||tag[1].length>60||/[\p{C}]/u.test(tag[1]))continue
        const key=normal(tag[1]);if(!key||/^\d+$/.test(key)||generic.has(key)||selected.has(key))continue
        if(selected.size>=TAG_LIMITS.perEvent)break
        selected.set(key,tag[1])
      }
      const admitted:string[]=[]
      for(const [key,spelling] of selected){
        let entry=this.tags.get(key)
        if(!entry){if(this.tags.size>=TAG_LIMITS.tags)continue;entry={spellings:new Map(),authors:new Set()};this.tags.set(key,entry)}
        if(entry.authors.size<TAG_LIMITS.authors)entry.authors.add(event.pubkey)
        let users=entry.spellings.get(spelling)
        if(!users&&entry.spellings.size<3){users=new Set();entry.spellings.set(spelling,users)}
        if(users&&users.size<TAG_LIMITS.authors)users.add(event.pubkey)
        admitted.push(key)
      }
      for(let i=0;i<admitted.length;i++)for(let j=i+1;j<admitted.length;j++){
        const pair=[admitted[i],admitted[j]].sort(compare).join('\0')
        let users=this.pairs.get(pair)
        if(!users){if(this.pairs.size>=TAG_LIMITS.pairs)continue;users=new Set();this.pairs.set(pair,users)}
        if(users.size<TAG_LIMITS.authors)users.add(event.pubkey)
      }
      return admitted.length>0
    }catch{return false}
  }
  has(spelling:string):boolean{return this.tags.get(normal(spelling))?.spellings.has(spelling)??false}
  entries(){return [...this.tags].map(([key,entry])=>({tag:key,authors:entry.authors.size,spellings:[...entry.spellings.keys()].sort(compare)})).sort((a,b)=>b.authors-a.authors||compare(a.tag,b.tag))}
  stats(){return{tags:this.tags.size,events:this.events.size,pairs:this.pairs.size}}
  /** Only alternate relay spellings of the same normalized literal, never related tags. */
  selectLiteral(query:string):string[]{
    const literal=literalSearchTags(query),selected=[...literal]
    for(const tag of literal){
      const entry=this.tags.get(normal(tag));if(!entry)continue
      for(const spelling of [...entry.spellings.keys()].sort(compare)){
        if(selected.length>=TAG_LIMITS.queryTags)return selected
        if(!selected.includes(spelling))selected.push(spelling)
      }
    }
    return selected
  }
  select(query:string,limit=TAG_LIMITS.queryTags,extraTags:readonly string[]=[]):string[]{
    if(typeof query!=='string'||query.length>TAG_LIMITS.queryChars||!Number.isInteger(limit)||limit<1||limit>TAG_LIMITS.queryTags)return[]
    const words=tokens(query),text=words.join(' ');if(!text)return[]
    const literal=literalSearchTags(query).slice(0,limit),requested=new Set(Array.isArray(extraTags)?extraTags.slice(0,TAG_LIMITS.queryTags).filter(tag=>typeof tag==='string'&&tag.length<=60).map(normal):[])
    const scored=new Map<string,number>()
    for(const [tag] of this.tags){
      const parts=tokens(tag),clean=parts.join(' ')
      const direct=phrase(text,clean)||parts.some(word=>word.length>=3&&words.includes(word))
      if(direct||requested.has(tag))scored.set(tag,direct?100:90)
    }
    // At most two weaker expansions, backed by two distinct authors, avoid a
    // single merchant's broad tag list turning every search into all inventory.
    const adjacent=new Map<string,number>()
    for(const [pair,authors] of this.pairs){
      if(authors.size<2)continue
      const [a,b]=pair.split('\0')
      if((scored.get(a)??0)>=60&&!scored.has(b))adjacent.set(b,Math.max(adjacent.get(b)??0,authors.size))
      if((scored.get(b)??0)>=60&&!scored.has(a))adjacent.set(a,Math.max(adjacent.get(a)??0,authors.size))
    }
    for(const [tag,count] of [...adjacent].sort((a,b)=>b[1]-a[1]||compare(a[0],b[0])).slice(0,2))scored.set(tag,20+Math.min(20,count))
    const candidates=[...scored].flatMap(([key,score])=>[...this.tags.get(key)!.spellings].map(([tag,authors])=>({tag,score,authors:authors.size})))
    const selected=[...literal]
    for(const item of candidates.sort((a,b)=>b.score-a.score||b.authors-a.authors||compare(a.tag,b.tag))){
      if(selected.length>=limit)break
      if(selected.includes(item.tag))continue
      selected.push(item.tag)
    }
    return selected
  }
}

export const observedMarketTags=new SeenTags()
