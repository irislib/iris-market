/** The provider's destination estimate, never an inferred pickup or routing time. */
export function orderArrival(order:{status:string;shipment?:{eta?:number}},now=Math.floor(Date.now()/1000)):{headline:string;at:number;late:boolean}|null {
  const at=order.shipment?.eta;
  if(!['accepted','in-transit'].includes(order.status)||!Number.isSafeInteger(at)||at<=0||at>8640000000000||!Number.isFinite(now))return null;
  const remaining=at-now;
  if(remaining<=0)return {headline:'Taking longer than expected',at,late:true};
  if(remaining<60)return {headline:'Less than a minute',at,late:false};
  const minutes=Math.ceil(remaining/60);
  const days=Math.ceil(minutes/1440);
  const duration=minutes<60?`${minutes} min`:minutes<1440?`${Math.floor(minutes/60)} hr${minutes%60?` ${minutes%60} min`:''}`:`${days} ${days===1?'day':'days'}`;
  return {headline:`About ${duration}`,at,late:false};
}
