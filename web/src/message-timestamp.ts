/** Keep millisecond ordering private; legacy messages retain their second timestamp. */
export function rumorMilliseconds(rumor:{created_at:number;tags:string[][]},at=Date.now()):number|undefined {
  const tags=rumor.tags.filter(tag=>tag[0]==='ms');if(tags.length!==1||!/^\d{1,16}$/.test(tags[0][1]))return;
  const value=Number(tags[0][1]);
  if(Number.isSafeInteger(rumor.created_at)&&rumor.created_at>=0&&Number.isSafeInteger(value)&&value>=0&&value<=at+300000&&Math.abs(value-rumor.created_at*1000)<=300000)return value;
}
export function messageMilliseconds(message:{createdAt:number;createdAtMs?:number}):number {
  return Number.isSafeInteger(message.createdAtMs)&&message.createdAtMs>=0?message.createdAtMs:message.createdAt*1000;
}
