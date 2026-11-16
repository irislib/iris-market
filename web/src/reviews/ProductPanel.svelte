<script lang="ts">
  import {translatedParagraph} from '../translation-content.ts'
  import {place} from '../svelte/place.ts'
  import ReviewHeader from './ReviewHeader.svelte'
  import type {ProductReview} from '../product-reviews.ts'
  import type {ProductReviews} from './product.svelte.ts'

  let {reviews: r}: {reviews: ProductReviews} = $props()
  const count = $derived(r.reviews.length)
  let recommend = $state(true), body = $state('')
  const recommendation = (review: ProductReview) => review.rating === 1 ? 'Recommends this item' : review.rating === 0 ? 'Doesn’t recommend this item' : `Recommendation score: ${Math.round(review.rating * 100)}%`
  const dimensions = (review: ProductReview) => Object.entries(review.ratings).filter(([dimension]) => dimension !== 'thumb')
</script>

<div class="review-header"><h2>Product reviews</h2>{#if r.canWrite() && !r.writing}<button type="button" class="button secondary" onclick={() => { r.writing = true }}>Review this item</button>{/if}</div>
{#if r.writing}
  <form class="review-form" onsubmit={event => { event.preventDefault(); void r.submit(recommend, body).then(done => { if (done) body = '' }) }}>
    <p class="small muted">Your review will be public.</p>
    <div class="segments" role="radiogroup" aria-label="Would you recommend this item?">
      <button type="button" role="radio" aria-checked={recommend ? 'true' : 'false'} class:selected={recommend} onclick={() => { recommend = true }}>👍 Recommend</button>
      <button type="button" role="radio" aria-checked={!recommend ? 'true' : 'false'} class:selected={!recommend} onclick={() => { recommend = false }}>👎 Don’t recommend</button>
    </div>
    <label for="product-review-body">Review (optional)</label>
    <textarea id="product-review-body" maxlength="3000" rows="4" bind:value={body}></textarea>
    <p class="error small" role="alert">{r.error}</p>
    <button class="button primary" disabled={r.busy}>Publish review</button>
    <button type="button" class="button secondary" disabled={r.busy} onclick={() => { r.writing = false }}>Cancel</button>
  </form>
{/if}
<p class="review-summary">{count ? `${count} ${count === 1 ? 'review' : 'reviews'} · Purchases not verified` : '0 reviews'}</p>
<p class="small muted" role="status">{r.notice}</p>
<button type="button" class="text-button" hidden={r.retryHidden} onclick={() => void r.read()}>Refresh</button>
<div class="review-list">
  {#each r.reviews as review (review.id)}
    <article class="review-card">
      <ReviewHeader author={review.author} updatedAt={review.updatedAt} onProfile={pubkey => r.open(pubkey)} />
      <p class="small">{recommendation(review)}</p>
      {#if review.body}<span hidden use:place={() => translatedParagraph(review.body, 'review-body')}></span>{/if}
      {#if dimensions(review).length}
        <details>
          <summary>Rating details</summary>
          {#each dimensions(review) as [dimension, score]}<p class="small muted">{`${dimension.replace(/[-_]/g, ' ')}: ${Math.round(score * 100)}%`}</p>{/each}
        </details>
      {/if}
    </article>
  {/each}
</div>
