import { apiInWorkspace, selectedWorkspaceId } from '../../api';
import type { Load } from './messagesRoomsShared';

/*
 * The lifecycle the v4 settings screens share (Rotate key, Auto-reply, Permissions and Connect an
 * agent), without React. One controller serves one open screen and is bound to one (agent,
 * workspace) at a time. Binding another agent or workspace, and closing the screen, starts a new
 * generation: everything the screen showed (its reads, the typed confirmation, busy, error, notice
 * and a new key) is dropped, the old generation's requests are given up, and their answers never
 * set anything, also when the screen comes back to the same agent and workspace (A to B to A).
 *
 * Every request goes through a run. A run belongs to one generation and one lane (a read, or the
 * screen's one action at a time); only the latest run of its lane in the current generation is
 * live. Each request of a run is sent for the workspace the run started in (X-City-Workspace set
 * explicitly, never the one selected when it goes out), and a run ends for good as soon as another
 * workspace is selected, so a run with several requests stops before the next one instead of
 * sending the rest for the new workspace.
 */

/** A request of a run that ended (another agent or workspace, or the screen closed). */
export class StaleRunError extends Error {
  constructor() {
    super('This answer belongs to a screen that has moved on.');
    this.name = 'AbortError';
  }
}
export const isStale = (error: unknown): error is StaleRunError => error instanceof StaleRunError;

/** The requests of one run, all for its own agent and workspace. */
export interface SettingsRun {
  readonly agentId: string;
  readonly workspace: string | null;
  readonly generation: number;
  readonly signal: AbortSignal;
  /** Still the latest run of its lane, in the current generation, with its workspace selected. */
  live(): boolean;
  /**
   * api() for this run's workspace. Refuses (StaleRunError) before sending once the run is over,
   * and turns any answer that arrives after that into StaleRunError too. With `timeoutMs` the
   * request is given up after that long and fails with a TimeoutError (the run goes on).
   */
  api<T>(path: string, body?: unknown, method?: string, options?: RunRequestOptions): Promise<T>;
  /** Runs `apply` only while the run is live; says whether it ran. */
  commit(apply: () => void): boolean;
}

export interface RunRequestOptions {
  /** Gives the request up after this long (a TimeoutError); none by default. */
  timeoutMs?: number;
}

/** A read of a screen: what it shows, for the run's agent and workspace. */
export type SettingsRead = (run: SettingsRun) => Promise<unknown>;

export interface SettingsState {
  /** The agent and workspace bound now (null before the first bind). */
  agentId: string | null;
  workspace: string | null;
  /** Bumped on every bind to another agent or workspace and on close. */
  generation: number;
  open: boolean;
  /** What the owner typed into the confirm field, for this generation only. */
  confirm: string;
  /** Each read by name. */
  loads: Readonly<Record<string, Load<unknown>>>;
  /** The action on its way ('' when none): one at a time. */
  busy: string;
  /** The last action's error line. */
  error: string;
  /** A short confirmation (the toast), gone after NOTICE_MS. */
  notice: string;
  /** A secret shown once (Rotate key's new key). */
  secret: string | null;
}

export interface LifecycleDeps {
  fetch: typeof fetch;
  /** The workspace selected now (src/api.ts). */
  currentWorkspace: () => string | null;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const defaultDeps = (): LifecycleDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  currentWorkspace: selectedWorkspaceId,
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** Reads give up after this long, so nothing spins forever (the other v4 screens' deadline). */
export const SETTINGS_READ_DEADLINE_MS = 15_000;
/** The toast's time on screen. */
export const NOTICE_MS = 1_700;

const LOADING: Load<unknown> = { state: 'loading' };
const timedOut = () => Object.assign(new Error('This took too long.'), { name: 'TimeoutError' });
const plainFailure = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? 'This took too long.'
    : 'Something went wrong. Try again.';

class Run implements SettingsRun {
  readonly abort = new AbortController();
  private ended = false;
  constructor(
    readonly agentId: string,
    readonly workspace: string | null,
    readonly generation: number,
    readonly lane: string,
    private readonly holds: (run: Run) => boolean,
    private readonly deps: LifecycleDeps,
  ) {}
  get signal() {
    return this.abort.signal;
  }
  live(): boolean {
    if (this.ended) return false;
    // Over for good: a run never comes back, also when the same workspace is selected again.
    if (!this.holds(this)) this.ended = true;
    return !this.ended;
  }
  end() {
    this.ended = true;
    this.abort.abort();
  }
  async api<T>(
    path: string,
    body?: unknown,
    method = 'POST',
    options: RunRequestOptions = {},
  ): Promise<T> {
    if (!this.live()) throw new StaleRunError();
    // A request with its own deadline gets its own signal, which the run's end aborts as well.
    let signal = this.signal;
    let late = false;
    let timer: unknown;
    let release = () => {};
    if (options.timeoutMs !== undefined) {
      const own = new AbortController();
      const follow = () => own.abort();
      this.signal.addEventListener('abort', follow);
      release = () => this.signal.removeEventListener('abort', follow);
      timer = this.deps.setTimeout(() => {
        late = true;
        own.abort();
      }, options.timeoutMs);
      signal = own.signal;
    }
    let value: T;
    try {
      value = await apiInWorkspace<T>(this.workspace, path, {
        body,
        method,
        signal,
        fetcher: this.deps.fetch,
      });
    } catch (error) {
      if (!this.live()) throw new StaleRunError();
      if (late) throw timedOut();
      throw error;
    } finally {
      if (timer !== undefined) this.deps.clearTimeout(timer);
      release();
    }
    if (!this.live()) throw new StaleRunError();
    return value;
  }
  commit(apply: () => void): boolean {
    if (!this.live()) return false;
    apply();
    return true;
  }
}

/** The state a screen may show for (agent, workspace): blank unless bound to exactly that pair. */
export function settingsView(
  state: SettingsState,
  agentId: string,
  workspace: string | null,
): SettingsState {
  if (state.open && state.agentId === agentId && state.workspace === workspace) return state;
  return { ...state, confirm: '', loads: {}, busy: '', error: '', notice: '', secret: null };
}

/** A read's state in a view: loading until it has answered in this generation. */
export function loadOf<T>(state: SettingsState, name: string): Load<T> {
  return (state.loads[name] ?? LOADING) as Load<T>;
}

export class SettingsLifecycle {
  private readonly deps: LifecycleDeps;
  private readonly reads: Readonly<Record<string, SettingsRead>>;
  private readonly describe: (error: unknown) => string;
  private readonly deadlineMs: number;
  private state: SettingsState;
  private readonly listeners = new Set<() => void>();
  private generations = 0;
  /** The latest run of each lane in this generation. */
  private readonly lanes = new Map<string, Run>();
  private readonly timers = new Set<unknown>();

  constructor(
    options: {
      reads?: Readonly<Record<string, SettingsRead>>;
      /** A failed read or action in plain words. */
      describe?: (error: unknown) => string;
      deadlineMs?: number;
      deps?: Partial<LifecycleDeps>;
    } = {},
  ) {
    this.deps = { ...defaultDeps(), ...options.deps };
    this.reads = options.reads ?? {};
    this.describe = options.describe ?? plainFailure;
    this.deadlineMs = options.deadlineMs ?? SETTINGS_READ_DEADLINE_MS;
    this.state = this.fresh(null, null, false, 0);
  }

  // ---- store ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = (): SettingsState => this.state;

  private set(patch: Partial<SettingsState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private fresh(
    agentId: string | null,
    workspace: string | null,
    open: boolean,
    generation: number,
  ): SettingsState {
    const loads: Record<string, Load<unknown>> = {};
    for (const name of Object.keys(this.reads)) loads[name] = LOADING;
    return {
      agentId,
      workspace,
      generation,
      open,
      confirm: '',
      loads,
      busy: '',
      error: '',
      notice: '',
      secret: null,
    };
  }

  // ---- generations ----

  /** Shows the screen for this agent in this workspace. Another pair starts a new generation. */
  bind(agentId: string, workspace: string | null) {
    const now = this.state;
    if (now.open && now.agentId === agentId && now.workspace === workspace) return;
    this.renew(agentId, workspace, true);
    for (const name of Object.keys(this.reads)) void this.reload(name);
  }

  /** The screen closed: its requests are given up and every late answer is dropped. */
  close() {
    if (!this.state.open) return;
    this.renew(this.state.agentId, this.state.workspace, false);
  }

  private renew(agentId: string | null, workspace: string | null, open: boolean) {
    const generation = ++this.generations;
    for (const run of this.lanes.values()) run.end();
    this.lanes.clear();
    for (const timer of this.timers) this.deps.clearTimeout(timer);
    this.timers.clear();
    this.state = this.fresh(agentId, workspace, open, generation);
    for (const listener of this.listeners) listener();
  }

  private holds = (run: Run): boolean => {
    const now = this.state;
    return (
      now.open &&
      run.generation === now.generation &&
      this.lanes.get(run.lane) === run &&
      this.deps.currentWorkspace() === run.workspace
    );
  };

  /** A new run on `lane` for the bound agent and workspace; it ends the lane's previous run. */
  private begin(lane: string): Run {
    const now = this.state;
    const run = new Run(
      now.agentId ?? '',
      now.workspace,
      now.generation,
      lane,
      this.holds,
      this.deps,
    );
    if (!now.open || now.agentId === null) {
      run.end();
      return run;
    }
    this.lanes.get(lane)?.end();
    this.lanes.set(lane, run);
    return run;
  }

  // ---- reads ----

  /** Reads `name` again (Try again). Quiet keeps what is shown while it reads. */
  async reload(name: string, quiet = false): Promise<void> {
    const read = this.reads[name];
    if (!read) return;
    const run = this.begin(`read:${name}`);
    if (!run.live()) return;
    if (!quiet) this.setLoad(name, LOADING);
    let late = false;
    const timer = this.deps.setTimeout(() => {
      late = true;
      run.abort.abort();
    }, this.deadlineMs);
    this.timers.add(timer);
    try {
      const data = await read(run);
      run.commit(() => this.setLoad(name, { state: 'ready', data }));
    } catch (error) {
      if (!isStale(error))
        run.commit(() =>
          this.setLoad(name, {
            state: 'error',
            message: this.describe(late ? timedOut() : error),
          }),
        );
    } finally {
      this.deps.clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  private setLoad(name: string, load: Load<unknown>) {
    this.set({ loads: { ...this.state.loads, [name]: load } });
  }

  /** Changes a read's data after an action of `run` (only while it is live, and only once read). */
  updateLoad<T>(run: SettingsRun, name: string, change: (data: T) => T): boolean {
    return run.commit(() => {
      const load = this.state.loads[name];
      if (load?.state === 'ready')
        this.setLoad(name, { state: 'ready', data: change(load.data as T) });
    });
  }

  // ---- the screen's actions ----

  /**
   * The screen's one action at a time (`busy` names it). `generation` is the one the screen
   * showed when the owner acted; an action from another generation is not started. Its error,
   * notice, secret and changes land only while its run is live.
   */
  async act(
    name: string,
    work: (run: SettingsRun) => Promise<void>,
    generation?: number,
  ): Promise<void> {
    const now = this.state;
    if (!now.open || now.agentId === null || now.busy) return;
    if (generation !== undefined && generation !== now.generation) return;
    const run = this.begin('act');
    this.set({ busy: name, error: '' });
    let error = '';
    try {
      await work(run);
    } catch (failure) {
      if (!isStale(failure)) error = this.describe(failure);
    } finally {
      // Busy belongs to the generation; nothing of a run that ended is said.
      if (this.state.generation === run.generation && this.state.busy === name)
        this.set(run.live() ? { busy: '', error } : { busy: '' });
    }
  }

  /** A short confirmation for a live run, gone after NOTICE_MS. */
  notify(run: SettingsRun, text: string): boolean {
    return run.commit(() => {
      this.set({ notice: text });
      const generation = this.state.generation;
      const timer = this.deps.setTimeout(() => {
        this.timers.delete(timer);
        if (this.state.generation === generation && this.state.notice === text)
          this.set({ notice: '' });
      }, NOTICE_MS);
      this.timers.add(timer);
    });
  }

  /** Shows a secret once, for a live run only (it goes with the generation). */
  reveal(run: SettingsRun, secret: string): boolean {
    return run.commit(() => this.set({ secret }));
  }

  clearSecret = () => {
    if (this.state.secret !== null) this.set({ secret: null });
  };

  setConfirm = (text: string) => {
    if (this.state.open) this.set({ confirm: text });
  };
}
