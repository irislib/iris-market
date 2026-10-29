export type ThemePreference = 'light' | 'dark' | 'system';

const preference = (value: unknown): ThemePreference =>
  value === 'light' || value === 'dark' ? value : 'system';

export function setupTheme() {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const controls = document.querySelectorAll<HTMLSelectElement>('.theme-select');
  const toggles = document.querySelectorAll<HTMLButtonElement>('.theme-toggle');
  const segments = document.querySelectorAll<HTMLButtonElement>('[data-theme-preference]');
  const mode = () => preference(document.documentElement.dataset.appearance);
  const cleanups: (() => void)[] = [];
  function listen(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  }
  function refresh() {
    const current = mode();
    const dark = current === 'dark' || current === 'system' && media.matches;
    controls.forEach(select => { select.value = current; });
    toggles.forEach(button => {
      button.dataset.dark = String(dark);
      button.setAttribute('aria-checked', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    });
    segments.forEach(button => {
      const selected = button.dataset.themePreference === current;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }
  function set(value: unknown) {
    const current = preference(value);
    document.documentElement.dataset.appearance = current;
    try { localStorage.setItem('market-appearance', current); } catch {}
    refresh();
    window.dispatchEvent(new Event('market-themechange'));
  }
  controls.forEach(select => listen(select, 'change', () => set(select.value)));
  toggles.forEach(button => listen(button, 'click', () => set(button.dataset.dark === 'true' ? 'light' : 'dark')));
  segments.forEach(button => {
    listen(button, 'click', () => set(button.dataset.themePreference));
    listen(button, 'keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
      const siblings = [...button.closest('[role="radiogroup"]').querySelectorAll<HTMLButtonElement>('[data-theme-preference]')];
      const index = siblings.indexOf(button);
      const next = key === 'Home' ? 0 : key === 'End' ? siblings.length - 1
        : (index + (key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1) + siblings.length) % siblings.length;
      event.preventDefault();
      set(siblings[next].dataset.themePreference);
      siblings[next].focus();
    });
  });
  listen(media, 'change', () => {
    refresh();
    if (mode() === 'system') window.dispatchEvent(new Event('market-themechange'));
  });
  listen(window, 'storage', event => {
    const changed = event as StorageEvent;
    if (changed.key !== 'market-appearance' && changed.key !== null) return;
    document.documentElement.dataset.appearance = preference(changed.newValue);
    refresh();
    window.dispatchEvent(new Event('market-themechange'));
  });
  document.documentElement.dataset.appearance = mode();
  refresh();
  return { get: mode, set, destroy: () => cleanups.splice(0).forEach(cleanup => cleanup()) };
}
