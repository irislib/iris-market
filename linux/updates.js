// Injected only by the installed desktop shell. No web API can run commands.
(function installUpdates() {
  const parent = document.querySelector('#preferences-dialog');
  if (!parent) {
    const observer = new MutationObserver(() => {
      if (document.querySelector('#preferences-dialog')) {
        observer.disconnect();
        installUpdates();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('#desktop-updates')) return;
  const section = document.createElement('section');
  section.id = 'desktop-updates'; section.className = 'settings-section';
  section.innerHTML = '<h3>App updates</h3><p data-version class="small muted"></p><label class="checkbox-label"><input type="checkbox" data-auto>Check automatically</label><p data-status role="status" aria-live="polite"></p><progress data-progress hidden></progress><p data-error class="error" role="alert"></p><div class="detail-actions"><button type="button" class="button primary" data-install hidden>Install update</button><button type="button" class="button primary" data-retry hidden>Retry</button><button type="button" class="button secondary" data-open hidden>Open installer</button><button type="button" class="button secondary" data-check>Check for updates</button></div>';
  const style = document.createElement('style');
  style.textContent = '#desktop-updates progress{display:block;width:100%;height:6px;margin:-4px 0 12px;appearance:none;border:0;border-radius:8px;overflow:hidden;accent-color:var(--accent)}#desktop-updates progress::-webkit-progress-bar{background:var(--soft);border-radius:8px}#desktop-updates progress::-webkit-progress-value{background:var(--accent);border-radius:8px}#desktop-updates progress[hidden]{display:none}#desktop-updates [data-error]:empty{display:none}';
  section.append(style);
  parent.append(section);
  const select = key => section.querySelector(`[data-${key}]`);
  const send = action => window.webkit.messageHandlers.marketUpdates.postMessage(action);
  const preview = new URL(location.href).searchParams.get('preview') === '1';
  for (const action of ['check', 'install', 'retry', 'open']) select(action).onclick = () => send(action);
  select('auto').onchange = () => send(`automatic:${select('auto').checked ? 'on' : 'off'}`);
  const megabytes = bytes => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
  const status = state => {
    const version = state.result?.latest_version;
    const progress = state.progress || {};
    switch (state.step) {
      case 'checking': return 'Checking for updates…';
      case 'current': return 'You’re up to date';
      case 'available': return `Version ${version} is available`;
      case 'fetching': return 'Getting the update…';
      case 'downloading': return progress.total ? `Downloading… ${megabytes(progress.downloaded)} of ${megabytes(progress.total)}` : 'Downloading…';
      case 'verifying': return 'Verifying the update…';
      case 'opening': return 'Opening the installer…';
      case 'handed': return state.installer
        ? `Finish installing in ${state.installer}, then reopen Iris Market.`
        : 'The update is in Downloads → Iris Market Updates. Install it with your package manager, then reopen Iris Market.';
      case 'updated': return `Updated to version ${state.version}`;
      default: return '';
    }
  };
  window.addEventListener('market-update', event => {
    const state = event.detail;
    select('version').textContent = `Version ${state.version}`;
    select('auto').checked = state.automatic;
    select('auto').disabled = preview || state.busy;
    select('check').disabled = preview || state.busy;
    select('install').hidden = state.step !== 'available';
    select('retry').hidden = state.step !== 'failed' || !state.retry;
    select('open').hidden = state.step !== 'handed';
    select('open').textContent = state.hasInstaller ? 'Open installer' : 'Show download';
    select('status').textContent = status(state);
    const bar = select('progress');
    bar.hidden = !['fetching', 'downloading', 'verifying', 'opening'].includes(state.step);
    if (state.step === 'downloading' && state.progress?.total) {
      bar.max = state.progress.total;
      bar.value = state.progress.downloaded;
    } else {
      bar.removeAttribute('value');
    }
    select('error').textContent = state.step === 'failed' ? state.error || '' : '';
  });
  send('state');
})();
