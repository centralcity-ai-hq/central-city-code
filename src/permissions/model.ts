import type { ConnectionRequest } from '../../shared/assistant';
import type { Agent, Connection } from '../../shared/types';

/*
 * Agent permissions v3 ("Your agents, your rules"): the page's plain rules, kept free of React so
 * tests/agent-permissions-v3.test.ts can check them. Direction is drawn as a line and said in
 * words; no arrow characters anywhere in what people read.
 */

/** Characters the page never shows: direction is drawn as a line and said in words. */
export const ARROW_GLYPHS = new RegExp(
  `[${(
    [
      [0x2190, 0x21ff], // Arrows
      [0x27f0, 0x27ff], // Supplemental Arrows-A
      [0x2900, 0x297f], // Supplemental Arrows-B
      [0x2039, 0x203a], // single angle quotation marks
      [0xab, 0xab], // double angle quotation marks
      [0xbb, 0xbb],
    ] as const
  )
    .map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)
    .join('')}]`,
);

export type CrossLists = { incoming: ConnectionRequest[]; outgoing: ConnectionRequest[] };

/** The filter tabs over "With other people". */
export type OthersFilter = 'all' | 'connected' | 'waiting' | 'ended';
export const OTHERS_FILTERS: { id: OthersFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'ended', label: 'Ended' },
];

export const crossStatusLabel: Record<ConnectionRequest['status'], string> = {
  pending: 'Waiting for approval',
  approved: 'Connected',
  denied: 'Denied',
  revoked: 'Ended',
  expired: 'Expired',
};

/** The status pill's tone: green once connected, blue while waiting, grey once over. */
export function crossTone(status: ConnectionRequest['status']): 'ok' | 'wait' | 'idle' {
  return status === 'approved' ? 'ok' : status === 'pending' ? 'wait' : 'idle';
}

/** Which tab a connection with another person belongs to. */
export function crossGroup(status: ConnectionRequest['status']): Exclude<OthersFilter, 'all'> {
  return status === 'approved' ? 'connected' : status === 'pending' ? 'waiting' : 'ended';
}

export function matchesFilter(item: ConnectionRequest, filter: OthersFilter) {
  return filter === 'all' || crossGroup(item.status) === filter;
}

/** Requests from other people that wait for this workspace's decision. */
export function pendingRequests(lists: CrossLists | null) {
  return (lists?.incoming ?? []).filter((item) => item.status === 'pending');
}

/** Everything else: decided incoming requests, then every request this workspace sent. */
export function crossHistory(lists: CrossLists | null) {
  return [
    ...(lists?.incoming ?? []).filter((item) => item.status !== 'pending'),
    ...(lists?.outgoing ?? []),
  ];
}

/** A connection with another person can be ended (approved) or withdrawn (still pending). */
export function revocable(item: ConnectionRequest) {
  return item.status === 'approved' || item.status === 'pending';
}

/** Routes that carry work now: own routes plus connections other people approved or we did. */
export function activeCount(connections: readonly Connection[], lists: CrossLists | null) {
  return (
    connections.length + crossHistory(lists).filter((item) => item.status === 'approved').length
  );
}

export function hasRoute(connections: readonly Connection[], from: string, to: string) {
  return connections.some(
    (connection) => connection.fromAgentId === from && connection.toAgentId === to,
  );
}

/** The line under a route between your own agents: which way work goes, in words. */
export function routeLine(from: string, to: string, back: boolean) {
  return back
    ? `${to} can also send work to ${from}`
    : `${from} sends work to ${to}. Not the other way.`;
}

/** What the New connection sheet would create, and why it can't. */
export function connectionPlan(
  connections: readonly Connection[],
  from: string,
  to: string,
  both: boolean,
) {
  const same = Boolean(from) && from === to;
  const forward = !same && hasRoute(connections, from, to);
  const back = !same && hasRoute(connections, to, from);
  const creates: Array<{ from: string; to: string }> = [];
  if (!same && from && to) {
    if (!forward) creates.push({ from, to });
    if (both && !back) creates.push({ from: to, to: from });
  }
  return { same, forward, back, creates, blocked: !from || !to || same || !creates.length };
}

/** Agents that can be part of a new route (not removed). */
export function liveAgents(agents: readonly Agent[]) {
  return agents.filter((agent) => !agent.revokedAt);
}

/** A short date for a row's muted line ("Oct 3" or "3 Oct", by the reader's locale). */
export function shortDate(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
}

/** When a connection with another person last changed, in words ("Connected 3 Oct"). */
export function crossWhen(item: ConnectionRequest) {
  switch (item.status) {
    case 'approved':
      return `Connected ${shortDate(item.decided_at ?? item.requested_at)}`;
    case 'pending':
      return `Asked ${shortDate(item.requested_at)}`;
    case 'denied':
      return `Denied ${shortDate(item.decided_at ?? item.requested_at)}`;
    case 'revoked':
      return `Ended ${shortDate(item.revoked_at ?? item.decided_at ?? item.requested_at)}`;
    case 'expired':
      return `Expired ${shortDate(item.expires_at)}`;
  }
}
