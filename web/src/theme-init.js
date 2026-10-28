(() => {
  let mode = 'system';
  try { mode = localStorage.getItem('market-appearance') || 'system'; } catch {}
  if (!['system','light','dark'].includes(mode)) mode = 'system';
  document.documentElement.dataset.appearance = mode;
})();
