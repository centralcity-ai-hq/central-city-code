/*
 * The owner's permission for an agent to pay on its own (Base Pay P2b), on the agent's Spending
 * limit screen. Server: server/base/wallet/agent-pay-consent.ts over agent-pay-routes.ts:
 *
 *   GET    …/wallet/agent-pay   the current limit, the permission, and what a confirm now may store
 *   PUT    …/wallet/agent-pay   {permissionHash, recipients}: the limit and the recipients shown
 *   DELETE …/wallet/agent-pay   the permission withdrawn (every new spend stops at its next check)
 *
 * What the screen shows is what it sends: the PUT carries the hash of the limit on screen and the
 * view's `confirmRecipients` exactly as read, never anything the page works out itself. A view read
 * while paying Feed services was off therefore stores Central City agents only, even if Feed pay is
 * on by the time it is sent; one read while it was on and sent after it went off is refused
 * (409 scope_changed) and read again, so the owner looks at the narrower terms before confirming.
 * A changed limit (409 limit_changed) is read again too, and so is a confirm that failed for any
 * other reason (it may have been stored even without an answer): the screen shows what is stored,
 * or says plainly that it can't tell. Nothing here moves money or signs anything.
 */
import { api, ApiError } from '../../api';
import { DEFAULT_PER_CALL_MAX_RAW } from '../../../shared/feed-pay';
import { usdcText } from './limits';

/** Who an agent with this permission may pay: Central City agents, and Feed services when confirmed. */
export type AgentPayRecipients = 'central-city-agents' | 'central-city-agents-and-feed-services';
const RECIPIENTS: readonly AgentPayRecipients[] = [
  'central-city-agents',
  'central-city-agents-and-feed-services',
];

/** GET …/wallet/agent-pay (and the PUT and DELETE answers), as the server builds it. */
export interface AgentPayView {
  chainId: number;
  token: 'USDC';
  scope: {
    /** With a permission for the current limit: what it allows now, never wider than stored. */
    recipients: AgentPayRecipients;
    token: 'USDC';
    /** The limit a permission given now covers; null without an active limit. */
    withinLimit: {
      permissionHash: string;
      period: string | null;
      capRaw: string | null;
      capDisplay: string | null;
    } | null;
  };
  consent: {
    permissionHash: string;
    /** What the owner confirmed, as stored. */
    recipients: AgentPayRecipients;
    grantedAt: number;
    coversCurrentLimit: boolean;
  } | null;
  mayPay: boolean;
  /** What a confirm from this view stores: sent back exactly as read. */
  confirmRecipients: AgentPayRecipients;
  /** The permission covers Central City agents only, and confirming again adds Feed services. */
  reconfirmAddsFeedServices: boolean;
}

/** The server's answer couldn't be read as a view: nothing is shown or sent from it. */
export class AgentPayReadError extends Error {
  constructor() {
    super('This page couldn’t read the answer. Try again.');
  }
}

const isRecipients = (value: unknown): value is AgentPayRecipients =>
  RECIPIENTS.includes(value as AgentPayRecipients);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The view is about this limit: its active limit has this hash. */
const aboutLimit = (view: AgentPayView, permissionHash: string) =>
  !!view.scope.withinLimit && sameHash(view.scope.withinLimit.permissionHash, permissionHash);

/** The view, or null when the answer isn't one (a wrong recipient value, no hash, …). */
export function agentPayViewFrom(value: unknown): AgentPayView | null {
  if (!isRecord(value) || !isRecord(value.scope)) return null;
  const { scope, consent } = value;
  if (!isRecipients(scope.recipients) || !isRecipients(value.confirmRecipients)) return null;
  if (typeof value.mayPay !== 'boolean' || typeof value.reconfirmAddsFeedServices !== 'boolean')
    return null;
  const limit = scope.withinLimit;
  if (limit !== null && !(isRecord(limit) && typeof limit.permissionHash === 'string')) return null;
  if (limit && !HASH.test(limit.permissionHash as string)) return null;
  if (
    consent !== null &&
    !(
      isRecord(consent) &&
      typeof consent.permissionHash === 'string' &&
      isRecipients(consent.recipients) &&
      typeof consent.grantedAt === 'number' &&
      Number.isFinite(consent.grantedAt) &&
      typeof consent.coversCurrentLimit === 'boolean'
    )
  )
    return null;
  return value as unknown as AgentPayView;
}

const path = (agentId: string) =>
  `/api/base/agents/${encodeURIComponent(agentId)}/wallet/agent-pay`;

function viewOf(answer: unknown): AgentPayView {
  const view = agentPayViewFrom(answer);
  if (!view) throw new AgentPayReadError();
  return view;
}

/** GET: the view, or 'off' while the server doesn't offer it here (404: off, or not this wallet). */
export async function readAgentPay(
  agentId: string,
): Promise<{ kind: 'view'; view: AgentPayView } | { kind: 'off' }> {
  try {
    return { kind: 'view', view: viewOf(await api<unknown>(path(agentId), undefined, 'GET')) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'off' };
    throw error;
  }
}

/**
 * What the PUT sends for a view on screen: the hash of its limit and its `confirmRecipients`
 * exactly as read. Null when the view has no limit to give a permission for.
 */
export function consentRequest(
  view: AgentPayView,
): { permissionHash: string; recipients: AgentPayRecipients } | null {
  const limit = view.scope.withinLimit;
  if (!limit) return null;
  return { permissionHash: limit.permissionHash, recipients: view.confirmRecipients };
}

/** Why a confirm was refused and read again: who it covers changed, or the limit did. */
export type AgentPayChange = 'scope' | 'limit';
const CHANGES: Readonly<Record<string, AgentPayChange>> = {
  scope_changed: 'scope',
  limit_changed: 'limit',
  no_spending_limit: 'limit',
};

export type AllowResult =
  | { kind: 'allowed'; view: AgentPayView }
  /** Nothing was stored; `view` is the one read again (null: no longer offered here). */
  | { kind: 'changed'; change: AgentPayChange; view: AgentPayView | null };

/**
 * PUT for the view on screen (also "Also allow Feed services": the same request, its
 * `confirmRecipients` being the wider one). A 409 because what it covers or the limit changed reads
 * the view again and answers it, for the owner to look at before confirming again.
 */
export async function allowAgentPay(agentId: string, shown: AgentPayView): Promise<AllowResult> {
  const body = consentRequest(shown);
  if (!body) {
    const read = await readAgentPay(agentId);
    return { kind: 'changed', change: 'limit', view: read.kind === 'view' ? read.view : null };
  }
  try {
    return { kind: 'allowed', view: viewOf(await api<unknown>(path(agentId), body, 'PUT')) };
  } catch (error) {
    const change =
      error instanceof ApiError && error.status === 409 && error.code
        ? CHANGES[error.code]
        : undefined;
    if (!change) throw error;
    const read = await readAgentPay(agentId);
    const view = read.kind === 'view' ? read.view : null;
    // Refused for whom it covers while the limit changed too (the server checks that first): the
    // limit is what changed for the owner, and the card is read again for it.
    const moved = change === 'scope' && view !== null && !aboutLimit(view, body.permissionHash);
    return { kind: 'changed', change: moved ? 'limit' : change, view };
  }
}

/**
 * A refusal: the server answered that it didn't take the request (4xx), so nothing was stored.
 * Anything else (a server error, no answer at all, an answer that is no view) may have been stored.
 */
export const refusedForSure = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;

/** The view says exactly what a confirm sent is stored, for the limit it covers now. */
export function stores(
  view: AgentPayView,
  sent: { permissionHash: string; recipients: AgentPayRecipients },
): boolean {
  const consent = view.consent;
  return (
    !!consent &&
    consent.coversCurrentLimit &&
    sameHash(consent.permissionHash, sent.permissionHash) &&
    consent.recipients === sent.recipients
  );
}

export type AllowCheck =
  /** Read again: what was sent is stored (its answer was lost on the way). */
  | { kind: 'stored'; view: AgentPayView }
  /** Not stored: refused for sure (`view` null: not read again), or the view read again says so. */
  | { kind: 'not-stored'; sure: boolean; view: AgentPayView | null }
  /** No answer to go by and no new read either: whether it was stored is unknown. */
  | { kind: 'unknown' };

/**
 * After a confirm failed for another reason than a change (allowAgentPay threw): the view is read
 * again, so the screen shows what is stored now, never just what it showed before the confirm.
 */
export async function recheckAllow(
  agentId: string,
  shown: AgentPayView,
  error: unknown,
): Promise<AllowCheck> {
  const sent = consentRequest(shown);
  const sure = refusedForSure(error);
  let view: AgentPayView | null = null;
  try {
    const read = await readAgentPay(agentId);
    if (read.kind === 'view') view = read.view;
  } catch {
    // Not read again: below, a refusal still says nothing was stored; anything else is unknown.
  }
  if (view && sent && stores(view, sent)) return { kind: 'stored', view };
  if (view || sure) return { kind: 'not-stored', sure, view };
  return { kind: 'unknown' };
}

/** DELETE: the permission withdrawn (idempotent); answers the view after it. */
export async function withdrawAgentPay(agentId: string): Promise<AgentPayView> {
  return viewOf(await api<unknown>(path(agentId), {}, 'DELETE'));
}

// ---------------------------------------------------------------------------------------------
// What the screen shows

const berlinTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "Thu 15 Oct 2026, 14:02", in Berlin, from ms (with the year: a permission can be old). */
export function givenAt(ms: number): string {
  const part = Object.fromEntries(
    berlinTime.formatToParts(ms).map((each) => [each.type, each.value] as const),
  );
  return `${part.weekday} ${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute}`;
}

/** The limit the screen shows on its card, for the section to be about. */
export interface ShownLimit {
  permissionHash: string;
  state: 'signed' | 'approved' | 'revoke_pending' | 'revoked';
}

export type AgentPayPanel =
  /** No active limit on the card (none, or one being revoked): nothing shown. */
  | { k: 'hidden' }
  /** The view is about another limit than the card, or none: read both again, offer nothing. */
  | { k: 'mismatch' }
  | {
      k: 'shown';
      /** The permission covers the limit on the card: the agent may pay on its own. */
      allowed: boolean;
      /** When the live permission was given (allowed only). */
      grantedAt: number | null;
      /** A permission given for an earlier limit, when (not allowed only). */
      earlierAt: number | null;
      /** Who the agent may pay: allowed, what it allows now; else what confirming now allows. */
      recipients: AgentPayRecipients;
      /** Allowed for Central City agents only: confirming again also allows Feed services. */
      addsFeed: boolean;
      /** Confirmed with Feed services, while paying them is switched off right now. */
      feedOff: boolean;
    };

/** What the section shows for the view next to the limit on the card. */
export function agentPayPanel(view: AgentPayView, limit: ShownLimit | null): AgentPayPanel {
  // Only for an active limit: a limit being revoked already blocks every spend.
  if (!limit || (limit.state !== 'signed' && limit.state !== 'approved')) return { k: 'hidden' };
  const within = view.scope.withinLimit;
  // The view has no active limit while the card shows one (revoked or replaced meanwhile), or
  // another limit: both are read again before anything is offered.
  if (!within || !sameHash(within.permissionHash, limit.permissionHash)) return { k: 'mismatch' };
  const consent = view.consent;
  const allowed = !!(
    view.mayPay &&
    consent?.coversCurrentLimit &&
    sameHash(consent.permissionHash, within.permissionHash)
  );
  return {
    k: 'shown',
    allowed,
    grantedAt: allowed && consent ? consent.grantedAt : null,
    earlierAt: !allowed && consent && !consent.coversCurrentLimit ? consent.grantedAt : null,
    recipients: allowed ? view.scope.recipients : view.confirmRecipients,
    addsFeed:
      allowed &&
      view.reconfirmAddsFeedServices &&
      view.scope.recipients === 'central-city-agents' &&
      view.confirmRecipients === 'central-city-agents-and-feed-services',
    feedOff:
      allowed &&
      consent?.recipients === 'central-city-agents-and-feed-services' &&
      view.scope.recipients === 'central-city-agents',
  };
}

/** The status line: allowed since when, or not allowed (and why, for an earlier limit). */
export function statusText(panel: Extract<AgentPayPanel, { k: 'shown' }>, name: string): string {
  if (panel.allowed && panel.grantedAt !== null)
    return `Allowed since ${givenAt(panel.grantedAt)} (Berlin time).`;
  if (panel.earlierAt !== null)
    return `Not allowed for this limit. You allowed it on ${givenAt(panel.earlierAt)} (Berlin time) for an earlier limit; a new limit needs your OK again.`;
  return `Not allowed. ${name} can’t pay on its own.`;
}

/** The most one service call may cost, fee included, unless the owner set a lower maximum. */
const PER_CALL_MAX = usdcText(String(DEFAULT_PER_CALL_MAX_RAW));

/**
 * What paying a Feed service costs, and its bound: Central City's 10% comes on top for an outside
 * service and is part of the price for one sold by a Central City agent; then the per-call maximum.
 */
const feeAndMax = (name: string) =>
  `Central City’s 10% fee comes on top of the price for outside services and is included in the price for services sold by Central City agents. One call never costs more than ${name}’s per-call maximum (${PER_CALL_MAX} USDC unless you set a lower one), fee included.`;

/** One line about paying services in the Feed: the fee, on top or included, and the maximum. */
export const feedLine = (name: string) => `Services listed in the Feed. ${feeAndMax(name)}`;

/** Allowed for Central City agents only, while confirming again would add Feed services. */
export const addFeedText = (name: string) =>
  `${name} doesn’t pay services listed in the Feed on its own yet. If you also allow those, ${feeAndMax(name)}`;

/** Who the agent may pay, a line each. */
export function recipientLines(recipients: AgentPayRecipients, name: string): string[] {
  const agents = 'Other Central City agents.';
  return recipients === 'central-city-agents-and-feed-services'
    ? [agents, feedLine(name)]
    : [agents];
}

/** What bounds every payment, under the list. `limit` is the card's ("20.00 USDC a day"). */
export const boundsText = (name: string, limit: string) =>
  `Only within the limit you signed: ${limit}. ${name} pays without asking you each time, and payments can’t be undone. You can withdraw this at any time.`;

/** The line under the withdraw confirmation. */
export const withdrawPrompt = (name: string) =>
  `${name} stops paying on its own at once. A payment already sent to Base can’t be stopped.`;

/**
 * Why the confirm didn't go through, in words that match what is on screen now. `addingFeed`: it
 * was "Also allow Feed services"; `now`: the view read again (null: no longer offered here). When
 * that view no longer offers Feed services, there is nothing to check and confirm again.
 */
export function changedText(
  change: AgentPayChange,
  name: string,
  addingFeed = false,
  now: AgentPayView | null = null,
): string {
  if (
    change === 'scope' &&
    addingFeed &&
    now?.confirmRecipients !== 'central-city-agents-and-feed-services'
  )
    return 'Feed services can’t be added right now, so nothing was changed.';
  return change === 'scope'
    ? `What ${name} may pay changed while this page was open, so nothing was saved. Check it again, then confirm.`
    : 'The spending limit changed, so nothing was saved. Check it again, then confirm.';
}

/** A failed request, in plain words. */
export function agentPayFailure(error: unknown): string {
  if (error instanceof ApiError || error instanceof AgentPayReadError) return error.message;
  return 'Something went wrong. Try again.';
}

/** The same words without a closing "Try again.", for a line with its own button to try again. */
export const withoutTryAgain = (text: string) => text.replace(/\s*Try again\.$/, '').trim();

/**
 * A confirm that didn't go through and stored nothing: `sure`, the server refused it; else no clear
 * answer came back and the view read again says so. `addingFeed`: it was "Also allow Feed services".
 */
export function notStoredText(error: unknown, sure: boolean, addingFeed: boolean): string {
  const nothing = addingFeed ? 'nothing was changed' : 'nothing was saved';
  if (!sure) return `No clear answer came back, so this page read it again: ${nothing}.`;
  const reason = withoutTryAgain(agentPayFailure(error));
  const said = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return `${said} ${nothing.charAt(0).toUpperCase()}${nothing.slice(1)}.`;
}

/** No clear answer and no new read either: whether the confirm was stored isn't known. */
export const unsureText = (name: string, addingFeed: boolean) =>
  addingFeed
    ? `No clear answer came back, so this page can’t tell whether ${name} may now also pay services listed in the Feed.`
    : `No clear answer came back, so this page can’t tell whether ${name} may now pay on its own.`;
