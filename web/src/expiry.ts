import {expirationFromInput} from './listing-dates.ts';
const DAY=86400;
export const EXPIRY_CHOICES=Object.freeze([
  {value:'',label:'Never',seconds:0},
  {value:'1d',label:'1 day',seconds:DAY},
  {value:'1w',label:'1 week',seconds:7*DAY},
  {value:'30d',label:'1 month',seconds:30*DAY},
  {value:'90d',label:'3 months',seconds:90*DAY},
  {value:'365d',label:'1 year',seconds:365*DAY},
]);
const valid=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=8.64e12;
/** Relative choices resolve only when creating an unsigned event. Keep does not
 * round or extend an existing signed deadline, even if it has already passed. */
export function expiryFromChoice(choice:unknown,createdAt:number,previous?:number|null):number|undefined {
  if(choice==='keep')return valid(previous)?previous:undefined;
  if(choice===undefined||choice===null||choice==='')return undefined;
  const duration=EXPIRY_CHOICES.find(option=>option.value===choice)?.seconds;
  if(duration){const deadline=createdAt+duration;if(!Number.isSafeInteger(createdAt)||createdAt<0||!valid(deadline))throw Error('Choose a valid expiry duration.');return deadline;}
  // Existing programmatic drafts may still carry the old absolute input format;
  // the creator UI offers relative choices only.
  if(typeof choice==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(choice))return expirationFromInput(choice,createdAt);
  throw Error('Choose when the listing expires.');
}
export function relativeExpiry(deadline:unknown,now=Math.floor(Date.now()/1000)):string|null {
  if(!valid(deadline))return null;
  const seconds=deadline-now;if(seconds<=0)return 'Expired';
  if(seconds<60)return 'Expires in less than a minute';
  for(const [unit,size] of [['year',365*DAY],['month',30*DAY],['week',7*DAY],['day',DAY],['hour',3600],['minute',60]] as const){
    if(seconds>=size){const count=Math.ceil(seconds/size);return `Expires in ${count} ${unit}${count===1?'':'s'}`;}
  }
  return null;
}
