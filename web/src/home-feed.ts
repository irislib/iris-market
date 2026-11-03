import defaults from '../../shared/home-feed.json' with {type:'json'};
import {MAX_CONDITION_LENGTH} from './feed-filter/models.ts';

export const HOME_FEED_STORAGE_KEY='market-home-feed-v1';
export const DEFAULT_HOME_FEED_PROMPT=defaults.prompt;
export interface HomeFeedPreferences {enabled:boolean;prompt:string}
export interface HomeCondition {condition:string; exclude?:boolean; productConfirmation?:string}
export function homeProductText(listing:{title:string;tags?:string[];category?:string}):string {
  const tags=listing.tags??[listing.category];
  return [listing.title.trim().slice(0,500),tags.filter(tag=>typeof tag==='string'&&tag.trim()).slice(0,16).map(tag=>tag.trim().slice(0,60)).join(', ')].filter(Boolean).join('\n');
}
export function homeFeedConditions(prompt:string,model:string):HomeCondition[] {
  // The small entailment model needs a proposition it can check against the
  // offer itself. Instruction-following models receive the full preference.
  if(model==='deberta'&&prompt===DEFAULT_HOME_FEED_PROMPT){
    const supervised='The seller offers prescription medicines, injectable hormones or anabolic steroids.';
    return [{condition:'Someone is offering or looking for a useful item or service.'},
      {condition:'This listing promotes spam, deception, exploitation or harmful claims.',exclude:true},
      {condition:supervised,exclude:true},
      {condition:supervised,exclude:true,productConfirmation:'This product is a drug.'}];
  }
  const prefix=model==='deberta'?'This listing offers ':'This listing fits these home-feed preferences: ';
  const limit=MAX_CONDITION_LENGTH-prefix.length-1;
  const conditions:HomeCondition[]=[];
  let rest=prompt.trim();
  while(rest.length>limit){
    const space=rest.lastIndexOf(' ',limit);
    const end=space>0?space:limit;
    conditions.push({condition:prefix+rest.slice(0,end)+'.'});
    rest=rest.slice(end).trimStart();
  }
  if(rest)conditions.push({condition:prefix+rest+'.'});
  return conditions;
}
export function homeFeedPreferences(value?:Partial<HomeFeedPreferences>):HomeFeedPreferences {
  return {enabled:value?.enabled!==false,prompt:typeof value?.prompt==='string'&&value.prompt.trim() && value.prompt.trim()!==defaults.previousPrompt?value.prompt.trim().slice(0,1000):DEFAULT_HOME_FEED_PROMPT};
}
export function loadHomeFeed(storage:Pick<Storage,'getItem'>):HomeFeedPreferences {
  try{return homeFeedPreferences(JSON.parse(storage.getItem(HOME_FEED_STORAGE_KEY)||'{}'));}catch{return homeFeedPreferences();}
}
export function saveHomeFeed(storage:Pick<Storage,'setItem'>,value:HomeFeedPreferences):HomeFeedPreferences {
  const preferences=homeFeedPreferences(value);storage.setItem(HOME_FEED_STORAGE_KEY,JSON.stringify(preferences));return preferences;
}
