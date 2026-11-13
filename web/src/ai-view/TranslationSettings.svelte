<script lang="ts">
  import {onDestroy} from 'svelte'
  import {addReadLanguage, onTranslationPreferences, removeReadLanguage, setAutoTranslate, setTranslationTarget, translationSettingsView} from '../translation.ts'

  // Preferences live in translation.ts and other tabs; bump this to re-read them.
  let version = $state(0)
  onDestroy(onTranslationPreferences(() => { version++ }))
  const view = $derived.by(() => { void version; return translationSettingsView() })

  function addLanguage(event: Event & {currentTarget: HTMLSelectElement}) {
    const picker = event.currentTarget
    addReadLanguage(picker.value)
    picker.value = ''
  }
</script>

<section class="translation-settings">
  <h3>Translation</h3>
  <label><input type="checkbox" checked={view.auto} onchange={event => setAutoTranslate(event.currentTarget.checked)}> Always translate</label>
  <label>Translate into <select value={view.target} onchange={event => setTranslationTarget(event.currentTarget.value)}>
    <option value="">{view.deviceLabel}</option>
    {#each view.targets as item (item.code)}<option value={item.code}>{item.name}</option>{/each}
  </select></label>
  <label>Languages I read <select onchange={addLanguage}>
    <option value="">Add a language…</option>
    {#each view.readable as item (item.code)}<option value={item.code}>{item.name}</option>{/each}
  </select></label>
  <div class="translation-read-languages">
    {#each view.read as item (item.code)}<button class="text-button" type="button" aria-label={'Remove ' + item.name} onclick={() => removeReadLanguage(item.code)}>{item.name + ' ×'}</button>{/each}
  </div>
  {#if !view.supported}<p class="small muted">On-device translation is unavailable in this browser.</p>{/if}
</section>
