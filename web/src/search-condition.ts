import {matchesSingleTermSearch} from './lexical-search.ts';

// A bare word is a topic; longer searches retain the user's full intent.
export const isTopicSearch = value => /^[\p{L}\p{N}_-]+$/u.test(String(value ?? '').trim());
export function searchCondition(value,model='deberta') {
  const query = String(value ?? '').trim().slice(0, 500);
  if(isTopicSearch(query))return model==='deberta'?`The item being offered is ${query}.`:`This text is about ${query}.`;
  // NLI needs a concrete proposition, rather than a statement about a search.
  // Keep the query intact; this is the same template for every subject.
  return model==='deberta'?`This listing offers ${query}.`:`This listing matches this search: ${query}`;
}
export function listingSearchText(listing) {
  const title=String(listing.title??'').trim().slice(0,500);
  const heading=listing.side==='request'?`Wanted: ${title}`:listing.side==='offer'?`Offered: ${title}`:title;
  const metadata=[];
  for(const [label,value] of [['Category',listing.category],['Location',listing.location]]){
    if(value!==undefined&&value!==null&&String(value).trim())metadata.push(`${label}: ${String(value).trim()}`);
  }
  const price=listing.price===undefined||listing.price===null?'':String(listing.price).trim();
  if(price)metadata.push(`Price: ${price}${listing.currency&&String(listing.currency).trim()?` ${String(listing.currency).trim()}`:''}`);
  // Reserve room for real constraints before bounding a long description.
  const fixed=[heading,...metadata].filter(Boolean).join('\n');
  const description=String(listing.description??'').trim().slice(0,Math.max(0,2000-fixed.length-1));
  return [heading,description,...metadata].filter(Boolean).join('\n').slice(0,2000);
}

/** A short title can entail an unrelated topic on its own, especially when
 * the model doesn't understand the language. Corroborate product identity
 * against what the listing actually offers or requests. */
export function listingSearchEvidence(listing,query:string,model='deberta') {
  const topic=query.trim().slice(0,500);
  if(model!=='deberta'||!isTopicSearch(topic))
    return [{condition:searchCondition(topic,model),text:listingSearchText(listing)}];

  const title=String(listing.title??'').trim().slice(0,500);
  const description=String(listing.description??'').trim().slice(0,350);
  const tags=(listing.tags?.length?listing.tags:[listing.category])
    .filter(tag=>typeof tag==='string'&&tag.trim()).slice(0,16).map(tag=>tag.trim().slice(0,60));
  const category=tags.length?` Category: ${tags.join(', ')}.`:'';
  const wanted=listing.side==='request';
  const heading=`${wanted?'Item wanted':'Item for sale'}: ${title||description}.`;
  const identity=tags.some(tag=>matchesSingleTermSearch(tag,topic))
    ?`The item being ${wanted?'requested':'offered'} is ${topic}.`:`This item is ${topic}.`;
  return [
    {condition:identity,text:heading+category},
    {condition:`This listing ${wanted?'requests':'offers'} ${topic}.`,
      text:heading+(title&&description?' '+description:'')+category},
  ];
}

export async function scoreSearchListing(listing,query:string,model:string,
  classify:(condition:string,text:string)=>Promise<{score:number;cached?:boolean}>,signal?:AbortSignal,minimumScore=0) {
  const evidence=listingSearchEvidence(listing,query,model);
  let product=1,cached=true;
  for(const [index,{condition,text}] of evidence.entries()){
    signal?.throwIfAborted();
    const result=await classify(condition,text);
    if(!Number.isFinite(result.score)||result.score<0||result.score>1)throw Error('The model returned an invalid decision');
    product*=result.score;
    cached&&=!!result.cached;
    // The second score is at most 1. Even that cannot rescue this listing.
    if(index===0&&evidence.length===2&&Math.sqrt(product)<minimumScore)return {score:null,cached};
  }
  return {score:evidence.length===1?product:Math.sqrt(product),cached};
}
