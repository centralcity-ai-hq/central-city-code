import type { LifecycleDeps } from '../src/agents/v4/settingsLifecycle';

/*
 * The scripted server behind the v4 settings lifecycle tests (tests/v4-settings-*.test.ts): answers
 * arrive only when a test releases them, the selected workspace is switched by the test like the
 * workspace picker, and the clock is manual, so a late answer or a deadline can be placed exactly.
 */

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
  settled: boolean;
  reply: (status: number, json: unknown) => Promise<void>;
}

export async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function harness() {
  const calls: Call[] = [];
  /** The workspace selected in the app now; a test switches it like the workspace picker. */
  const selection = { workspace: 'ws-1' as string | null, honourAbort: false };
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const deps: LifecycleDeps = {
    fetch: ((url: string, init: RequestInit = {}) =>
      new Promise((resolve, reject) => {
        const call: Call = {
          url,
          method: init.method ?? 'GET',
          headers: (init.headers ?? {}) as Record<string, string>,
          body: init.body ? JSON.parse(String(init.body)) : null,
          signal: init.signal ?? undefined,
          settled: false,
          reply: async (status, json) => {
            if (!call.settled) {
              call.settled = true;
              resolve({
                ok: status >= 200 && status < 300,
                status,
                json: async () => json,
                headers: { get: () => null },
              } as unknown as Response);
            }
            await settle();
          },
        };
        // A real fetch rejects once aborted; by default the scripted one still answers, so a test
        // can place an answer that arrives after the screen moved on.
        if (selection.honourAbort)
          init.signal?.addEventListener('abort', () => {
            if (call.settled) return;
            call.settled = true;
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        calls.push(call);
      })) as unknown as typeof fetch,
    currentWorkspace: () => selection.workspace,
    setTimeout: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
  };
  async function advance(ms: number) {
    clock += ms;
    for (const [id, timer] of [...timers].sort((x, y) => x[1].at - y[1].at)) {
      if (timer.at > clock || !timers.has(id)) continue;
      timers.delete(id);
      timer.run();
      await settle();
    }
  }
  const open = (method?: string, part?: string) =>
    calls.filter(
      (call) =>
        !call.settled && (!method || call.method === method) && (!part || call.url.includes(part)),
    );
  /** The requests that change something (everything but reads). */
  const writes = () => calls.filter((call) => call.method !== 'GET');
  return { calls, deps, selection, advance, open, writes };
}
