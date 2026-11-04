import type {Rumor} from 'nostr-double-ratchet';
import {rumorMilliseconds} from '../message-timestamp.ts';

export type Retention = {mode:'follow'} | {mode:'keep'} | {mode:'expire';seconds:number};
export type Timer = {seconds:number|null;ms:number;id:string};
export const follow:Retention = {mode:'follow'};
export function validSeconds(n:unknown):n is number {
  return typeof n==='number' && Number.isSafeInteger(n) && n>0 && n<=0xffffffff;
}
export function validRetention(p:Retention) {
  return p?.mode==='follow'||p?.mode==='keep'||p?.mode==='expire'&&validSeconds(p.seconds);
}
export function deadline(p:Retention, m:{createdAt:number;expiresAt?:number}) {
  return p.mode==='keep' ? undefined : p.mode==='expire' ? m.createdAt+p.seconds : m.expiresAt;
}
export function timerFromRumor(r:Rumor):Timer|undefined {
  if(r.created_at>Math.floor(Date.now()/1000)+300)return;
  try {
    const p=JSON.parse(r.content);
    if(p?.type!=='chat-settings'||p.v!==1||!(p.messageTtlSeconds==null || validSeconds(p.messageTtlSeconds)))return;
    return {seconds:p.messageTtlSeconds??null,ms:rumorMilliseconds(r)??r.created_at*1000,id:r.id};
  } catch {return;}
}
export function durationLabel(seconds:number|null|undefined):string {
  if (!seconds) return 'Off';
  for(const [name,unit] of [['day',86400],['hour',3600],['minute',60],['second',1]] as const) {
    if(seconds%unit===0){const n=seconds/unit;return n+' '+name+(n===1?'':'s');}
  }
}
