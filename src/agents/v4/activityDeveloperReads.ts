import type { AgentActivityPage, Snapshot } from '../../../shared/types';
import { apiInWorkspace } from '../../api';
import { snapshotPath } from '../agentPages';
import {
  activityNames,
  activityPath,
  appendPage,
  developerView,
  refreshFeed,
  type ActivityFeed,
  type ActivityNames,
  type DeveloperView,
} from './activityDeveloperModel';

/*
 * The reads behind the agent pane's Activity and Developer details screens, without React. A screen
 * shows one (agent, workspace) at a time. Every read asks in the pair it started in (the workspace
 * is sent as X-City-Workspace, never whichever one is selected later) and belongs to the generation
 * it started in. The generation bumps on every agent or workspace change and when the screen
 * closes, so a late answer is dropped, including the first A answer after A → B → A.
 */

/** The agent and workspace (null: the person's own) a screen shows. */
export interface ReadScope {
  agentId: string;
  workspace: string | null;
}

/** Whether `scope` is this agent in this workspace: a screen shows data only for its own pair. */
export function sameScope(
  scope: ReadScope | null,
  agentId: string,
  workspace: string | null,
): boolean {
  return scope !== null && scope.agentId === agentId && scope.workspace === workspace;
}

export interface ReadDeps {
  fetch: typeof fetch;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Whether the page is visible; Activity's refresh only reads then. */
  visible: () => boolean;
  /** Every read gives up after this long, so nothing spins forever. */
  deadlineMs: number;
}

const defaultDeps = (): ReadDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => globalThis.document?.visibilityState === 'visible',
  deadlineMs: 15_000,
});

const timeoutError = () => Object.assign(new Error('Timed out'), { name: 'TimeoutError' });
const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

type Outcome<T> = { ok: true; value: T } | { ok: false; error: Error };

/** The store, the scope and the generations both screens share. */
abstract class ScreenReads<S extends { scope: ReadScope | null }> {
  protected readonly deps: ReadDeps;
  protected snap: S;
  private readonly listeners = new Set<() => void>();
  /** Bumps on every agent or workspace change and on close; requests keep the one they began in. */
  private generation = 0;
  private ids = 0;
  /** The request whose answer counts, per lane; a newer one in the same lane replaces it. */
  private readonly lanes = new Map<string, { id: number; controller: AbortController }>();
  private readonly timers = new Set<unknown>();

  constructor(deps: Partial<ReadDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
    this.snap = this.blank(null);
  }

  /** The state of a pair before anything of it has been read. */
  protected abstract blank(scope: ReadScope | null): S;
  /** Starts reading a pair that was just shown. */
  protected abstract begin(): void;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = (): S => this.snap;

  protected set(patch: Partial<S>) {
    this.snap = { ...this.snap, ...patch };
    for (const listener of this.listeners) listener();
  }

  protected get scope(): ReadScope | null {
    return this.snap.scope;
  }

  /**
   * Shows this agent in this workspace. The same pair again changes nothing; another pair drops
   * everything of the previous one (state, requests, timers) and starts reading anew.
   */
  show = (agentId: string, workspace: string | null) => {
    if (sameScope(this.scope, agentId, workspace)) return;
    this.endGeneration();
    this.snap = this.blank({ agentId, workspace });
    for (const listener of this.listeners) listener();
    this.begin();
  };

  /** The screen closed: every request on its way is given up and its answer dropped. */
  close = () => {
    this.endGeneration();
    this.snap = this.blank(null);
  };

  private endGeneration() {
    this.generation++;
    for (const lane of this.lanes.values()) lane.controller.abort();
    this.lanes.clear();
    for (const timer of this.timers) this.deps.clearTimeout(timer);
    this.timers.clear();
  }

  /** Whether the generation current now is still current later (no switch or close between). */
  protected generationCheck(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }

  /** A timer of this generation: it never fires after a switch or close. */
  protected after(ms: number, run: () => void) {
    const current = this.generationCheck();
    const handle = this.deps.setTimeout(() => {
      this.timers.delete(handle);
      if (current()) run();
    }, ms);
    this.timers.add(handle);
    return () => {
      this.deps.clearTimeout(handle);
      this.timers.delete(handle);
    };
  }

  /**
   * One GET in the pair shown now, in `lane`. Resolves to null when its answer no longer counts: the
   * agent or workspace changed, the screen closed, or a newer request of the same lane replaced it.
   */
  protected async read<T>(
    lane: string,
    path: (agentId: string) => string,
  ): Promise<Outcome<T> | null> {
    const scope = this.scope;
    if (!scope) return null;
    const current = this.generationCheck();
    const id = ++this.ids;
    this.lanes.get(lane)?.controller.abort();
    const controller = new AbortController();
    this.lanes.set(lane, { id, controller });
    let timedOut = false;
    const deadline = this.deps.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.deps.deadlineMs);
    const counts = () => current() && this.lanes.get(lane)?.id === id;
    try {
      const value = await apiInWorkspace<T>(scope.workspace, path(scope.agentId), {
        method: 'GET',
        signal: controller.signal,
        fetcher: this.deps.fetch,
      });
      return counts() ? { ok: true, value } : null;
    } catch (error) {
      return counts() ? { ok: false, error: timedOut ? timeoutError() : asError(error) } : null;
    } finally {
      this.deps.clearTimeout(deadline);
      if (this.lanes.get(lane)?.id === id) this.lanes.delete(lane);
    }
  }
}

/* ---------- Activity ---------- */

/** The newest page is re-read this often while the page is visible, so running runs move on. */
export const ACTIVITY_POLL_MS = 10_000;

export interface ActivitySnapshot {
  scope: ReadScope | null;
  /** The feed of this pair; null until its first read answers. */
  feed: ActivityFeed | null;
  /** The first read failed and nothing is shown yet (a failed refresh keeps the feed). */
  error: Error | null;
  /** "Show older" is on its way. */
  older: boolean;
  olderError: Error | null;
}

/**
 * Activity of one agent: the newest page (GET /api/agents/:id/activity), re-read every 10 s while
 * visible, and older pages on "Show older", all in the pair shown when each read starts.
 */
export class ActivityReads extends ScreenReads<ActivitySnapshot> {
  constructor(deps: Partial<ReadDeps> = {}) {
    super(deps);
  }

  protected blank(scope: ReadScope | null): ActivitySnapshot {
    return { scope, feed: null, error: null, older: false, olderError: null };
  }

  protected begin() {
    void this.newest(false);
    this.poll();
  }

  private poll() {
    this.after(ACTIVITY_POLL_MS, () => {
      if (this.deps.visible()) void this.newest(true);
      this.poll();
    });
  }

  /** Reads the newest page again; `quiet` keeps what is shown when it fails. */
  private async newest(quiet: boolean) {
    if (!quiet) this.set({ error: null });
    const outcome = await this.read<AgentActivityPage>('newest', (agentId) =>
      activityPath(agentId),
    );
    if (!outcome) return;
    if (outcome.ok) this.set({ feed: refreshFeed(this.snap.feed, outcome.value), error: null });
    else if (!(quiet && this.snap.feed)) this.set({ error: outcome.error });
  }

  /** "Try again" after the first read failed. */
  reload = () => void this.newest(false);

  /** "Show older": the page before the oldest one shown. */
  showOlder = async () => {
    const before = this.snap.feed?.nextBefore;
    if (!before || this.snap.older) return;
    this.set({ older: true, olderError: null });
    const outcome = await this.read<AgentActivityPage>('older', (agentId) =>
      activityPath(agentId, before),
    );
    if (!outcome) return;
    if (outcome.ok && this.snap.feed)
      this.set({ feed: appendPage(this.snap.feed, outcome.value), older: false });
    else this.set({ older: false, olderError: outcome.ok ? null : outcome.error });
  };
}

export interface ActivityNamesSnapshot {
  scope: ReadScope | null;
  /** The names of this pair; null until both reads have answered or failed. */
  names: ActivityNames | null;
}

/**
 * The names Activity puts in place of IDs (activityDeveloperModel.ts nameIds): the agents of the
 * owner snapshot (GET /api/snapshot) and the rooms the person sees (GET /api/rooms), both in the
 * pair shown when the reads start. Only what the owner may see; a failed read leaves its names out.
 */
export class ActivityNameReads extends ScreenReads<ActivityNamesSnapshot> {
  constructor(deps: Partial<ReadDeps> = {}) {
    super(deps);
  }

  protected blank(scope: ReadScope | null): ActivityNamesSnapshot {
    return { scope, names: null };
  }

  protected begin() {
    void this.load();
  }

  private async load() {
    // Each read checks its own answer when it arrives; the pair is committed later, so the
    // generation is checked again at that point (a switch or close in between drops both).
    const current = this.generationCheck();
    const [snapshot, rooms] = await Promise.all([
      this.read<Snapshot>('snapshot', (agentId) =>
        snapshotPath(this.scope?.workspace ?? null, [agentId]),
      ),
      this.read<{ rooms?: { id: string; name: string }[] }>('rooms', () => '/api/rooms'),
    ]);
    // A switch, a close or a newer read: that one sets the names.
    if (!snapshot || !rooms || !current()) return;
    this.set({
      names: activityNames(
        snapshot.ok ? (snapshot.value.agents ?? []) : null,
        rooms.ok ? (rooms.value.rooms ?? []) : null,
      ),
    });
  }

  /** Reads the names again ("Try again" on the feed). */
  reload = () => void this.load();
}

/* ---------- Developer details ---------- */

/** How long "Copied" stays (the mockup's toast). */
export const COPY_NOTE_MS = 1_700;

export interface DeveloperSnapshot {
  scope: ReadScope | null;
  loading: boolean;
  error: Error | null;
  /** The agent as the owner snapshot has it; null while loading, after an error, or when missing. */
  view: DeveloperView | null;
  /** The snapshot answered without this agent: it isn't in this workspace. */
  missing: boolean;
  /** The last copy of the agent ID, for a short note; it never carries over to another agent. */
  copy: 'copied' | 'failed' | null;
}

/**
 * Developer details of one agent, read from the owner snapshot (GET /api/snapshot: owner views
 * carry the key hint) of the workspace shown when the read starts.
 */
export class DeveloperReads extends ScreenReads<DeveloperSnapshot> {
  private clearCopy: (() => void) | null = null;

  constructor(deps: Partial<ReadDeps> = {}) {
    super(deps);
  }

  protected blank(scope: ReadScope | null): DeveloperSnapshot {
    return { scope, loading: scope !== null, error: null, view: null, missing: false, copy: null };
  }

  protected begin() {
    void this.load();
  }

  private async load() {
    this.set({ loading: true, error: null });
    const outcome = await this.read<Snapshot>('snapshot', (agentId) =>
      snapshotPath(this.scope?.workspace ?? null, [agentId]),
    );
    if (!outcome) return;
    if (!outcome.ok) {
      this.set({ loading: false, error: outcome.error, view: null, missing: false });
      return;
    }
    const agentId = this.scope?.agentId;
    const agents = outcome.value.agents ?? [];
    const found = agents.find((item) => item.id === agentId);
    const nameOf = (id: string) => agents.find((item) => item.id === id)?.name;
    this.set({
      loading: false,
      error: null,
      view: found ? developerView(found, undefined, nameOf) : null,
      missing: !found,
    });
  }

  /** "Try again". */
  reload = () => void this.load();

  /**
   * Copies the shown agent's ID with `write` (the clipboard). The note it leaves belongs to this
   * agent and workspace: a switch or close before the clipboard answers drops it.
   */
  copyId = async (write: (text: string) => Promise<void>) => {
    const view = this.snap.view;
    if (!view) return;
    const current = this.generationCheck();
    let copied: boolean;
    try {
      await write(view.id);
      copied = true;
    } catch {
      copied = false;
    }
    if (!current()) return;
    // A timer of an ended generation is already gone; clearing it again is harmless.
    this.clearCopy?.();
    this.set({ copy: copied ? 'copied' : 'failed' });
    this.clearCopy = this.after(COPY_NOTE_MS, () => {
      this.clearCopy = null;
      this.set({ copy: null });
    });
  };
}
