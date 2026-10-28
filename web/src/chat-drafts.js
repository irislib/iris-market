/** Per-person drafts survive sign-in and conversation changes; proposals never replace typing. */
export function createChatDrafts() {
  const drafts = new Map();
  let selected;
  return {
    select(peer, current = '', proposal = '') {
      if (selected) drafts.set(selected, current);
      selected = peer;
      if (!drafts.get(peer)?.trim() && typeof proposal === 'string' && proposal.trim()) drafts.set(peer, proposal.slice(0, 8000));
      return drafts.get(peer) ?? '';
    },
    clear(peer) { drafts.delete(peer); },
  };
}
