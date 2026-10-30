/** Keep an open reaction chooser stable when asynchronous chat updates replace rows. */
export function createChatPickerState() {
  let scope='',open=new Set<string>(),focus:{messageId:string;label:string}|undefined;
  return {
    capture(nextScope:string,root:HTMLElement){
      if(nextScope!==scope){scope=nextScope;open.clear();focus=undefined;return;}
      open=new Set([...root.querySelectorAll<HTMLDetailsElement>('.chat-reaction-picker[open]')].map(picker=>picker.dataset.messageId).filter(Boolean));
      const active=root.ownerDocument?.activeElement as HTMLElement|null,picker=active?.closest<HTMLDetailsElement>('.chat-reaction-picker');
      focus=picker&&root.contains(picker)&&open.has(picker.dataset.messageId)?{messageId:picker.dataset.messageId,label:active.getAttribute('aria-label')||''}:undefined;
    },
    isOpen:(messageId:string)=>open.has(messageId),
    restoreFocus(root:HTMLElement){if(!focus)return;for(const picker of root.querySelectorAll<HTMLDetailsElement>('.chat-reaction-picker[open]'))if(picker.dataset.messageId===focus.messageId){const target=[...picker.querySelectorAll<HTMLElement>('[aria-label]')].find(node=>node.getAttribute('aria-label')===focus.label);target?.focus({preventScroll:true});break;}},
    reset(){scope='';open.clear();focus=undefined;},
  };
}
/** Reveal choices by scrolling their own message pane, never the document. */
export function revealChatPicker(area:HTMLElement,options:HTMLElement,view=globalThis.window):void {
  const pane=area.getBoundingClientRect(),choice=options.getBoundingClientRect(),top=Math.max(0,pane.top)+6,bottom=Math.min(pane.bottom,view?.innerHeight??pane.bottom)-6;
  if(bottom<=top)return;
  const delta=choice.bottom-choice.top>bottom-top?choice.top-top:choice.bottom>bottom?choice.bottom-bottom:choice.top<top?choice.top-top:0;
  if(delta)area.scrollTop=Math.max(0,Math.min(Math.max(0,area.scrollHeight-area.clientHeight),area.scrollTop+delta));
}
