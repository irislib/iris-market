import { byId, element as domElement, formFields, setToggleLabel } from './dom.ts';
import { createViewportDiscovery } from './map/discovery.ts';
import publishedCells from './data/map-cells.json' with { type: 'json' };
import { mapCellSelector } from './map/geohash.ts';
const $=byId;
export const darkAppearance = () => document.documentElement.dataset.appearance === 'dark' || (document.documentElement.dataset.appearance !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
export function setupMap({ getListings, getPriceLabel, onSelect, onVisibilityChange = () => {}, onDiscover = () => {}, isDiscoveryLimited = () => false }: {getListings:()=>any[];getPriceLabel:(listing:any)=>string|undefined;onSelect:(listing:any)=>void;onVisibilityChange?:(visible:boolean)=>void;onDiscover?:(cells:string[], observed:string[])=>void;isDiscoveryLimited?:()=>boolean}) {
  let instance, loading, visible = false, disposed = false;
  const mappable=(listings=getListings())=>listings.filter(item=>item.coordinates||item.serviceAreas);
  let selectForViewport:typeof import('./map/index.ts').listingsForViewport;
  const discovery = createViewportDiscovery(onDiscover,{regionalCover:true, observedCells:mapCellSelector(publishedCells)});
  const stats = async () => {
    if (!instance) return;
    const data = await instance.getStorageStats();
    $('map-usage').textContent = `${(data.bytes / 1048576).toFixed(1)} / ${Math.round(data.maxBytes / 1048576)} MB`;
  };
  function paintToggle() {
    const button = $('map-toggle');
    button.setAttribute('aria-pressed', String(visible));
    setToggleLabel(button, visible, 'Map', 'Grid');
  }
  paintToggle();
  async function open() {
    visible = !visible;
    paintToggle();
    $('map-panel').hidden = !visible; $('listings').hidden = visible; onVisibilityChange(visible);
    discovery.setActive(visible);
    if (!visible) return;
    refresh();
    if (instance) { instance.resize(); discovery.update(instance.viewport()); return; }
    if (loading) return;
    $('map-status').textContent = 'Loading map…';
    loading = (async () => {
      try {
        const { createMarketMap, listingsForViewport } = await import('./map/index.ts');
        selectForViewport=listingsForViewport;
        const map = await createMarketMap($('map-canvas'), { listings: mappable(), getPriceLabel, dark: darkAppearance(), cacheMiB: Number($('map-cache').value), onSelect, onViewport: value => {discovery.update(value);if(instance)refresh();}, onError: () => { $('map-status').textContent = 'Map unavailable'; } });
        if (disposed) { await map.destroy(); return; }
        instance = map; await instance.setDark(darkAppearance()); refresh(); await stats();
      } catch { $('map-status').textContent = 'Map unavailable. Close and reopen to try again.'; }
      finally { loading = null; }
    })();
  }
  function refresh() {
    if (!visible || !instance) return;
    const listings = getListings(), located = mappable(listings);
    const inView=selectForViewport(located,instance.viewport());
    instance.setListings(located.length>1000?inView:located);
    $('map-status').textContent = isDiscoveryLimited() ? 'Map listing limit reached for this session.' : inView.length ? `${inView.length} mapped ${inView.length===1?'listing':'listings'} in view` : 'No shared listing locations in view yet.';
  }
  const theme = () => instance?.setDark(darkAppearance()).catch(() => {});
  const watcher = matchMedia('(prefers-color-scheme: dark)'); watcher.addEventListener('change', theme);
  window.addEventListener('market-themechange', theme);
  $('map-toggle').onclick = open;
  $('map-cache').onchange = async () => { try { await instance?.setCacheMiB(Number($('map-cache').value)); await stats(); try { localStorage.setItem('market-map-cache', $('map-cache').value); } catch {} } catch { $('map-status').textContent='Could not change map storage.'; } };
  try { const saved = localStorage.getItem('market-map-cache'); if (['64','128','256','512'].includes(saved)) $('map-cache').value = saved; } catch {}
  $('map-clear').onclick = async () => { try { await instance?.clearCache(); await stats(); } catch { $('map-status').textContent='Could not clear downloaded maps.'; } };
  const interval = setInterval(() => { if (visible) stats().catch(() => {}); }, 5000);
  window.addEventListener('pagehide', () => { disposed = true; discovery.dispose(); clearInterval(interval); watcher.removeEventListener('change', theme); instance?.destroy(); });
  return { refresh, refreshDiscovery: () => discovery.refresh() };
}
