/*
 * My agents v4 · Base: which of the mockup's Base states an agent is in, and the one-line status
 * its row shows on the agent's home (docs/design/my-agents-v4-mockup.html). Pure, no React.
 */
import type { Agent } from '../../../shared/types';
import { finishedId, type IdentityView, type Stage } from '../../base/baseRegistrationModel';

export type BaseScreenState =
  | 'loading'
  | 'error'
  | 'unavailable'
  | 'start'
  /** A private agent's one question before its profile is made public (decision G4, option B). */
  | 'confirm'
  | 'registering'
  | 'slow'
  | 'finalizing'
  | 'final'
  | 'rechecking'
  | 'failed';

/** A registration still waiting for its Base ID after this long shows "Taking longer than usual". */
export const SLOW_AFTER_MS = 60_000;

const WAITING: readonly Stage[] = ['registering', 'handing_over'];

/** Whether a registration has waited for its Base ID for longer than usual. */
export function isSlow(stage: Stage | null, since: number | null, now: number): boolean {
  return stage !== null && WAITING.includes(stage) && since !== null && now - since > SLOW_AFTER_MS;
}

/** Milliseconds until a waiting registration turns slow, or null when it never will from here. */
export function msUntilSlow(stage: Stage | null, since: number | null, now: number): number | null {
  if (stage === null || !WAITING.includes(stage) || since === null) return null;
  const left = since + SLOW_AFTER_MS - now;
  return left >= 0 ? left + 1 : null;
}

/**
 * Base usually finalizes a block 15 to 30 minutes after it is made, at times later still. Past
 * this long the finalizing line says it is taking longer than usual.
 */
export const FINALIZING_USUAL_MS = 30 * 60_000;

const FINALIZING: readonly Stage[] = ['registered', 'finalizing'];

/**
 * Since when Base has been finalizing the registration: when its Base ID was first seen in a
 * block, else when the attempt started. Null in any other stage, or when the server doesn't say.
 */
export function finalizingSince(identity: IdentityView | null, stage: Stage | null): number | null {
  if (!identity || stage === null || !FINALIZING.includes(stage)) return null;
  for (const at of [identity.idSeenAt, identity.startedAt])
    if (typeof at === 'number' && Number.isFinite(at)) return at;
  return null;
}

/** The quiet line while Base finalizes: its usual time, until that has passed. */
export function finalizingLine(since: number | null, now: number): string {
  return since !== null && now - since > FINALIZING_USUAL_MS
    ? 'Finalizing on Base · taking longer than usual'
    : 'Finalizing on Base · usually 15–30 min';
}

/** Milliseconds until the finalizing line says "taking longer", or null when it never will. */
export function msUntilFinalizingLong(since: number | null, now: number): number | null {
  if (since === null) return null;
  const left = since + FINALIZING_USUAL_MS - now;
  return left >= 0 ? left + 1 : null;
}

export interface BaseScreenInput {
  loading: boolean;
  loadFailed: boolean;
  /** The server doesn't know the agent as one the person may register (404). */
  notAvailable: boolean;
  /** Only public agents can become Base agents. */
  isPublic: boolean;
  /** The agent has a profile, so a private one can be made public; agents without one cannot. */
  hasProfile: boolean;
  /** The owner pressed Continue on a private agent: the question before it is made public. */
  confirmingPublic: boolean;
  /** The server made the profile public on this screen (the agent itself may not show it yet). */
  madePublic: boolean;
  /** The server refused to make it public: the agent has no profile (409 no_profile). */
  noProfile: boolean;
  identity: IdentityView | null;
  stage: Stage | null;
  /** A request is on its way (the first one makes the start screen show Registering). */
  busy: boolean;
  waitingSince: number | null;
  now: number;
}

/** What the Base screen needs to know of the agent: whether it is public, and has a profile. */
export function baseProfileOf(agent: Pick<Agent, 'visibility' | 'manifestHash' | 'revision'>): {
  isPublic: boolean;
  hasProfile: boolean;
} {
  return {
    isPublic: agent.visibility === 'public',
    // Only agents made from a manifest have a profile (and so a visibility or a revision).
    hasProfile:
      agent.visibility !== undefined || Boolean(agent.manifestHash) || agent.revision !== undefined,
  };
}

/** Public for Base: the agent says so, or the server made it public on this screen. */
export const publicForBase = (input: Pick<BaseScreenInput, 'isPublic' | 'madePublic'>) =>
  input.isPublic || input.madePublic;

/**
 * Whether the server can know the agent for Base at all. Only an agent made from a manifest has a
 * profile, and the Base routes answer 404 for an agent without a manifest
 * (server/base/identity/routes.ts), so one without a profile is "not available" without asking.
 */
export const mayHaveBase = (profile: Pick<BaseScreenInput, 'isPublic' | 'hasProfile'>) =>
  profile.isPublic || profile.hasProfile;

export function baseScreenState(input: BaseScreenInput): BaseScreenState {
  const { identity, stage } = input;
  // Known without the server, so never loading (and nothing is read for it).
  if (!mayHaveBase(input) && !input.madePublic) return 'unavailable';
  if (input.loading) return 'loading';
  if (input.notAvailable) return 'unavailable';
  if (input.loadFailed) return 'error';
  if (!identity || !stage) {
    const isPublic = publicForBase(input);
    const canMakePublic = !isPublic && input.hasProfile && !input.noProfile;
    // The question stays while its answer is on its way; Registering follows once it is public.
    if (canMakePublic && input.confirmingPublic) return 'confirm';
    if (input.busy) return 'registering';
    return isPublic || canMakePublic ? 'start' : 'unavailable';
  }
  switch (stage) {
    case 'confirmed':
      return finishedId(identity, stage) !== null ? 'final' : 'registering';
    case 'failed':
      return 'failed';
    case 'rechecking':
      return 'rechecking';
    case 'registered':
    case 'finalizing':
      return finishedId(identity, stage) !== null ? 'finalizing' : 'registering';
    default:
      return isSlow(stage, input.waitingSince, input.now) ? 'slow' : 'registering';
  }
}

/** The Base ID the finalizing and final screens show; never one that a replaced block can change. */
export function baseIdOf(identity: IdentityView | null, stage: Stage | null): string | null {
  return identity && stage ? finishedId(identity, stage) : null;
}

/** The passport's short code, the last part of the agent's public address (…/a/fjPsW7). */
export function passportCode(agentUri: string): string {
  const path = agentUri.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1);
}

export interface BaseRowSummary {
  /** The value next to "Base"; null while it is not known yet (its place stays kept). */
  text: string | null;
  tone: 'muted' | 'strong' | 'bad';
  spinner: boolean;
  /** The check mark, only for a confirmed Base ID. */
  check: boolean;
  /** The quiet line under the row while Base finalizes. */
  sub: string | null;
}

/** `since` and `now` time the finalizing line (see finalizingSince and finalizingLine). */
export function baseRowSummary(
  state: BaseScreenState,
  id: string | null,
  since: number | null = null,
  now = 0,
): BaseRowSummary {
  const row = (text: string | null, more: Partial<BaseRowSummary> = {}): BaseRowSummary => ({
    text,
    tone: 'muted',
    spinner: false,
    check: false,
    sub: null,
    ...more,
  });
  switch (state) {
    case 'start':
    case 'confirm':
      return row('Not yet');
    case 'registering':
      return row('Registering', { spinner: true });
    case 'slow':
      return row('Taking longer');
    case 'finalizing':
      return row(`ID ${id}`, { tone: 'strong', sub: finalizingLine(since, now) });
    case 'final':
      return row(`ID ${id}`, { tone: 'strong', check: true });
    case 'rechecking':
      return row('Re-checking', { spinner: true });
    case 'failed':
      return row('Didn’t go through', { tone: 'bad' });
    case 'unavailable':
      return row('Not available');
    default:
      return row(null);
  }
}

/**
 * A new attempt for a registration that is still open (registering, taking longer, re-checking):
 * only when the server says it takes one (canRetry: stuck before minting for 10 minutes, or a mint
 * lost for 30). An older server without canRetry gets none here: retryAllowed's guess for it would
 * offer one on every open registration at once, and the screen follows those by itself.
 */
export function openRetryOffered(identity: IdentityView | null, stage: Stage | null): boolean {
  return identity !== null && stage !== null && stage !== 'failed' && identity.canRetry === true;
}
