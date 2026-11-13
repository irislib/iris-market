<script lang="ts">
  import {flushSync} from 'svelte'
  import {translatedParagraph} from '../translation-content.ts'
  import {place} from '../svelte/place.ts'
  import ReviewHeader from './ReviewHeader.svelte'
  import type {ProfileReviews} from './profile.svelte.ts'

  let {reviews: r}: {reviews: ProfileReviews} = $props()
  const ratings = [1, 2, 3, 4, 5]
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End']
  const stars: HTMLButtonElement[] = []
  let textarea: HTMLTextAreaElement

  function write() {
    if (!r.openForm()) return
    flushSync()
    textarea.focus()
  }
  function keydown(event: KeyboardEvent, rating: number) {
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 1 : event.key === 'End' ? 5 : (rating - 1 + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1) + 5) % 5 + 1
    r.rating = next
    stars[next - 1].focus()
  }
  function submit(event: SubmitEvent) {
    event.preventDefault()
    void r.submit()
  }
</script>

<div class="review-header">
  <h2>Reviews</h2>
  <button type="button" class="button secondary" hidden={r.view.writeHidden} disabled={r.busy} onclick={write}>{r.view.writeLabel}</button>
</div>
<p class="review-summary">{r.view.summary}</p>
<p class="small muted" role="status">{r.notice}</p>
<button type="button" class="text-button" hidden={r.retryHidden} onclick={() => void r.read()}>Refresh</button>
<form class="review-form" hidden={r.formHidden} onsubmit={submit}>
  <p class="review-public-note small">Your rating and review will be public.</p>
  <fieldset class="review-rating" disabled={r.busy}>
    <legend>Rating</legend>
    <div role="radiogroup" aria-label="Rating">
      {#each ratings as rating, index}
        <button type="button" role="radio" aria-label={`${rating} ${rating === 1 ? 'star' : 'stars'}`} aria-checked={rating === r.rating ? "true" : "false"}
          tabindex={rating === (r.rating || 1) ? 0 : -1} bind:this={stars[index]} onclick={() => r.rating = rating}
          onkeydown={event => keydown(event, rating)}>{rating <= r.rating ? '★' : '☆'}</button>
      {/each}
    </div>
  </fieldset>
  <label for="profile-review-body">Review (optional)</label>
  <textarea id="profile-review-body" rows="4" maxlength="3000" disabled={r.busy} bind:this={textarea} bind:value={r.text}></textarea>
  <p class="error small" role="alert">{r.error}</p>
  <div class="profile-actions">
    <button type="submit" class="button primary" disabled={r.busy || !r.rating}>{r.submitLabel}</button>
    <button type="button" class="text-button" disabled={r.busy} onclick={() => r.cancel()}>Cancel</button>
  </div>
</form>
<div class="review-list">
  {#each r.view.shown as review (review.id)}
    <article class="review-card">
      <ReviewHeader author={review.author} updatedAt={review.updatedAt} onProfile={r.onProfile} />
      <span class="review-stars" role="img" aria-label={`${review.rating} out of 5 stars`}>{'★'.repeat(review.rating) + '☆'.repeat(5 - review.rating)}</span>
      {#if review.body}<span hidden use:place={() => translatedParagraph(review.body, 'review-body')}></span>{/if}
      {#if review.delivery === 'queued'}<span class="small muted">Waiting to publish</span>{/if}
    </article>
  {/each}
</div>
