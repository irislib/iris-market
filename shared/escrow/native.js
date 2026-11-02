(() => {
  const pending=new Map();
  let serial=0, screen;
  async function call(method,args={}){
    const request=JSON.stringify({method,args});
    if(window.webkit?.messageHandlers?.escrow){
      const response=JSON.parse(await window.webkit.messageHandlers.escrow.postMessage(request));
      if(response.error)throw Error(response.error);
      return response.result;
    }
    const id=++serial;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      window.IrisNativeEscrow.request(id,request);
    });
  }
  window.escrowAnswer=(id,response)=>{
    const entry=pending.get(id);if(!entry)return;pending.delete(id);
    response.error?entry.reject(Error(response.error)):entry.resolve(response.result);
  };
  const host=document.querySelector('#trade');
  void call('selection').then(selection=>{screen=window.IrisEscrow.mount(host,call,selection);}).catch(()=>{host.textContent='Reopen this trade to continue.';});
  window.escrowRefresh=()=>{screen?.refresh();};
  window.addEventListener('pagehide',()=>{screen?.close();pending.clear();});
})();
