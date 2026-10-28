import { createMarketMap } from './map/index.js';
const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
let instance, listings = [], dark = params.get('theme') === 'dark', disposed = false;
const send = (type, id) => {
  if (window.webkit?.messageHandlers?.marketMap) window.webkit.messageHandlers.marketMap.postMessage({ type, ...(id ? {id} : {}) });
  else if (type === 'ready') window.MarketMapBridge?.ready();
  else if (type === 'select') window.MarketMapBridge?.select(id);
};
const cleanListings = value => Array.isArray(value) ? value.slice(0, 1000).filter(item => item && typeof item.id === 'string' && item.id.length <= 225 && typeof item.title === 'string' && Array.isArray(item.coordinates) && item.coordinates.length === 2 && item.coordinates.every(Number.isFinite) && Math.abs(item.coordinates[0]) <= 180 && Math.abs(item.coordinates[1]) <= 90).map(({id,title,coordinates})=>({id,title:title.slice(0,160),coordinates})) : [];
window.marketMap = Object.freeze({
  setListings(value) { listings = cleanListings(value); instance?.setListings(listings); },
  setDark(value) { dark = !!value; document.documentElement.dataset.appearance = dark ? 'dark' : 'light'; instance?.setDark(dark).catch(showError); },
});
function showError(error) { $('map-status').textContent = error.message || 'Map unavailable'; }
async function stats() { if (!instance) return; const data = await instance.getStorageStats(); $('map-usage').textContent = `${(data.bytes / 1048576).toFixed(1)} / ${Math.round(data.maxBytes / 1048576)} MB`; }
window.marketMap.setDark(dark);
$('map-cache').value = ['64','128','256','512'].includes(params.get('cache')) ? params.get('cache') : '512';
$('map-cache').onchange = async () => { try { await instance?.setCacheMiB(Number($('map-cache').value)); await stats(); } catch(error) { showError(error); } };
$('map-clear').onclick = async () => { try { await instance?.clearCache(); await stats(); } catch(error) { showError(error); } };
send('ready');
createMarketMap($('map-canvas'), { listings, dark, cacheMiB: Number($('map-cache').value), onSelect: listing => send('select', listing.id), onError: showError })
.then(async map => { if(disposed) { await map.destroy(); return; } instance = map; map.setListings(listings); await map.setDark(dark); $('map-status').textContent = 'Approximate locations shared by authors'; await stats(); send('ready'); }).catch(error => { if(!disposed) showError(error); });
const interval = setInterval(() => stats().catch(() => {}), 5000);
window.addEventListener('pagehide', () => { disposed = true; clearInterval(interval); instance?.destroy(); });
