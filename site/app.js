import { setupTheme } from '../web/src/theme.js';
setupTheme();
document.getElementById('copy-install').addEventListener('click',async event=>{
  const button=event.currentTarget;
  try { await navigator.clipboard.writeText(document.getElementById('install-code').textContent); button.textContent='Copied'; }
  catch { button.textContent='Select and copy the commands above'; }
});
