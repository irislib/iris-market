<script lang="ts">
  import {locationFromTags} from '../map/geohash.ts'
  import {pinPreview} from '../map/listing-pin.ts'
  import {renderListingPage} from '../listing-page.ts'
  import {defaultPriceNode, draftFileSize, previewListing, type DraftFile, type PriceNode} from '../composer-preview.ts'

  let {draft, files, priceNode = defaultPriceNode, mediaArea = undefined}:
    {draft: any; files: DraftFile[]; priceNode?: PriceNode; mediaArea?: HTMLElement} = $props()

  const listing = $derived(previewListing(draft))
  const selected = $derived(listing.imageUrl ? undefined : files.find(file => file.image)?.image)
  const cell = $derived(locationFromTags(draft.tags))
  let broken = $state<number[]>([])

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
  {#if cell}<p class="small">{pinPreview(draft.tags, cell.geohash)}</p>{/if}
  {#if files.length}
    <div class="post-preview-files">
      {#each files as file, index}
        <figure>{#if file.image && !broken.includes(index)}<img src={file.image} alt={file.name} onerror={() => { broken = [...broken, index] }}>{/if}<figcaption><span>{file.name}</span><small class="muted">{draftFileSize(file.size)}</small></figcaption></figure>
      {/each}
    </div>
  {/if}
</div>
