export type Surface = HTMLElement & {readonly open:boolean;showModal():void;close():void;hide():void};
/** One lifecycle for routed pages and short dialogs. Programmatic hide never navigates. */
export function createSurface({className='',label='',pageHost,onOpen=()=>{},onClose=()=>{}}: {className?:string;label?:string;pageHost?:HTMLElement;onOpen?:()=>void;onClose?:()=>void} = {}): Surface {
  const node=document.createElement(pageHost?'section':'dialog') as Surface;
  node.className=className+(pageHost?' app-page':'');if(label)node.setAttribute('aria-label',label);
  if(pageHost){
    node.hidden=true;
    Object.defineProperty(node,'open',{get:()=>!node.hidden});
    node.showModal=()=>{node.hidden=false;onOpen();};
    node.hide=()=>{if(node.hidden)return;node.hidden=true;node.dispatchEvent(new Event('close'));};
    node.close=()=>{node.hide();onClose();};
    pageHost.append(node);
  }else{
    const dialog=node as unknown as HTMLDialogElement;
    node.hide=()=>dialog.close();
    dismissOnBackdrop(dialog);document.body.append(node);
  }
  return node;
}
const wired=new WeakSet<HTMLDialogElement>();
export function dismissOnBackdrop(dialog:HTMLDialogElement):void {
  if(wired.has(dialog))return;wired.add(dialog);
  let downOutside=false;
  const outside=(event:MouseEvent)=>{const r=dialog.getBoundingClientRect();return event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',event=>{downOutside=outside(event);});
  dialog.addEventListener('click',event=>{if(downOutside&&outside(event))dialog.close();downOutside=false;});
  // Native <dialog> handles Escape and restores focus to its opener.
}
