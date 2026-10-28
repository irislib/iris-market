export function setupTheme() {
  const controls = document.querySelectorAll('.theme-select');
  const mode = document.documentElement.dataset.appearance || 'system';
  controls.forEach(select => {
    select.value = mode;
    select.addEventListener('change', () => {
      document.documentElement.dataset.appearance = select.value;
      try { localStorage.setItem('market-appearance', select.value); } catch {}
      controls.forEach(other => other.value = select.value);
    });
  });
}
