import { FeedFilterClient } from './feed-filter/client.js';
const $ = id => document.getElementById(id);
const decisionKey = l => l.eventId || l.id;
const inputText = l => JSON.stringify({title:l.title, description:l.description, price:l.price, currency:l.currency, side:l.side, location:l.location, category:l.category}).slice(0,2000);
export function setupAI({ getCandidates, onChange }) {
  const client = new FeedFilterClient();
  let decisions = new Map(), loaded = false, showAll = false, busy = false, generation = 0;
  const refresh = () => {
    if (loaded && !client.info) { loaded = false; $('ai-progress').textContent = 'Unloaded after inactivity'; }
    const candidates = getCandidates();
    const hidden = candidates.filter(l => decisions.get(decisionKey(l)) === false).length;
    const reviewed = candidates.filter(l => decisions.has(decisionKey(l))).length;
    $('ai-summary').hidden = !hidden && !busy;
    $('ai-summary-text').textContent = busy ? $('ai-progress').textContent : showAll ? `Showing all · ${hidden} marked less relevant` : `${hidden} hidden · ${reviewed} of ${candidates.length} reviewed`;
    $('ai-show-all').textContent = showAll ? 'Use AI filter' : 'Show all';
    $('ai-show-all').hidden = !hidden;
    $('ai-stop').hidden = !busy;
    $('ai-load').disabled = busy;
    $('ai-filter').disabled = busy || !loaded || !$('ai-condition').value.trim();
    $('ai-model').disabled = busy;
    const count = Math.min(candidates.length - reviewed, 12);
    $('ai-filter').textContent = count ? `${reviewed ? 'Filter next' : 'Filter'} ${count} ${count === 1 ? 'listing' : 'listings'}` : 'All reviewed';
    if (!count) $('ai-filter').disabled = true;
    $('ai-condition').disabled = busy;
  };
  const stop = () => { generation++; busy=false;loaded=false;client.dispose();decisions.clear();showAll=false;$('ai-progress').textContent='Not loaded';refresh();onChange(); };
  function changed() { decisions.clear();showAll=false;$('ai-error').textContent='';refresh();onChange(); }
  $('local-ai').onclick = () => { refresh();$('ai-dialog').showModal(); };
  $('ai-condition').addEventListener('input',changed);
  $('ai-model').onchange = () => { stop();$('ai-load').textContent=`Load model · ${$('ai-model').value==='deberta'?'87':'551'} MB`; };
  $('ai-unload').onclick = stop;
  $('ai-stop').onclick = stop;
  $('ai-show-all').onclick = () => { showAll=!showAll;refresh();onChange(); };
  $('ai-load').onclick = async () => {
    const run=++generation;busy=true;loaded=false;decisions.clear();showAll=false;$('ai-error').textContent='';$('ai-progress').textContent='Preparing model…';refresh();onChange();
    try {
      const model=$('ai-model').value;
      await client.load(model,model==='deberta'?'wasm':'webgpu',message=>{if(run===generation){$('ai-progress').textContent=message;refresh();}});
      if(run!==generation)return;
      loaded=true;$('ai-progress').textContent='Loaded · ready to filter';
    } catch(error) { if(run===generation){$('ai-error').textContent=error.message||'Model could not load';$('ai-progress').textContent='Not loaded';decisions.clear();} }
    finally { if(run===generation){busy=false;refresh();onChange();} }
  };
  $('ai-filter').onclick = async () => {
    if(!loaded)return;
    const condition=$('ai-condition').value.trim();if(!condition)return;
    const items=getCandidates().filter(l=>!decisions.has(decisionKey(l))).slice(0,12),run=++generation;busy=true;showAll=false;$('ai-error').textContent='';refresh();
    try {
      for(let index=0;index<items.length;index++){
        if(run!==generation)return;
        $('ai-progress').textContent=`Filtering ${index+1} of ${items.length}…`;refresh();
        const result=await client.classify(condition,inputText(items[index]));
        if(run!==generation)return;
        if(typeof result.show!=='boolean')throw new Error('The model returned an invalid decision');
        if(decisions.size>=1000)decisions.delete(decisions.keys().next().value);
        decisions.set(decisionKey(items[index]),result.show);onChange();
      }
      $('ai-progress').textContent=`Reviewed ${items.length} listings`;
    } catch(error) { if(run===generation){decisions.clear();loaded=false;client.dispose();$('ai-error').textContent=error.message||'Filtering stopped. All listings remain available.';} }
    finally { if(run===generation){busy=false;refresh();onChange();} }
  };
  window.addEventListener('pagehide',stop);
  return { isVisible: l => showAll || decisions.get(decisionKey(l)) !== false, refresh, stop };
}
