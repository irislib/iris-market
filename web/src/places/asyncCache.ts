/** Share in-flight reads, bound memory, and allow retries after missing data or errors. */
export function createAsyncCache<K, V>(
  load: (input: K) => Promise<V | null>,
  keyFor: (input: K) => string,
  maxEntries = 128,
): (input: K) => Promise<V | null> {
  const cache = new Map<string, Promise<V | null>>();
  return (input) => {
    const key = keyFor(input);
    let pending = cache.get(key);
    if (pending) {
      cache.delete(key);
    } else {
      pending = Promise.resolve().then(() => load(input)).catch(() => null).then((value) => {
        if (value === null && cache.get(key) === pending) cache.delete(key);
        return value;
      });
    }
    cache.set(key, pending);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    return pending;
  };
}
