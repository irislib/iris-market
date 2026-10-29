import { byId, element as domElement, formFields } from './dom.ts';
import { createViewportDiscovery } from './map/discovery.ts';
const $=byId;
export const darkAppearance = () => document.documentElement.dataset.appearance === 'dark' || (document.documentElement.dataset.appearance !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
export function setupMap({ getListings, onSelect, onVisibilityChange = () => {}, onDiscover = () => {}, isDiscoveryLimited = () => false }: {getListings:()=>any[];onSelect:(listing:any)=>void;onVisibilityChange?:(visible:boolean)=>void;onDiscover?:(cells:string[])=>void;isDiscoveryLimited?:()=>boolean}) {
  let instance, loading, visible = false, disposed = false;
  const discovery = createViewportDiscovery(onDiscover);
  const stats = async () => {
    if (!instance) return;
    const data = await instance.getStorageStats();
    $('map-usage').textContent = `${(data.bytes / 1048576).toFixed(1)} / ${Math.round(data.maxBytes / 1048576)} MB`;
  };
  async function open() {
    visible = !visible;
    $('map-toggle').setAttribute('aria-pressed', String(visible));
    $('map-toggle').textContent = visible ? 'Grid' : 'Map';
    $('map-panel').hidden = !visible; $('listings').hidden = visible; onVisibilityChange(visible);
    discovery.setActive(visible);
    if (!visible) return;
    refresh();
    if (instance) { instance.resize(); discovery.update(instance.viewport()); return; }
    if (loading) return;
    $('map-status').textContent = 'Loading map from Hashtree…';
    loading = (async () => {
      try {
        const { createMarketMap } = await import('./map/index.ts');
        const map = await createMarketMap($('map-canvas'), { listings: getListings(), dark: darkAppearance(), cacheMiB: Number($('map-cache').value), onSelect, onViewport: value => discovery.update(value), onError: error => { $('map-status').textContent = error.message; } });
        if (disposed) { await map.destroy(); return; }
        instance = map; await instance.setDark(darkAppearance()); refresh(); await stats();
      } catch (error) { $('map-status').textContent = `Map unavailable: ${error.message}. Close and reopen Map to retry.`; }
      finally { loading = null; }
    })();
  }
  function refresh() {
    if (!visible || !instance) return;
    const listings = getListings(), located = listings.filter(item => item.coordinates).length;
    instance.setListings(listings);
    $('map-status').textContent = isDiscoveryLimited() ? 'Listing limit reached. Narrow your search in Filters to find more.' : `${located} of ${listings.length} listings have a shared map location`;
  }
  const theme = () => instance?.setDark(darkAppearance()).catch(() => {});
  const watcher = matchMedia('(prefers-color-scheme: dark)'); watcher.addEventListener('change', theme);
  window.addEventListener('market-themechange', theme);
  $('map-toggle').onclick = open;
  $('map-cache').onchange = async () => { try { await instance?.setCacheMiB(Number($('map-cache').value)); await stats(); try { localStorage.setItem('market-map-cache', $('map-cache').value); } catch {} } catch(error) { $('map-status').textContent=error.message; } };
  try { const saved = localStorage.getItem('market-map-cache'); if (['64','128','256','512'].includes(saved)) $('map-cache').value = saved; } catch {}
  $('map-clear').onclick = async () => { try { await instance?.clearCache(); await stats(); } catch(error) { $('map-status').textContent=error.message; } };
  const interval = setInterval(() => { if (visible) stats().catch(() => {}); }, 5000);
  window.addEventListener('pagehide', () => { disposed = true; discovery.dispose(); clearInterval(interval); watcher.removeEventListener('change', theme); instance?.destroy(); });
  return { refresh, refreshDiscovery: () => discovery.refresh() };
}
