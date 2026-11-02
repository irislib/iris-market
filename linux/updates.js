// Injected only by the installed desktop shell. No web API can run commands.
(() => {
  const parent = document.querySelector('#preferences-dialog');
  if (!parent || document.querySelector('#desktop-updates')) return;
  const section = document.createElement('section');
  section.id = 'desktop-updates'; section.className = 'settings-section';
  section.innerHTML = '<h3>App updates</h3><p data-version class="small muted"></p><label><input type="checkbox" data-auto> Check automatically</label><p data-status role="status" aria-live="polite"></p><p data-error role="alert"></p><div class="detail-actions"><button type="button" class="button secondary" data-check>Check for updates</button><button type="button" class="button" data-download hidden>Download update</button><button type="button" class="button" data-open hidden>Open installer</button></div>';
  parent.append(section);
  const select = key => section.querySelector(`[data-${key}]`);
  const send = action => window.webkit.messageHandlers.marketUpdates.postMessage(action);
  const preview = new URL(location.href).searchParams.get('preview') === '1';
  for (const action of ['check', 'download', 'open']) select(action).onclick = () => send(action);
  select('auto').onchange = () => send(`automatic:${select('auto').checked ? 'on' : 'off'}`);
  window.addEventListener('market-update', event => {
    const state = event.detail, result = state.result;
    select('version').textContent = `Version ${state.version}`;
    select('auto').checked = state.automatic;
    select('auto').disabled = preview || state.busy;
    select('check').disabled = preview || state.busy;
    select('download').hidden = state.busy || !result?.available || !!result?.path;
    select('open').hidden = state.busy || !result?.path;
    select('status').textContent = state.busy ? (state.downloading ? 'Downloading update…' : 'Checking for updates…') : result?.path ? 'Update ready to install' : result?.available ? `Version ${result.latest_version} is available` : result ? 'You’re up to date' : '';
    select('error').textContent = state.error || '';
  });
  send('state');
})();
