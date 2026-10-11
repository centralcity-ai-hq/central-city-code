import { ApiError } from '../api';
import { plainApiMessage } from '../ui/plainText';
import {
  ADDRESS,
  BACKOFF_MS,
  BASE_MAINNET,
  RECOVERY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  inProgress,
  pollDelay,
  retryAllowed,
  stageOf,
  validAddress,
  type BoundWallet,
  type Conflict,
  type IdentityView,
  type RegisterReply,
  type RegistrationRow,
  type Stage,
  type View,
} from './baseRegistrationModel';
import { forgetStatus, knownStatus, rememberStatus, statusEpoch } from './baseStatusCache';

/*
 * The Base registration of one agent in one workspace, without React: reads where it stands and,
 * unless read-only, moves it on with the owner's wallet. One controller serves exactly one
 * (agent, workspace); another agent gets another controller. Every request belongs to the run it
 * started in (start() begins a run, stop() ends it), and an answer from an ended run is dropped,
 * so nothing from one agent can reach another agent's view, owner or requests.
 */

/** The owner's wallet address is public; it is remembered per agent only to resume a registration. */
const savedAddressKey = (agentId: string) => `cc.base.owner.${agentId}`;
/** Also kept for the page session, so a rebuilt panel keeps advancing when storage is blocked. */
const sessionOwners = new Map<string, string>();
function savedAddress(agentId: string): string {
  const session = sessionOwners.get(agentId);
  if (session) return session;
  try {
    return globalThis.localStorage?.getItem(savedAddressKey(agentId)) ?? '';
  } catch {
    return '';
  }
}
function saveAddress(agentId: string, address: string) {
  sessionOwners.set(agentId, address);
  try {
    globalThis.localStorage?.setItem(savedAddressKey(agentId), address);
  } catch {
    // Private windows and blocked storage: the registration still works, it just can't resume.
  }
}
/**
 * The owner each agent's register call last succeeded with in this page session (lowercase). Only
 * the server's answer puts an address here, so it says the server accepted that owner; it is never
 * shown as the owner.
 */
const acceptedOwners = new Map<string, string>();

const isServerError = (error: unknown) => error instanceof ApiError && error.status >= 500;

/** What the key flow's refusals mean, in the screen's words (server/base/identity/routes.ts). */
const KEY_REFUSALS: Record<string, string> = {
  wallet_key_required: 'Set up your wallet key first.',
  backup_required: 'Confirm your backup key first.',
  wallet_mismatch: 'This isn’t the wallet your key makes for this agent. Nothing was registered.',
  wallets_off:
    'Registering with your wallet key isn’t available right now. Nothing was registered.',
  wallet_conflict:
    'This agent already has a wallet another key controls, so it can’t be registered with your wallet key.',
};

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code && KEY_REFUSALS[error.code]) return KEY_REFUSALS[error.code]!;
    if (error.status === 503) return 'Base registration isn’t available right now.';
    return error.message;
  }
  return 'The registration could not be sent. Try again.';
}

/** The stages a registration waits in before its Base ID exists; only these can take "longer". */
const WAITING: readonly Stage[] = ['registering', 'handing_over'];

export interface BaseRegistrationSnapshot {
  loading: boolean;
  loadFailed: boolean;
  /** The server doesn't know this agent as one of the person's agents (404): no Base for it. */
  notAvailable: boolean;
  identity: IdentityView | null;
  wallet: BoundWallet | null;
  stage: Stage | null;
  busy: boolean;
  error: string;
  conflict: Conflict | null;
  /**
   * A server error during a registration in progress: the panel keeps going, just less often. After
   * a poll it says so quietly; after a new attempt the retry message explains it instead.
   */
  backoff: 'poll' | 'retry' | null;
  /** The person's new attempt got a server error; it stays said until they try again. */
  retryFailed: boolean;
  progressing: boolean;
  /** Advancing (or, read-only, re-reading) by itself. */
  polling: boolean;
  /**
   * The owner wallet this registration advances with, once known: the one the server bound, else
   * the one entered or remembered here. Never shown as the owner; only the server's is.
   */
  owner: string | null;
  boundOwner: string | null;
  address: string;
  /** When the current wait for a Base ID started: the server's time, else this client's. */
  waitingSince: number | null;
  /** A private agent's Continue was pressed: the one question before its profile is made public. */
  confirmingPublic: boolean;
  /** The server made the agent's profile public in this run. It stays public, whatever follows. */
  madePublic: boolean;
  /** The server says the agent has no profile, so it cannot be made public (409 no_profile). */
  noProfile: boolean;
}

/**
 * How a registration names its owner. 'address': the wallet address typed in (wallets switched off,
 * as before). 'key': the person's own wallet key (decision A, one wallet): the server takes the
 * owner from their vault, and the request carries only the wallet this browser derived from the key
 * it held (`expectedWallet`); the server registers only that wallet. `key` is null until this
 * browser holds the key (the screen unlocks it first).
 */
export type OwnerMode =
  | { kind: 'address' }
  | { kind: 'key'; key: { owner: string; expectedWallet: string } | null }
  /** Not known yet (the screen is still reading whether wallets are on): nothing resumes. */
  | { kind: 'pending' };

export interface ControllerDeps {
  fetch: typeof fetch;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const defaultDeps = (): ControllerDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

interface Inner {
  loading: boolean;
  loadFailed: boolean;
  notAvailable: boolean;
  view: View;
  address: string;
  busy: boolean;
  error: string;
  conflict: Conflict | null;
  backoff: 'poll' | 'retry' | null;
  retryFailed: boolean;
  owner: string | null;
  /** Counts finished requests, so the next poll is timed from the latest answer. */
  answered: number;
  /** When this client first saw the registration waiting for its Base ID. */
  seenWaitingAt: number | null;
  confirmingPublic: boolean;
  madePublic: boolean;
  noProfile: boolean;
}

export class BaseRegistrationController {
  readonly agentId: string;
  readonly workspace: string | null;
  readonly readOnly: boolean;
  /** The cache epoch (signed-in person) this controller was created in; it writes only in it. */
  private readonly cacheEpoch: number;
  private readonly deps: ControllerDeps;
  private inner: Inner;
  private snap: BaseRegistrationSnapshot;
  private readonly listeners = new Set<() => void>();
  /** The current run; 0 while stopped. Requests remember the run they started in. */
  private run = 0;
  private runs = 0;
  /** The run whose request is on its way, so only one goes out at a time. */
  private inFlight = 0;
  private pollTimer: unknown = null;
  /** What the poll timer was set for, so it is only reset when that changes. */
  private pollKey = '';
  private readonly pending = new Set<AbortController>();
  private mode: OwnerMode = { kind: 'address' };

  constructor(
    agentId: string,
    workspace: string | null,
    options: { readOnly?: boolean; deps?: Partial<ControllerDeps>; ownerMode?: OwnerMode } = {},
  ) {
    this.agentId = agentId;
    this.workspace = workspace;
    this.readOnly = options.readOnly === true;
    this.deps = { ...defaultDeps(), ...options.deps };
    this.mode = options.ownerMode ?? { kind: 'address' };
    this.cacheEpoch = statusEpoch();
    this.inner = this.fresh();
    this.snap = this.snapshotOf(this.inner);
  }

  private fresh(): Inner {
    const remembered = this.readOnly ? '' : savedAddress(this.agentId);
    // Read-only, this agent's last answer in this workspace shows at once; start() reads afresh.
    // The full panel always waits for its own read, so it never offers anything on an old answer.
    const known =
      this.readOnly && this.cacheEpoch === statusEpoch()
        ? knownStatus(this.agentId, this.workspace)
        : null;
    return {
      loading: known === null,
      loadFailed: known?.notAvailable ?? false,
      notAvailable: known?.notAvailable ?? false,
      view: known?.view ?? { identity: null, wallet: null },
      address: remembered,
      busy: false,
      error: '',
      conflict: null,
      backoff: null,
      retryFailed: false,
      owner: validAddress(remembered),
      answered: 0,
      seenWaitingAt: known?.seenWaitingAt ?? null,
      confirmingPublic: false,
      madePublic: false,
      noProfile: false,
    };
  }

  // ---- store ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = (): BaseRegistrationSnapshot => this.snap;

  private snapshotOf(inner: Inner): BaseRegistrationSnapshot {
    const { identity, wallet } = inner.view;
    const stage = identity ? stageOf(identity) : null;
    const progressing = inProgress(identity);
    const waiting = stage !== null && WAITING.includes(stage);
    const startedAt = identity?.startedAt;
    return {
      loading: inner.loading,
      loadFailed: inner.loadFailed,
      notAvailable: inner.notAvailable,
      identity,
      wallet,
      stage,
      busy: inner.busy,
      error: inner.error,
      conflict: inner.conflict,
      backoff: inner.backoff,
      retryFailed: inner.retryFailed,
      progressing,
      polling: this.pollingOf(inner, progressing),
      owner: inner.owner,
      boundOwner: validAddress(wallet?.ownerAddress),
      address: inner.address,
      waitingSince: !waiting
        ? null
        : typeof startedAt === 'number' && Number.isFinite(startedAt)
          ? startedAt
          : inner.seenWaitingAt,
      confirmingPublic: inner.confirmingPublic,
      madePublic: inner.madePublic,
      noProfile: inner.noProfile,
    };
  }

  private pollingOf(inner: Inner, progressing: boolean): boolean {
    if (this.readOnly) return progressing && !inner.loadFailed;
    return progressing && inner.owner !== null && !inner.error && !inner.conflict;
  }

  private set(patch: Partial<Inner>) {
    const next = { ...this.inner, ...patch };
    const stage = next.view.identity ? stageOf(next.view.identity) : null;
    const waiting = stage !== null && WAITING.includes(stage);
    next.seenWaitingAt = waiting ? (next.seenWaitingAt ?? this.deps.now()) : null;
    this.inner = next;
    this.snap = this.snapshotOf(next);
    this.schedulePoll();
    for (const listener of this.listeners) listener();
  }

  // ---- runs ----

  /** Begins a run: reads where the registration stands, and resumes one in progress. */
  start() {
    if (this.run) return;
    this.run = ++this.runs;
    this.pollKey = '';
    // An ended run's request never answers here, so nothing is on its way for this one.
    if (this.inner.busy) this.set({ busy: false });
    void this.load(this.run);
  }

  /** Ends the run: its timers stop, its requests are given up and their answers dropped. */
  stop() {
    this.run = 0;
    this.inFlight = 0;
    this.clearPoll();
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  private live(run: number) {
    return run !== 0 && this.run === run;
  }

  private clearPoll() {
    if (this.pollTimer !== null) this.deps.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Mirrors the panel's timer: reset whenever polling, the owner, the delay or an answer changes. */
  private schedulePoll() {
    const run = this.run;
    const inner = this.inner;
    const polling = this.snap.polling && run !== 0;
    const delay = inner.backoff ? BACKOFF_MS : pollDelay(inner.view.identity);
    const key = polling ? `${run}|${inner.owner}|${delay}|${inner.answered}` : '';
    if (key === this.pollKey) return;
    this.pollKey = key;
    this.clearPoll();
    if (!polling) return;
    const owner = inner.owner;
    this.pollTimer = this.deps.setTimeout(() => {
      this.pollTimer = null;
      if (!this.live(run)) return;
      if (this.readOnly) void this.refresh(run);
      else if (owner) void this.advance(run, owner);
    }, delay);
  }

  // ---- requests ----

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json', 'X-City-Request': '1' } : {}),
      ...(this.workspace ? { 'X-City-Workspace': this.workspace } : {}),
    };
  }

  /** A request of this run, given up after `ms` or when the run ends. */
  private async request<T>(
    ms: number,
    send: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value?: T; error?: unknown; timedOut: boolean }> {
    const controller = new AbortController();
    let timedOut = false;
    this.pending.add(controller);
    const timer = this.deps.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    try {
      return { value: await send(controller.signal), timedOut };
    } catch (error) {
      return { error, timedOut };
    } finally {
      this.deps.clearTimeout(timer);
      this.pending.delete(controller);
    }
  }

  private async readRegistration(signal: AbortSignal): Promise<RegistrationRow | null> {
    const response = await this.deps.fetch(
      `/api/base/agents/${encodeURIComponent(this.agentId)}/registration`,
      { method: 'GET', credentials: 'same-origin', headers: this.headers(false), signal },
    );
    const value = (await response.json().catch(() => null)) as {
      identities?: RegistrationRow[];
      error?: string;
      code?: unknown;
      details?: unknown;
    } | null;
    if (!response.ok)
      throw new ApiError(
        plainApiMessage(response.status, value),
        response.status,
        typeof value?.code === 'string' ? value.code : undefined,
        value?.details,
      );
    return value?.identities?.find((row) => row.chainId === BASE_MAINNET) ?? null;
  }

  /**
   * The register call reads the answer itself: a wallet conflict names the bound owner at the top
   * level of its answer. Headers and error wording are the same as api()'s.
   */
  private async postRegister(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<RegisterReply> {
    const response = await this.deps.fetch(
      `/api/base/agents/${encodeURIComponent(this.agentId)}/register`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.headers(true),
        body: JSON.stringify(body),
        signal,
      },
    );
    const value = (await response.json().catch(() => null)) as
      | (RegisterReply & {
          error?: unknown;
          code?: unknown;
          ownerAddress?: unknown;
          details?: unknown;
        })
      | null;
    if (!response.ok) {
      const code = typeof value?.code === 'string' ? value.code : undefined;
      const details = value?.details as { ownerAddress?: unknown } | undefined;
      throw new ApiError(
        plainApiMessage(response.status, value),
        response.status,
        code,
        code === 'wallet_conflict'
          ? {
              ownerAddress:
                validAddress(value?.ownerAddress) ?? validAddress(details?.ownerAddress),
            }
          : value?.details,
      );
    }
    return value as RegisterReply;
  }

  /** Makes the agent's profile public (PATCH /api/agents/:id), with the same headers as above. */
  private async patchPublic(signal: AbortSignal): Promise<void> {
    const response = await this.deps.fetch(`/api/agents/${encodeURIComponent(this.agentId)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: this.headers(true),
      body: JSON.stringify({ visibility: 'public' }),
      signal,
    });
    if (response.ok) return;
    const value = (await response.json().catch(() => null)) as {
      error?: string;
      code?: unknown;
      details?: unknown;
    } | null;
    throw new ApiError(
      plainApiMessage(response.status, value),
      response.status,
      typeof value?.code === 'string' ? value.code : undefined,
      value?.details,
    );
  }

  /** Every answer replaces what is shown as a whole, so no Base ID outlives the answer it came in. */
  private show(view: View, more: Partial<Inner> = {}) {
    // The server's own record of the owner is what the panel advances with from then on.
    const bound = validAddress(view.wallet?.ownerAddress);
    this.set({ view, ...(bound && !this.readOnly ? { owner: bound } : {}), ...more });
    this.remember();
  }

  /**
   * The answer shown now is this agent's last known status in this workspace, for the next time
   * its row shows. Only called with a live run's answer, so it is never another agent's or an
   * ended run's; a failed read (other than "not available") leaves nothing known.
   */
  private remember() {
    const { loading, loadFailed, notAvailable, view, seenWaitingAt } = this.inner;
    // Written only in the epoch this controller was created in (see baseStatusCache).
    const asOf = this.cacheEpoch;
    if (loading || (loadFailed && !notAvailable)) forgetStatus(this.agentId, this.workspace, asOf);
    else if (notAvailable)
      rememberStatus(
        this.agentId,
        this.workspace,
        { view: { identity: null, wallet: null }, notAvailable, seenWaitingAt: null },
        asOf,
      );
    else rememberStatus(this.agentId, this.workspace, { view, notAvailable, seenWaitingAt }, asOf);
  }

  /** An answer is shown: where the registration stands (or that there is none), or "not available". */
  private knows(): boolean {
    return !this.inner.loading && (!this.inner.loadFailed || this.inner.notAvailable);
  }

  /**
   * Whether the server has already accepted this owner: it is the one the server bound, or a
   * register call with it succeeded. Only for an accepted owner is a server error a passing outage
   * to wait out; any other one is shown, which brings back the form to correct the address.
   */
  private accepted(owner: string): boolean {
    const lower = owner.toLowerCase();
    return (
      validAddress(this.inner.view.wallet?.ownerAddress)?.toLowerCase() === lower ||
      acceptedOwners.get(this.agentId) === lower
    );
  }

  // What already exists for this agent: nothing, a registration in progress, or a finished one.
  // A failed read is never taken for "nothing yet": the state stays unknown until it reads.
  private async load(run: number) {
    // Read-only, an answer already shown (the agent's last one, or the one from before a pause)
    // stays until the fresh one replaces it, so the row never blanks while it reads.
    if (!this.readOnly || !this.knows())
      this.set({ loading: true, loadFailed: false, notAvailable: false });
    const result = await this.request(REQUEST_TIMEOUT_MS, (signal) =>
      this.readRegistration(signal),
    );
    if (!this.live(run)) return;
    if (result.error !== undefined || result.timedOut) {
      const notFound = result.error instanceof ApiError && result.error.status === 404;
      this.set({ loading: false, loadFailed: true, notAvailable: notFound });
      this.remember();
      return;
    }
    const row = result.value ?? null;
    this.show(
      { identity: row, wallet: row?.wallet ?? null },
      { loading: false, loadFailed: false, notAvailable: false },
    );
    if (this.readOnly) return;
    // With the wallet key, only the key this browser holds continues a registration, and only one
    // whose bound owner (if any) is that key. Otherwise the owner the server bound comes first; a
    // remembered address only for older servers.
    const resumeWith = this.resumeOwner(row?.wallet?.ownerAddress);
    if (inProgress(row) && resumeWith) {
      this.set({ owner: resumeWith });
      void this.advance(run, resumeWith);
    }
  }

  /** Read-only: re-reads the status while a registration is in progress. Never sends anything. */
  private async refresh(run: number) {
    if (this.inFlight === run) return;
    this.inFlight = run;
    const result = await this.request(REQUEST_TIMEOUT_MS, (signal) =>
      this.readRegistration(signal),
    );
    if (this.inFlight === run) this.inFlight = 0;
    if (!this.live(run)) return;
    const answered = this.inner.answered + 1;
    if (result.error !== undefined || result.timedOut) this.set({ backoff: 'poll', answered });
    else {
      const row = result.value ?? null;
      this.show({ identity: row, wallet: row?.wallet ?? null }, { backoff: null, answered });
    }
  }

  private async advance(run: number, owner: string, retry = false) {
    if (this.readOnly || !this.live(run)) return;
    // One request at a time: a slow answer is never overtaken by the next tick. A request that
    // hangs is given up after a while (the server keeps going; asking again is always safe), so
    // it can never stop the panel from advancing.
    if (this.inFlight === run) return;
    this.inFlight = run;
    this.set({
      busy: true,
      error: '',
      conflict: null,
      ...(retry ? { retryFailed: false } : {}),
    });
    try {
      const result = await this.request(REQUEST_TIMEOUT_MS, (signal) =>
        this.postRegister({ ...this.ownerBody(owner), ...(retry ? { retry: true } : {}) }, signal),
      );
      if (!this.live(run)) return;
      if (result.error === undefined && !result.timedOut && result.value) {
        const reply = result.value;
        // With the wallet key, the answer must name exactly the wallet this browser derived.
        const refused = this.keyReplyProblem(reply.wallet);
        if (refused) {
          this.set({ error: refused });
          return;
        }
        acceptedOwners.set(this.agentId, owner.toLowerCase());
        const next = { identity: reply.identity, wallet: reply.wallet ?? null };
        this.show(next, { backoff: null });
        // Older servers leave the final transaction out of this answer; their status read has it.
        if (stageOf(reply.identity) === 'confirmed' && reply.identity.txHash === undefined) {
          const read = await this.request(REQUEST_TIMEOUT_MS, (signal) =>
            this.readRegistration(signal),
          );
          const row = read.value;
          if (this.live(run) && this.inner.view === next && row?.txHash)
            this.show({ ...next, identity: { ...reply.identity, txHash: row.txHash } });
        }
        return;
      }
      const err = result.error;
      // A given-up request is no error by itself: the server may have moved on without us hearing
      // it, so the panel reads where the registration stands instead of guessing.
      if (result.timedOut) await this.recover(run, owner);
      // A server error never stops a registration in progress with an owner the server accepted:
      // the panel waits and asks again. A failed new attempt is not resent by itself; the person is
      // told, and Try again stays offered while the server accepts one.
      else if (isServerError(err) && inProgress(this.inner.view.identity) && this.accepted(owner))
        this.set({ backoff: retry ? 'retry' : 'poll', ...(retry ? { retryFailed: true } : {}) });
      else if (
        err instanceof ApiError &&
        err.code === 'wallet_conflict' &&
        this.mode.kind === 'address'
      ) {
        const details = err.details as { ownerAddress?: string | null } | undefined;
        this.set({ conflict: { ownerAddress: details?.ownerAddress ?? null, retry } });
      } else this.set({ error: errorText(err) });
    } finally {
      if (this.inFlight === run) this.inFlight = 0;
      if (this.live(run)) this.set({ busy: false, answered: this.inner.answered + 1 });
    }
  }

  /**
   * After a given-up request the panel may still show what it showed before it while the server has
   * already started or retried the registration. The server's own status decides what comes next.
   * Nothing is sent from here; a new attempt (and every retry) stays the person's own click.
   */
  private async recover(run: number, owner: string) {
    const result = await this.request(RECOVERY_TIMEOUT_MS, (signal) =>
      this.readRegistration(signal),
    );
    if (!this.live(run)) return;
    if (result.error === undefined && !result.timedOut) {
      const row = result.value ?? null;
      // Nothing started, or still failed: the same button comes back, so say why it did.
      const error =
        !row || stageOf(row) === 'failed'
          ? row && !retryAllowed(row, 'failed')
            ? 'No answer came back in time.'
            : 'No answer came back in time. You can try again.'
          : '';
      this.show({ identity: row, wallet: row?.wallet ?? null }, { backoff: null, error });
      return;
    }
    // A server error while a registration is in progress, with an owner the server accepted:
    // keep polling, just less often. Any other owner may be the cause, so it gets the error.
    if (isServerError(result.error) && inProgress(this.inner.view.identity) && this.accepted(owner))
      this.set({ backoff: 'poll' });
    // Neither answered. The error stops polling, which leaves the person a way to continue.
    else
      this.set({
        error:
          'No answer came back in time, and the status couldn’t be checked. Nothing is lost: try again in a moment.',
      });
  }

  /**
   * Makes a private agent's profile public, then starts the registration with `owner` exactly as
   * Continue does for a public agent. Both belong to `run`: an answer that arrives after the agent
   * or workspace changed (or the screen was left) is dropped and starts nothing. Once the server
   * made it public it stays public: a registration that fails afterwards shows as any failed one,
   * and nothing here ever makes the agent private again.
   */
  private async makePublic(run: number, owner: string, onPublic?: () => void) {
    this.inFlight = run;
    this.set({ busy: true, error: '', conflict: null });
    const result = await this.request(REQUEST_TIMEOUT_MS, (signal) => this.patchPublic(signal));
    if (this.inFlight === run) this.inFlight = 0;
    if (!this.live(run)) return;
    if (result.error === undefined && !result.timedOut) {
      if (this.mode.kind === 'address') saveAddress(this.agentId, owner);
      // Still busy: the registration request goes out right away, in this same run.
      this.set({ madePublic: true, confirmingPublic: false, owner });
      void this.advance(run, owner);
      try {
        onPublic?.();
      } catch {
        // Refreshing the agent elsewhere is the caller's; the registration goes on regardless.
      }
      return;
    }
    const err = result.error;
    if (err instanceof ApiError && err.code === 'no_profile')
      this.set({ busy: false, noProfile: true, confirmingPublic: false });
    // Anything else keeps the question open, so the owner can say yes again or cancel.
    else
      this.set({
        busy: false,
        error: result.timedOut
          ? 'No answer came back in time. You can try again.'
          : err instanceof ApiError && err.status < 500
            ? err.message
            : 'The profile couldn’t be made public. Try again.',
      });
  }

  // ---- the owner: a typed address, or the person's wallet key ----

  /** The request's owner fields: the typed address, or only the wallet derived from the key. */
  private ownerBody(owner: string): Record<string, unknown> {
    if (this.mode.kind === 'key') return { expectedWallet: this.mode.key?.expectedWallet };
    return { ownerAddress: owner };
  }

  /** Who continues a registration in progress: by the mode; nobody while it is still pending. */
  private resumeOwner(bound: unknown): string | null {
    if (this.mode.kind === 'pending') return null;
    if (this.mode.kind === 'key') return this.keyResume(bound);
    return validAddress(bound) ?? validAddress(savedAddress(this.agentId));
  }

  /** The held key continues a registration whose bound owner, if any, is that key; nothing else. */
  private keyResume(bound: unknown): string | null {
    const key = this.mode.kind === 'key' ? this.mode.key : null;
    if (!key) return null;
    const owner = validAddress(bound);
    return !owner || owner.toLowerCase() === key.owner.toLowerCase() ? key.owner : null;
  }

  private keyReplyProblem(wallet: BoundWallet | null | undefined): string | null {
    if (this.mode.kind !== 'key') return null;
    const key = this.mode.key;
    const address = validAddress(wallet?.address);
    const owner = validAddress(wallet?.ownerAddress);
    if (
      key &&
      address?.toLowerCase() === key.expectedWallet.toLowerCase() &&
      owner?.toLowerCase() === key.owner.toLowerCase()
    )
      return null;
    return 'The wallet answered isn’t the one your key makes for this agent. Don’t use it.';
  }

  /** The owner the person's action registers with: the key held here, or the address typed in. */
  private actionOwner(): string | null {
    if (this.mode.kind === 'pending') return null;
    if (this.mode.kind === 'key') {
      if (!this.mode.key) this.set({ error: 'Unlock your wallet key first.' });
      return this.mode.key?.owner ?? null;
    }
    const typed = this.inner.address.trim();
    if (!ADDRESS.test(typed)) {
      this.set({ error: 'Enter a wallet address: 0x followed by 40 letters and digits.' });
      return null;
    }
    return typed;
  }

  /**
   * How this panel names the owner (the screen decides: the wallet routes answer, so wallets are on
   * and the key flow applies; or they don't, and the address field stays as before).
   */
  setMode = (mode: OwnerMode) => {
    if (this.readOnly) return;
    const before = this.mode;
    this.mode = mode;
    if (mode.kind === 'key' && mode.key) this.set({ owner: mode.key.owner });
    // A registration in progress that waited for the mode (or the key) continues now, with the
    // owner the mode allows: the held key's own registration, or as before with an address.
    const unchanged =
      before.kind === mode.kind &&
      (mode.kind !== 'key' ||
        (before.kind === 'key' && before.key?.expectedWallet === mode.key?.expectedWallet));
    if (unchanged || this.inner.loading || !inProgress(this.inner.view.identity)) return;
    const resume = this.resumeOwner(this.inner.view.wallet?.ownerAddress);
    if (resume) {
      this.set({ owner: resume });
      void this.advance(this.run, resume);
    }
  };

  // ---- the person's actions (never in read-only mode) ----

  setAddress = (address: string) => {
    if (this.readOnly) return;
    this.set({ address });
  };

  reloadStatus = () => {
    const run = this.run;
    if (this.live(run)) void this.load(run);
  };

  /** A deliberate new attempt (only offered when the server accepts one). */
  retryNow = () => {
    // Nothing while the owner mode isn't known yet: it would go out with the wrong owner fields.
    if (this.readOnly || this.mode.kind === 'pending') return;
    if (this.mode.kind === 'key') {
      const owner = this.actionOwner();
      if (owner) void this.advance(this.run, owner, true);
      return;
    }
    const typed = validAddress(this.inner.address.trim());
    const next = this.snap.boundOwner ?? this.inner.owner ?? typed;
    if (!next) {
      this.set({ error: 'Enter your wallet address first: 0x followed by 40 letters and digits.' });
      return;
    }
    saveAddress(this.agentId, next);
    this.set({ owner: next, error: '' });
    void this.advance(this.run, next, true);
  };

  /** After a conflict: continue with the wallet the server already has, filled in for the person. */
  continueWithBound = (bound: string, retry: boolean) => {
    // Never with the wallet key (another owner is never taken over from an answer), nor while the
    // mode isn't known yet.
    if (this.readOnly || this.mode.kind !== 'address') return;
    saveAddress(this.agentId, bound);
    this.set({ address: bound, owner: bound, conflict: null });
    void this.advance(this.run, bound, retry);
  };

  /** Starts (or continues) the registration with the address typed in. */
  submit = () => {
    if (this.readOnly) return;
    const owner = this.actionOwner();
    if (!owner) return;
    if (this.mode.kind === 'address') saveAddress(this.agentId, owner);
    this.set({ owner, error: '' });
    void this.advance(this.run, owner);
  };

  /** Continue on a private agent's offer: checks the address, then asks the one question. */
  askMakePublic = () => {
    if (this.readOnly || this.inner.busy) return;
    if (!this.actionOwner()) return;
    this.set({ confirmingPublic: true, error: '', conflict: null });
  };

  /** Cancel: back to the offer; nothing was sent. Not while the change is on its way. */
  cancelMakePublic = () => {
    if (this.readOnly || this.inner.busy) return;
    this.set({ confirmingPublic: false, error: '' });
  };

  /**
   * The owner's yes to the question: makes the agent's profile public, then registers it with the
   * address typed in. Only after the question was asked, and once at a time.
   */
  makePublicAndRegister = (onPublic?: () => void) => {
    if (this.readOnly || !this.inner.confirmingPublic || this.inner.busy) return;
    const run = this.run;
    if (!this.live(run) || this.inFlight === run) return;
    const owner = this.actionOwner();
    if (!owner) {
      this.set({ confirmingPublic: false });
      return;
    }
    void this.makePublic(run, owner, onPublic);
  };

  /** Asks the server where a slow registration stands; never a new attempt. */
  checkAgain = () => {
    // Nothing while the owner mode isn't known yet: it would go out with the wrong owner fields.
    if (this.readOnly || this.mode.kind === 'pending') return;
    if (this.mode.kind === 'key') {
      const owner = this.keyResume(this.inner.view.wallet?.ownerAddress);
      if (owner) void this.advance(this.run, owner);
      else this.set({ error: 'Unlock your wallet key first.' });
      return;
    }
    const known = this.snap.boundOwner ?? this.inner.owner;
    if (known) void this.advance(this.run, known);
    else this.submit();
  };
}
