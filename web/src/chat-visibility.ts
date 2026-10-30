import {readingSurface} from './notifications.ts';
/** Read receipts require rendered incoming rows intersecting both the scroll area and viewport. */
export function visibleChatMessageIds(surface:Element&{open:boolean},area:HTMLElement,doc=document,view=globalThis.window):string[] {
  if(!readingSurface(surface,doc)||!area?.getBoundingClientRect)return[];
  const box=area.getBoundingClientRect(),top=Math.max(0,box.top),bottom=Math.min(view?.innerHeight??box.bottom,box.bottom),left=Math.max(0,box.left),right=Math.min(view?.innerWidth??box.right,box.right);
  if(bottom<=top||right<=left)return[];
  return [...area.querySelectorAll<HTMLElement>('[data-message-id]')].filter(row=>{
    if(row.dataset.mine==='true'||!row.getBoundingClientRect)return false;
    const bounds=row.getBoundingClientRect(),height=Math.min(bounds.bottom,bottom)-Math.max(bounds.top,top);
    return height>=Math.min(24,(bounds.bottom-bounds.top)/2)&&bounds.right>left&&bounds.left<right;
  }).map(row=>row.dataset.messageId).filter(Boolean).slice(0,128);
}
