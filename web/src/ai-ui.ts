import { byId, element as domElement, formFields } from './dom.ts';
import { FeedFilterClient } from './feed-filter/client.ts';
import { searchCondition, listingSearchText } from './search-condition.ts';
const $=byId;
const keyFor = listing => listing.eventId || listing.id;
export function setupAI({ getCandidates, onChange }) {
  const client = new FeedFilterClient();
  let scores = new Map(), showAll = false, busy = false, generation = 0;
  const enabled = () => $('search-mode').value === 'ai';
  const threshold = () => $('ai-model').value === 'qwen35' ? .5 : Number($('ai-threshold').value);
  const refresh = () => {
    const candidates = getCandidates(), active = enabled();
    const reviewed = candidates.filter(l => scores.has(keyFor(l))).length;
    const hidden = candidates.filter(l => (scores.get(keyFor(l)) ?? 1) < threshold()).length;
    const remaining = candidates.length - reviewed;
    $('ai-options').hidden = !active;
    $('ai-summary').hidden = !active || (!reviewed && !busy);
    $('ai-summary-text').textContent = busy ? $('ai-progress').textContent : `${showAll ? 'Showing all · ' : ''}${hidden} hidden · ${reviewed} of ${candidates.length} reviewed`;
    $('ai-show-all').textContent = showAll ? 'Use AI matches' : 'Show all';
    $('ai-show-all').hidden = !hidden;
    $('ai-stop').hidden = !busy;
    $('ai-model').disabled = busy;
    $('ai-threshold').disabled = $('ai-model').value === 'qwen35';
    $('search-run').disabled = busy || (active && (!$('search').value.trim() || !remaining));
    $('search-run').textContent = !active ? 'Search' : busy ? 'Searching…' : client.info ? reviewed ? remaining ? `Search next ${Math.min(12, remaining)}` : 'Search complete' : 'Search with AI' : `Load & search · ${$('ai-model').value === 'deberta' ? '87' : '551'} MB`;
    $('search').placeholder = active ? 'Describe what you’re looking for' : 'Search listings';
  };
  function invalidate({ unload = false } = {}) {
    generation++;
    if (busy || unload) client.dispose();
    busy = false; scores.clear(); showAll = false;
    $('ai-error').textContent = '';
    $('ai-progress').textContent = client.info ? 'Ready' : 'Model not loaded';
    refresh(); onChange();
  }
  async function run() {
    if (!enabled() || busy) { onChange(); return; }
    const query = $('search').value.trim();
    if (!query) return;
    const condition = searchCondition(query), current = ++generation;
    busy = true; showAll = false; $('ai-error').textContent = ''; refresh();
    try {
      if (!client.info) {
        const model = $('ai-model').value;
        await client.load(model, model === 'deberta' ? 'wasm' : 'webgpu', message => {
          if (current === generation) { $('ai-progress').textContent = message; refresh(); }
        });
      }
      if (current !== generation) return;
      const items = getCandidates().filter(l => !scores.has(keyFor(l))).slice(0, 12);
      for (let index = 0; index < items.length; index++) {
        if (current !== generation) return;
        $('ai-progress').textContent = `Reviewing ${index + 1} of ${items.length}…`; refresh();
        const result = await client.classify(condition, listingSearchText(items[index]));
        if (current !== generation) return;
        if (!Number.isFinite(result.score)) throw new Error('The model returned an invalid decision');
        if (scores.size >= 1000) scores.delete(scores.keys().next().value);
        scores.set(keyFor(items[index]), result.score); onChange();
      }
      $('ai-progress').textContent = 'Ready';
    } catch (error) {
      if (current === generation) { scores.clear(); client.dispose(); $('ai-error').textContent = `${error.message || 'Search failed'}. All listings remain visible.`; $('ai-progress').textContent = 'Model not loaded'; }
    } finally { if (current === generation) { busy = false; refresh(); onChange(); } }
  }
  $('search-mode').onchange = () => invalidate();
  $('search').addEventListener('input', () => invalidate());
  $('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
  $('search-run').onclick = run;
  $('ai-model').onchange = () => invalidate({ unload: true });
  $('ai-threshold').onchange = () => { refresh(); onChange(); };
  $('ai-stop').onclick = () => invalidate({ unload: true });
  $('ai-unload').onclick = () => invalidate({ unload: true });
  $('ai-show-all').onclick = () => { showAll = !showAll; refresh(); onChange(); };
  window.addEventListener('pagehide', () => { generation++; client.dispose(); });
  return { enabled, isVisible: listing => !enabled() || showAll || (scores.get(keyFor(listing)) ?? 1) >= threshold(), refresh, stop: () => invalidate({ unload: true }) };
}
