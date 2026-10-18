/**
 * An idempotency key bound to the request it was first sent with. Sending the same request again
 * (a retry after a lost answer) reuses the key, so the server replays the first answer instead of
 * adding it twice. Any change to the request (an edited text, another member, another template)
 * takes a new key: the server refuses a known key with a different request. After a success,
 * done() retires the key, so the next request always gets a new one.
 */
export interface RequestKey {
  /** The key for this request: the last one while the request is unchanged, else a new one. */
  for(request: unknown): string;
  /** The request succeeded: its key is never sent again. */
  done(): void;
}

export function requestKey(): RequestKey {
  let last: { key: string; request: string } | null = null;
  return {
    for(request) {
      const fingerprint = JSON.stringify(request) ?? '';
      if (!last || last.request !== fingerprint)
        last = { key: crypto.randomUUID(), request: fingerprint };
      return last.key;
    },
    done() {
      last = null;
    },
  };
}
