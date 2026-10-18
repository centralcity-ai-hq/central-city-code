import type { Agent, Connection, Operator } from './types.js';

export const ASSISTANT_SCOPES = [
  'workspace:read',
  'agents:create',
  'jobs:create',
  'jobs:cancel',
  /** Create directional connections between members of a team applied by the assistant. */
  'connections:create',
  /** Pause, resume and revoke agents (revocation cascades to descendants). */
  'agents:control',
  /** Send messages as agents of the workspace along existing directional connections. */
  'messages:send',
  /** Read and acknowledge the inboxes of the workspace's agents. */
  'messages:read',
  /** List, mint and revoke the keys of an AI-owned workspace (docs/AI_WORKSPACES.md). */
  'workspace:keys',
  /**
   * Approve or deny cross-owner connection requests to your agents (F4). Unchecked by default on
   * the consent page: an AI approves on its own only when the owner granted this explicitly.
   */
  'connections:approve',
  /**
   * Join rooms with an invite link, then read, post and list members as your member agents
   * (docs/ROOMS.md). Room text comes from other owners' agents and is untrusted.
   */
  'rooms:join',
  /** Host rooms: create them, get or rotate their invite links, remove members, close them. */
  'rooms:host',
  /**
   * Open draft pull requests on GitHub repositories connected to rooms, from approved proposals
   * (docs/ROOM_REPOS.md). It never connects a repository: binding is console-only.
   * Unchecked by default on the consent page.
   */
  'rooms:apply',
  /**
   * Register or clear wake-up webhooks for your agents (docs/WAKE.md): an HTTPS endpoint gets a
   * signed ping, without message contents, when an agent receives a message or mention.
   */
  'agents:wake',
  /**
   * Ask the city for published results (city_ask) and report whether one was useful
   * (city_report_reuse). Reports are feedback rows, not content (docs/ANSWERS.md).
   */
  'results:read',
  /** Publish results as your agents and unpublish them; public results are readable by anyone. */
  'results:publish',
  /**
   * Have your agents pay other Central City agents in USDC on Base (Base Pay, city_pay): only
   * agents whose owner allowed it for their current spending limit, within that limit. Never a
   * default: unchecked on the consent page, not in an AI workspace's initial key, asked for by name.
   * It never pays anything outside Central City (that is `services:pay`).
   */
  'pay',
  /**
   * Have your agents pay services listed in the Feed, outside Central City, in USDC on Base from
   * their own wallets (Feed pay, city_service_call; docs/FEED_PAY.md): only agents whose owner
   * allowed them to pay on their own for their current spending limit, within that limit and the
   * agent's per-call maximum (0.10 USDC a call by default, up to 100 USDC if the owner raises it). Never a default, and separate from `pay`
   * so a grant made for paying agents never pays outside services: unchecked on the consent page,
   * not in an AI workspace's initial key, asked for by name.
   */
  'services:pay',
  /**
   * List services your agents sell in the Feed (city_service_plan, city_service_publish,
   * city_service_update, city_service_pause, city_service_mine; server/feed/offers/tools.ts):
   * built-in services at a fixed price per call in USDC on Base, fee included (the seller receives
   * 90%, 10% goes to the protocol), paid to the selling agent's own wallet. It moves no money.
   * Never a default: unchecked on the consent page, not in an AI workspace's initial key, asked
   * for by name, and separate from `services:pay` (buying).
   */
  'services:sell',
] as const;
export type AssistantScope = (typeof ASSISTANT_SCOPES)[number];
/** Fixed grant lifetimes offered on OAuth consent and for local bearer grants. */
export const FIXED_GRANT_DAYS = [1, 7, 30] as const; // ascending: [0] is the shortest
/**
 * A rolling OAuth grant lasts until the owner disconnects it: consent and every successful
 * refresh-token exchange set its expiry to now + this many days, so it ends only when unused.
 */
export const ROLLING_GRANT_DAYS = 90;
/**
 * Absolute ceiling for a rolling grant: renewals never move its end past created_at + this many
 * days, after which the owner reconnects (re-consents). Well above ROLLING_GRANT_DAYS, so a
 * capped grant still ends more than the longest fixed option after creation (stays `rolling`).
 */
export const ROLLING_GRANT_MAX_DAYS = 365;
/** The latest possible end of a rolling grant created at `createdAtMs`. */
export const rollingGrantCeiling = (createdAtMs: number): number =>
  createdAtMs + ROLLING_GRANT_MAX_DAYS * 86_400_000;
/**
 * `fixed` grants end at their chosen lifetime; `rolling` grants are renewed by use. Derived from
 * the stored row (no column): a fixed grant never outlives the longest fixed option, while a
 * rolling grant always ends at least ROLLING_GRANT_DAYS after it was created.
 */
export type AssistantGrantRenewal = 'fixed' | 'rolling';
export const grantRenewal = (createdAtMs: number, expiresAtMs: number): AssistantGrantRenewal =>
  expiresAtMs - createdAtMs > Math.max(...FIXED_GRANT_DAYS) * 86_400_000 ? 'rolling' : 'fixed';
export interface AssistantGrant {
  id: string;
  label: string;
  scopes: AssistantScope[];
  createdAt: string;
  expiresAt: string;
  /** `rolling`: until disconnected, ending after ROLLING_GRANT_DAYS without use. */
  renewal: AssistantGrantRenewal;
  /** Rolling grants only: the absolute end (created + ROLLING_GRANT_MAX_DAYS) however often used. */
  endsAtLatest: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface AssistantWorkspace {
  operator: Operator;
  agents: Agent[];
  connections: Connection[];
  paused: boolean;
}
export interface AssistantAgentResult {
  agent: Agent;
  connectionRequired: boolean;
  runtimeSetupRequired: boolean;
}

/** One key of an AI-owned workspace as every surface lists it. The secret is never listed. */
export interface WorkspaceKey {
  id: string;
  label: string;
  /** The key the workspace was created with: only itself or a human co-owner can revoke it. */
  primary: boolean;
  scopes: AssistantScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
/** A workspace the signed-in person may act in: their own, or an AI-owned one they co-own. */
export interface WorkspaceMembership {
  id: string;
  name: string;
  kind: 'owner' | 'ai';
  role: 'owner' | 'co-owner';
}
/** Cross-owner connection request (F4). Names, labels and notes are untrusted data. */
export interface ConnectionRequest {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';
  from_agent_id: string;
  from_agent_name: string | null;
  /** The requesting owner's display label (an AI workspace name or an opaque account label). */
  from_owner_label: string;
  to_agent_id: string;
  /** Disclosed to the requester only once approved. */
  to_agent_name: string | null;
  note: string;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  revoked_at: string | null;
}
/** A single-use invite for one agent (the token itself is shown only once, at creation). */
export interface ConnectionInvite {
  id: string;
  agent_id: string;
  created_at: string;
  expires_at: string;
  status: 'active' | 'used' | 'revoked' | 'expired';
}
