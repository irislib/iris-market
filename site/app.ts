import { setupTheme } from '../web/src/theme.ts';
setupTheme();
document.getElementById('copy-install').addEventListener('click',async event=>{
  const button=event.currentTarget as HTMLButtonElement;
  try { await navigator.clipboard.writeText(document.getElementById('install-code').textContent); button.textContent='Copied'; }
  catch { button.textContent='Select and copy the commands above'; }
});
