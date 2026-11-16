<script lang="ts">
  import {locationFromTags} from '../map/geohash.ts'
  import {exactListingPoint, pinPreview} from '../map/listing-pin.ts'
  import {createAreaPreview} from '../map/area-preview.ts'
  import {renderListingPage} from '../listing-page.ts'
  import {defaultPriceNode, draftFileSize, previewListing, type DraftFile, type PriceNode} from '../composer-preview.ts'

  let {draft, files, priceNode = defaultPriceNode, mediaArea = undefined, areaReused = false}:
    {draft: any; files: DraftFile[]; priceNode?: PriceNode; mediaArea?: HTMLElement; areaReused?: boolean} = $props()

  const listing = $derived(previewListing(draft))
  const selected = $derived(listing.imageUrl ? undefined : files.find(file => file.image)?.image)
  const cell = $derived(locationFromTags(draft.tags))
  let broken = $state<number[]>([])

  /** Shows on a map exactly what the listing makes public. */
  function areaMap(container: HTMLElement, value: NonNullable<typeof cell>) {
    let instance: Awaited<ReturnType<typeof createAreaPreview>> | undefined, gone = false
    const appearance = document.documentElement.dataset.appearance
    const dark = appearance === 'dark' || appearance !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches
    createAreaPreview(container, {bounds: value.bounds, point: exactListingPoint(draft.tags, value.geohash), dark})
      .then(map => { if (gone) void map.destroy(); else instance = map })
      .catch(() => { container.hidden = true })
    return {destroy() { gone = true; void instance?.destroy() }}
  }

  /** The shared detail presentation comes first; a read-only area map may stand in for missing media. */
  function page(root: HTMLElement) {
    const node = renderListingPage(listing as any, {priceNode, draftPreview: true, localImage: selected})
    const media = mediaArea && node.querySelector('.detail-media')
    if (media) { media.classList.add('detail-area-media'); media.replaceChildren(mediaArea) }
    root.prepend(node)
    return {destroy() { node.remove() }}
  }
</script>

<div class="post-preview-content" use:page>
  {#if cell}
    <p class="small">{pinPreview(draft.tags, cell.geohash)}{areaReused ? ' · Same area as your earlier listings' : ''}</p>
    <div class="post-area-map" use:areaMap={cell}></div>
  {/if}
  {#if files.length}
    <div class="post-preview-files">
      {#each files as file, index}
        <figure>{#if file.image && !broken.includes(index)}<img src={file.image} alt={file.name} onerror={() => { broken = [...broken, index] }}>{/if}<figcaption><span>{file.name}</span><small class="muted">{draftFileSize(file.size)}</small></figcaption></figure>
      {/each}
    </div>
  {/if}
</div>
