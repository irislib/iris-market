import { setupTheme } from '../web/src/theme.ts';
setupTheme();
const preferences = document.querySelector<HTMLDialogElement>('#preferences-dialog');
document.getElementById('appearance-settings').addEventListener('click', () => preferences.showModal());
preferences.querySelector('.dialog-close').addEventListener('click', () => preferences.close());
document.getElementById('copy-install').addEventListener('click',async event=>{
  const button=event.currentTarget as HTMLButtonElement;
  try { await navigator.clipboard.writeText(document.getElementById('install-code').textContent); button.textContent='Copied'; }
  catch { button.textContent='Select and copy the commands above'; }
});
