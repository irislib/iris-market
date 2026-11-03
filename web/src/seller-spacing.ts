type Listing = {id:string; author?:string};
const seller = (item:Listing) => item.author || item.id;

/** Pick the highest ranked listing outside the last two sellers, relaxing the
 * gap when only one or two sellers remain. Every input is scanned once. */
export function spaceSellers<T extends Listing>(ranked:T[], previous:Listing[] = [], limit=ranked.length):T[] {
  let last = previous.length ? seller(previous.at(-1)) : undefined;
  let second = previous.length > 1 ? seller(previous.at(-2)) : undefined;
  const deferred = new Map<string,{indices:number[]; head:number}>();
  const result:T[] = [];
  let cursor = 0;
  while (result.length < limit && (cursor < ranked.length || deferred.size)) {
    // Only sellers on cooldown can be deferred. Choose the earlier rank on ties.
    let next = Infinity, best = Infinity;
    for (const [author, queue] of deferred) {
      const priority = author === last ? 2 : author === second ? 1 : 0;
      const index = queue.indices[queue.head];
      if (priority < best || priority === best && index < next) { next = index; best = priority; }
    }
    if (best > 0 && cursor < ranked.length) {
      next = cursor++;
      const author = seller(ranked[next]);
      if (author === last || author === second) {
        const queue = deferred.get(author);
        if (queue) queue.indices.push(next);
        else deferred.set(author,{indices:[next],head:0});
        continue;
      }
    } else {
      const author = seller(ranked[next]), queue = deferred.get(author);
      if (++queue.head === queue.indices.length) deferred.delete(author);
    }
    result.push(ranked[next]);
    second = last;
    last = seller(ranked[next]);
  }
  return result;
}
