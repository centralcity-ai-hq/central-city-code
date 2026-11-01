/** Bounded public-read cache. Failed refreshes back off too; callers never create a query storm. */
export function createExplorerReadCache<T>(options: {
  read: (key: string) => Promise<T>;
  now?: () => number;
  ttlMs?: number;
  maxKeys?: number;
  maxConcurrent?: number;
}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 15_000;
  const maxKeys = options.maxKeys ?? 100;
  const slots = options.maxConcurrent ?? 2;
  type Entry = { value?: T; at: number; retryAt: number; pending?: Promise<void> };
  const entries = new Map<string, Entry>();
  let active = 0;
  return async (key: string): Promise<{ value: T; asOf: number; stale: boolean } | null> => {
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) {
        const victim = [...entries].find(([, item]) => !item.pending);
        if (!victim) return null;
        entries.delete(victim[0]);
      }
      entry = { at: 0, retryAt: 0 };
      entries.set(key, entry);
    }
    const current = entry;
    // All callers for this key await the same initial read. Other keys share a fixed slot cap.
    if (!current.pending && now() >= current.retryAt && active < slots) {
      active++;
      current.pending = Promise.resolve()
        .then(() => options.read(key))
        .then((value) => {
          current.value = value;
          current.at = now();
        })
        .catch(() => {
          // Keep the last successful result. Errors and internal details are never public data.
        })
        .finally(() => {
          current.retryAt = now() + ttl;
          current.pending = undefined;
          active--;
        });
    }
    await current.pending;
    if (current.value === undefined) return null;
    return { value: current.value, asOf: current.at, stale: now() - current.at >= ttl };
  };
}
