<script lang="ts">
  import {createUserRow} from '../people.ts'
  import {place} from '../svelte/place.ts'

  let {author, updatedAt, onProfile}: {author: string; updatedAt: number; onProfile: (pubkey: string) => void} = $props()
  const date = $derived(new Date(updatedAt * 1000))
</script>

<div class="review-header">
  <span hidden use:place={() => createUserRow(author, {size: 32, className: 'review-author', onClick: () => onProfile(author)})}></span>
  <time class="muted small" datetime={date.toISOString()}>{date.toLocaleDateString()}</time>
</div>
