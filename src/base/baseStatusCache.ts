import type { View } from './baseRegistrationModel';

/*
 * The last Base status answer per (agent, workspace) in this page session, so an agent that is
 * opened again shows where its registration stood at once while a fresh read replaces it. Only
 * the server's answers go in (written by the controller that read them), the key holds the
 * workspace as well as the agent, so another agent's or workspace's answer is never found, and
 * only the most recent few are kept. All of it is forgotten when the signed-in person changes.
 *
 * Display only: just the read-only status (the agent's home row, which offers no action) starts
 * from it. The Base screen and the classic panel always wait for their own fresh read before they
 * offer anything (register, make public, retry), as without it.
 */

export interface KnownStatus {
  view: View;
  /** The server answered 404: no Base for this agent. */
  notAvailable: boolean;
  /** When this page first saw the registration waiting for its Base ID ("Taking longer"). */
  seenWaitingAt: number | null;
}

/** Enough for every agent a person switches between; the oldest answer goes first. */
export const KNOWN_STATUS_LIMIT = 50;

const known = new Map<string, KnownStatus>();
/**
 * Which signed-in person's answers the map holds: bumped by forgetAllStatuses. A controller keeps
 * the epoch it was created in and writes only while it is still current, so a read of the last
 * person that answers after the switch can never put their status back for the next one.
 */
let epoch = 0;

/** The epoch now (a controller captures it when it is created). */
export function statusEpoch(): number {
  return epoch;
}
const keyOf = (agentId: string, workspace: string | null) => JSON.stringify([workspace, agentId]);

export function knownStatus(agentId: string, workspace: string | null): KnownStatus | null {
  return known.get(keyOf(agentId, workspace)) ?? null;
}

/** A fresh answer replaces the one known before; one from an earlier person's epoch is dropped. */
export function rememberStatus(
  agentId: string,
  workspace: string | null,
  status: KnownStatus,
  asOf: number = epoch,
) {
  if (asOf !== epoch) return;
  const key = keyOf(agentId, workspace);
  known.delete(key);
  known.set(key, status);
  for (const oldest of known.keys()) {
    if (known.size <= KNOWN_STATUS_LIMIT) break;
    known.delete(oldest);
  }
}

/** A read that failed leaves nothing known to show the next time (in its own epoch only). */
export function forgetStatus(agentId: string, workspace: string | null, asOf: number = epoch) {
  if (asOf !== epoch) return;
  known.delete(keyOf(agentId, workspace));
}

/**
 * The signed-in person changed (signed out, or another person's session; src/Root.tsx): nothing
 * of the last person's agents stays for the next one on this device.
 */
export function forgetAllStatuses() {
  known.clear();
  epoch++;
}
