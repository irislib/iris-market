export function setupTheme() {
  const media=matchMedia('(prefers-color-scheme: dark)');
  const controls=document.querySelectorAll<HTMLSelectElement>('.theme-select');
  const toggles=document.querySelectorAll<HTMLButtonElement>('.theme-toggle');
  const mode=()=>document.documentElement.dataset.appearance||'system';
  function refresh(){
    const dark=mode()==='dark'||mode()==='system'&&media.matches;
    controls.forEach(select=>{select.value=mode();});
    toggles.forEach(button=>{button.dataset.dark=String(dark);button.setAttribute('aria-checked',String(dark));button.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');});
  }
  function set(value){document.documentElement.dataset.appearance=value;try{localStorage.setItem('market-appearance',value)}catch{}refresh();window.dispatchEvent(new Event('market-themechange'));}
  controls.forEach(select=>select.addEventListener('change',()=>set(select.value)));
  toggles.forEach(button=>button.addEventListener('click',()=>set(button.dataset.dark==='true'?'light':'dark')));
  media.addEventListener('change',()=>{refresh();if(mode()==='system')window.dispatchEvent(new Event('market-themechange'));});
  const settings=document.getElementById('preferences-dialog') as HTMLDialogElement;
  document.getElementById('appearance-settings')?.addEventListener('click',()=>settings?.showModal());
  settings?.querySelector('.dialog-close')?.addEventListener('click',()=>settings.close());
  refresh();
}
