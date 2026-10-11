/*
 * My agents v4 · Rotate key, Auto-reply, Permissions and Remove: the pure rules behind the
 * settings screens (docs/design/my-agents-v4-mockup.html). Remove itself lives in the agent pane
 * (AgentPane.tsx); its rules here give it the G8 sub-agent warning. No React, no requests.
 */
import type { ConnectionRequest } from '../../../shared/assistant';
import type { Agent, Connection } from '../../../shared/types';
import type { ModelOption, ResponderSettingsView } from '../../responder/contract';
import { pauseCopy, providerName } from '../../responder/copy';
import { confirmsName, removalDescendants } from '../myAgentsModel';

/* ---------- Rotate key ---------- */

/**
 * Only agents with a runtime key can rotate it: external agents that are not removed. Hosted
 * agents have no key (the server answers 409), so the screen never offers it for them.
 */
export function canRotate(
  agent: Pick<Agent, 'mode' | 'revokedAt' | 'status'> | null | undefined,
): boolean {
  return Boolean(
    agent && agent.mode === 'external' && !agent.revokedAt && agent.status !== 'revoked',
  );
}

/** The key hint the server sends ("…a91f"); null when there is none to show. */
export function keyHint(agent: Pick<Agent, 'credentialHint'> | null | undefined): string | null {
  const hint = agent?.credentialHint?.trim();
  return hint ? hint : null;
}

/** The new key as the mockup draws it: bullets and its last three characters. */
export function maskKey(token: string): string {
  return `${'•'.repeat(24)}${token.slice(-3)}`;
}

/* ---------- Remove (the agent pane's in-pane Remove) ---------- */

export interface RemoveView {
  /** The agent is in the workspace and not removed yet. */
  removable: boolean;
  /** Live agents created under this one (the whole lineage below it); removal takes them too. */
  subAgents: number;
}

export function removeView(agents: readonly Agent[], id: string): RemoveView {
  const agent = agents.find((item) => item.id === id);
  if (!agent || agent.revokedAt || agent.status === 'revoked')
    return { removable: false, subAgents: 0 };
  return { removable: true, subAgents: removalDescendants([...agents], id).length };
}

/** The warning under Remove when sub-agents go with it; null when there are none. */
export function subAgentWarning(name: string, count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? `The 1 agent created under ${name} is removed too.`
    : `The ${count} agents created under ${name} are removed too.`;
}

/** The typed name matches the agent's name (trimmed, case-sensitive). */
export function confirmed(typed: string, name: string): boolean {
  return confirmsName(typed, name);
}

/* ---------- Auto-reply ---------- */

export type AutoReplyState =
  | 'loading'
  | 'error'
  /** This server has no auto-reply (the routes answer 404). */
  | 'unavailable'
  /** No working key saved yet: the switch can't turn on from here. */
  | 'needs-key'
  | 'off'
  | 'on'
  | 'paused';

export function autoReplyState(input: {
  loading: boolean;
  failed: boolean;
  notFound: boolean;
  settings: ResponderSettingsView | null;
}): AutoReplyState {
  if (input.loading) return 'loading';
  if (input.notFound) return 'unavailable';
  if (input.failed || !input.settings) return 'error';
  const { settings } = input;
  if (settings.enabled && settings.status === 'paused') return 'paused';
  if (settings.enabled) return 'on';
  if (!settings.key || settings.key.status !== 'active') return 'needs-key';
  return 'off';
}

/** The value next to "Auto-reply" on the agent's home. */
export function autoReplySummary(state: AutoReplyState): string | null {
  if (state === 'on') return 'On';
  if (state === 'paused') return 'Paused';
  if (state === 'off' || state === 'needs-key') return 'Off';
  if (state === 'unavailable') return 'Not available';
  return null;
}

/** Owner decision G2: room mentions only for now (direct-message replies come later). */
export const AUTO_REPLY_NOTE = 'Replies when mentioned in a room.';

/**
 * What the Auto-reply screen offers for the key, once the settings are read: set auto-reply up
 * (no working key: none saved, or one the provider rejected), or change or remove the working key.
 */
export function autoReplyKeyAction(
  state: AutoReplyState,
  settings: ResponderSettingsView | null,
): 'setup' | 'manage' | null {
  if (!settings || state === 'loading' || state === 'error' || state === 'unavailable') return null;
  return settings.key?.status === 'active' ? 'manage' : 'setup';
}

/** Remove key's confirmation, in the agent settings' own words, naming where the key lives. */
export function removeKeyPrompt(settings: ResponderSettingsView): string {
  return `Remove the key? Auto-reply turns off. To be certain the key can't be used anywhere, also delete it at ${providerName(settings.key?.provider ?? settings.provider)}.`;
}

/**
 * What DELETE …/responder/key confirms, before the settings are read again: auto-reply is off
 * and no key is saved.
 */
export function withoutKey(settings: ResponderSettingsView): ResponderSettingsView {
  return { ...settings, enabled: false, status: 'off', pause_reason: 'key_removed', key: null };
}

/** What fixes a pause: Resume, the settings sheet (Pick a model), or a new key. */
export type PauseFix = {
  label: 'Resume' | 'Pick a model' | 'Change key' | 'Add a key';
  does: 'resume' | 'settings' | 'key' | 'setup';
};

/**
 * Why auto-reply is paused and its one fix, in the agent settings' own words (pauseCopy). Quota and
 * repeated-error pauses never end by themselves, so the reason is always said. A key the provider
 * rejected is no longer active, so its fix sets up a new one (which also turns auto-reply back on).
 */
export function autoReplyPause(
  settings: ResponderSettingsView,
  now = Date.now(),
): { text: string; fix: PauseFix | null } {
  const { text, action } = pauseCopy(
    settings.pause_reason,
    settings.provider,
    settings.paused_until,
    now,
  );
  const fix: PauseFix | null =
    action === 'resume'
      ? { label: 'Resume', does: 'resume' }
      : action === 'pick_model'
        ? { label: 'Pick a model', does: 'settings' }
        : action === 'change_key'
          ? settings.key?.status === 'active'
            ? { label: 'Change key', does: 'key' }
            : { label: 'Add a key', does: 'setup' }
          : null;
  return { text, fix };
}

/** The chosen model as the Auto-reply screen names it: its name, else its id, else null. */
export function autoReplyModelName(
  settings: Pick<ResponderSettingsView, 'provider' | 'model'>,
  models: readonly ModelOption[],
): string | null {
  const model = models.find(
    (item) => item.provider === settings.provider && item.id === settings.model,
  );
  return model?.name ?? settings.model ?? null;
}

/** "Anthropic · Claude Sonnet 5 · up to 100 replies a day · stops after about $2.00 a day". */
export function autoReplyLimitsLine(
  settings: ResponderSettingsView,
  models: readonly ModelOption[],
): string {
  return `${providerName(settings.provider)} · ${autoReplyModelName(settings, models) ?? 'no model'} · up to ${settings.daily_reply_cap.toLocaleString('en-US')} replies a day · stops after about $${settings.daily_spend_cap_usd.toFixed(2)} a day`;
}

/* ---------- Permissions ---------- */

export interface PermissionRow {
  /** One row per other agent: its id (or the connection id when the name is not disclosed). */
  key: string;
  name: string;
  /** 'You' for agents in this workspace, else the other owner's label (null when not disclosed). */
  owner: 'You' | string | null;
  /** Workspace connections with this agent, in either direction (DELETE /api/connections/:id). */
  local: string[];
  /** Approved connections with other owners (POST /api/v2/connections/requests/:id/revoke). */
  cross: string[];
}

/**
 * Who can work with the agent: every agent it has a connection with, in either direction, one row
 * per agent. Workspace connections come from the snapshot; approved connections with other owners
 * from /api/v2/connections/requests. Removed agents and connections of other agents are left out.
 */
export function permissionRows(
  agentId: string,
  agents: readonly Agent[],
  connections: readonly Connection[],
  cross: readonly ConnectionRequest[],
): PermissionRow[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const rows = new Map<string, PermissionRow>();
  for (const connection of connections) {
    const outgoing = connection.fromAgentId === agentId;
    if (!outgoing && connection.toAgentId !== agentId) continue;
    const peerId = outgoing ? connection.toAgentId : connection.fromAgentId;
    if (peerId === agentId) continue;
    const peer = byId.get(peerId);
    if (!peer || peer.revokedAt) continue;
    const row = rows.get(peerId) ?? {
      key: peerId,
      name: peer.name,
      owner: 'You',
      local: [],
      cross: [],
    };
    row.local.push(connection.id);
    rows.set(peerId, row);
  }
  for (const item of cross) {
    if (item.status !== 'approved') continue;
    const outgoing = item.direction === 'outgoing';
    if (outgoing ? item.from_agent_id !== agentId : item.to_agent_id !== agentId) continue;
    const peerId = outgoing ? item.to_agent_id : item.from_agent_id;
    const name = outgoing ? item.to_agent_name : item.from_agent_name;
    const key = `x:${peerId}`;
    const row = rows.get(key) ?? {
      key,
      name: name ?? 'An agent',
      owner: outgoing ? null : item.from_owner_label,
      local: [],
      cross: [],
    };
    if (!row.cross.includes(item.id)) row.cross.push(item.id);
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => Number(a.owner !== 'You') - Number(b.owner !== 'You') || a.name.localeCompare(b.name),
  );
}

/** The line under a permission row's name. */
export function ownerLine(owner: PermissionRow['owner']): string {
  if (owner === 'You') return 'Your agent';
  return owner ? `Owned by ${owner}` : 'Another owner’s agent';
}

/** The value next to "Permissions" on the agent's home. */
export function permissionsSummary(rows: readonly PermissionRow[]): string {
  if (!rows.length) return 'None';
  return rows.length === 1 ? '1 agent' : `${rows.length} agents`;
}

/**
 * The agents "Connect an agent" offers: your other live agents with no connection to this one
 * yet. Choosing one lets it ask this agent for work (fromAgentId: it, toAgentId: this agent).
 */
export function connectable(
  agentId: string,
  agents: readonly Agent[],
  rows: readonly PermissionRow[],
): Agent[] {
  const taken = new Set(rows.filter((row) => row.owner === 'You').map((row) => row.key));
  return agents
    .filter(
      (agent) =>
        agent.id !== agentId &&
        !agent.revokedAt &&
        agent.status !== 'revoked' &&
        !taken.has(agent.id),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
