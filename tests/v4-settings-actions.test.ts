import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionRequest } from '../shared/assistant';
import type { Agent, Connection } from '../shared/types';
import { PROVIDERS, type ResponderSettingsView } from '../src/responder/contract';
import {
  AUTO_REPLY_NOTE,
  autoReplyKeyAction,
  autoReplyLimitsLine,
  autoReplyPause,
  autoReplyState,
  autoReplySummary,
  canRotate,
  confirmed,
  connectable,
  keyHint,
  maskKey,
  ownerLine,
  permissionRows,
  permissionsSummary,
  removeKeyPrompt,
  removeView,
  subAgentWarning,
  withoutKey,
} from '../src/agents/v4/settingsActionsModel';

/* My agents v4: the pure rules behind Rotate key, Auto-reply, Permissions and Remove. */

const WINRY = '11111111-1111-4111-8111-111111111111';
const COURIER = '22222222-2222-4222-8222-222222222222';
const CHECKER = '33333333-3333-4333-8333-333333333333';
const SCOUT = '44444444-4444-4444-8444-444444444444';
const NOVA = '55555555-5555-4555-8555-555555555555';

function agent(over: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    description: '',
    capability: 'research',
    mode: 'external',
    isDemo: false,
    status: 'online',
    lastSeenAt: null,
    createdAt: '2026-10-10T07:19:00.000Z',
    revokedAt: null,
    ...over,
  } as Agent;
}
const connection = (id: string, from: string, to: string): Connection => ({
  id,
  fromAgentId: from,
  toAgentId: to,
  createdAt: '2026-10-10T07:20:00.000Z',
});
function cross(over: Partial<ConnectionRequest> & { id: string }): ConnectionRequest {
  return {
    direction: 'incoming',
    status: 'approved',
    from_agent_id: NOVA,
    from_agent_name: 'Nova',
    from_owner_label: 'Mira',
    to_agent_id: WINRY,
    to_agent_name: 'Winry',
    note: '',
    requested_at: '2026-10-09T07:00:00.000Z',
    expires_at: '2026-10-16T07:00:00.000Z',
    decided_at: '2026-10-09T08:00:00.000Z',
    revoked_at: null,
    ...over,
  };
}
function settings(over: Partial<ResponderSettingsView> = {}): ResponderSettingsView {
  return {
    agent_id: WINRY,
    enabled: false,
    status: 'off',
    pause_reason: null,
    paused_until: null,
    provider: null,
    model: null,
    instructions: '',
    daily_reply_cap: 100,
    daily_spend_cap_usd: 2,
    key: null,
    replies_available: true,
    ...over,
  };
}
const activeKey = {
  provider: PROVIDERS[0]!,
  added_at: '2026-10-01T00:00:00.000Z',
  validated_at: '2026-10-01T00:00:00.000Z',
  status: 'active' as const,
};

test('rotate is offered only to agents that have a key (G3)', () => {
  assert.equal(canRotate(agent({ id: WINRY, name: 'Winry', mode: 'external' })), true);
  assert.equal(canRotate(agent({ id: WINRY, name: 'Winry', mode: 'hosted' })), false);
  assert.equal(
    canRotate(agent({ id: WINRY, name: 'Winry', revokedAt: '2026-10-10T08:00:00.000Z' })),
    false,
  );
  assert.equal(canRotate(agent({ id: WINRY, name: 'Winry', status: 'revoked' })), false);
  assert.equal(canRotate(undefined), false);
});

test('the key hint is the server’s, and nothing when there is none', () => {
  assert.equal(keyHint(agent({ id: WINRY, name: 'Winry', credentialHint: '…a91f' })), '…a91f');
  assert.equal(keyHint(agent({ id: WINRY, name: 'Winry', credentialHint: null })), null);
  assert.equal(keyHint(agent({ id: WINRY, name: 'Winry', credentialHint: '  ' })), null);
  assert.equal(keyHint(agent({ id: WINRY, name: 'Winry' })), null);
});

test('the new key is masked as the mockup draws it, keeping only its last three characters', () => {
  const token = 'Zx9-abcdefghijklmnopqrstuvwxyz0123456789uJf';
  const masked = maskKey(token);
  assert.equal(masked, `${'•'.repeat(24)}uJf`);
  assert.ok(!masked.includes('abc'));
});

test('the confirm button needs the exact agent name', () => {
  assert.equal(confirmed('Winry', 'Winry'), true);
  assert.equal(confirmed('  Winry ', 'Winry'), true);
  assert.equal(confirmed('winry', 'Winry'), false);
  assert.equal(confirmed('Win', 'Winry'), false);
  assert.equal(confirmed('', ''), false);
});

test('remove counts every live agent created under this one (G8)', () => {
  const agents = [
    agent({ id: WINRY, name: 'Winry' }),
    agent({ id: COURIER, name: 'Courier', parentAgentId: WINRY }),
    agent({ id: CHECKER, name: 'Checker', parentAgentId: COURIER }),
    agent({ id: SCOUT, name: 'Scout', parentAgentId: WINRY, revokedAt: '2026-10-09T00:00:00Z' }),
    agent({ id: NOVA, name: 'Nova' }),
  ];
  assert.deepEqual(removeView(agents, WINRY), { removable: true, subAgents: 2 });
  assert.deepEqual(removeView(agents, CHECKER), { removable: true, subAgents: 0 });
  assert.deepEqual(removeView(agents, SCOUT), { removable: false, subAgents: 0 });
  assert.deepEqual(removeView(agents, 'missing'), { removable: false, subAgents: 0 });
});

test('the sub-agent warning shows only when removal cascades', () => {
  assert.equal(subAgentWarning('Winry', 0), null);
  assert.equal(subAgentWarning('Winry', 1), 'The 1 agent created under Winry is removed too.');
  assert.equal(subAgentWarning('Winry', 3), 'The 3 agents created under Winry are removed too.');
});

test('auto-reply states follow the saved settings', () => {
  const base = { loading: false, failed: false, notFound: false };
  assert.equal(autoReplyState({ ...base, loading: true, settings: null }), 'loading');
  assert.equal(autoReplyState({ ...base, notFound: true, settings: null }), 'unavailable');
  assert.equal(autoReplyState({ ...base, failed: true, settings: null }), 'error');
  assert.equal(autoReplyState({ ...base, settings: settings() }), 'needs-key');
  assert.equal(
    autoReplyState({ ...base, settings: settings({ key: { ...activeKey, status: 'invalid' } }) }),
    'needs-key',
  );
  assert.equal(autoReplyState({ ...base, settings: settings({ key: activeKey }) }), 'off');
  assert.equal(
    autoReplyState({
      ...base,
      settings: settings({ key: activeKey, enabled: true, status: 'active' }),
    }),
    'on',
  );
  assert.equal(
    autoReplyState({
      ...base,
      settings: settings({ key: activeKey, enabled: true, status: 'paused' }),
    }),
    'paused',
  );
});

test('auto-reply copy and home value (G2: room mentions only for now)', () => {
  assert.equal(AUTO_REPLY_NOTE, 'Replies when mentioned in a room.');
  assert.equal(autoReplySummary('on'), 'On');
  assert.equal(autoReplySummary('off'), 'Off');
  assert.equal(autoReplySummary('needs-key'), 'Off');
  assert.equal(autoReplySummary('paused'), 'Paused');
  assert.equal(autoReplySummary('unavailable'), 'Not available');
  assert.equal(autoReplySummary('loading'), null);
  assert.equal(autoReplySummary('error'), null);
});

test('auto-reply key: set up without a working key, change or remove a working one', () => {
  const read = (over: Partial<ResponderSettingsView>) => {
    const value = settings(over);
    const base = { loading: false, failed: false, notFound: false };
    return autoReplyKeyAction(autoReplyState({ ...base, settings: value }), value);
  };
  assert.equal(read({}), 'setup', 'no key saved');
  assert.equal(read({ key: { ...activeKey, status: 'invalid' } }), 'setup', 'a rejected key');
  // Paused by the provider rejecting the key: set up again (the switch alone can't fix it).
  assert.equal(
    read({
      enabled: true,
      status: 'paused',
      pause_reason: 'invalid_key',
      key: { ...activeKey, status: 'invalid' },
    }),
    'setup',
  );
  assert.equal(read({ key: activeKey }), 'manage', 'off with a working key');
  assert.equal(read({ key: activeKey, enabled: true, status: 'active' }), 'manage');
  assert.equal(
    read({ key: activeKey, enabled: true, status: 'paused', pause_reason: 'quota' }),
    'manage',
  );
  // Nothing to offer before the settings are read, when they failed, or where it isn't offered.
  assert.equal(autoReplyKeyAction('loading', null), null);
  assert.equal(autoReplyKeyAction('error', null), null);
  assert.equal(autoReplyKeyAction('unavailable', null), null);
  assert.equal(autoReplyKeyAction('error', settings({ key: activeKey })), null);
});

test('a pause says why, with its one fix', () => {
  const now = Date.parse('2026-10-11T10:00:00Z');
  const paused = (over: Partial<ResponderSettingsView>) =>
    autoReplyPause(
      settings({ provider: 'openai', enabled: true, status: 'paused', key: activeKey, ...over }),
      now,
    );
  assert.deepEqual(paused({ pause_reason: 'quota' }), {
    text: 'Paused: your OpenAI quota is used up.',
    fix: { label: 'Resume', does: 'resume' },
  });
  assert.deepEqual(paused({ pause_reason: 'repeated_failures' }), {
    text: 'Paused after repeated errors from OpenAI.',
    fix: { label: 'Resume', does: 'resume' },
  });
  assert.deepEqual(paused({ pause_reason: 'model_unavailable' }), {
    text: "Paused: this key can't use the chosen model.",
    fix: { label: 'Pick a model', does: 'settings' },
  });
  // A key the provider rejected is no longer active: a new one is set up.
  assert.deepEqual(
    paused({ pause_reason: 'invalid_key', key: { ...activeKey, status: 'invalid' } }),
    { text: 'Paused: OpenAI rejected the key.', fix: { label: 'Add a key', does: 'setup' } },
  );
  assert.deepEqual(paused({ pause_reason: 'forbidden' }), {
    text: "Paused: OpenAI doesn't allow this key to reply.",
    fix: { label: 'Change key', does: 'key' },
  });
  // A rate limit ends by itself: no fix to offer.
  assert.deepEqual(paused({ pause_reason: 'rate_limited', paused_until: '2026-10-11T10:07:30Z' }), {
    text: 'Paused for 8 min: OpenAI rate limit. It resumes by itself.',
    fix: null,
  });
  assert.deepEqual(paused({ pause_reason: null }), {
    text: 'Paused.',
    fix: { label: 'Resume', does: 'resume' },
  });
});

test('Model and limits: provider, the model’s name and both daily caps', () => {
  const models = [
    {
      provider: 'anthropic' as const,
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      est_cost_per_reply_usd: 0.02,
      default: true,
    },
  ];
  assert.equal(
    autoReplyLimitsLine(
      settings({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        daily_reply_cap: 1000,
        daily_spend_cap_usd: 2.5,
      }),
      models,
    ),
    'Anthropic · Claude Sonnet 5 · up to 1,000 replies a day · stops after about $2.50 a day',
  );
  // A model no longer listed still shows by its id.
  assert.equal(
    autoReplyLimitsLine(settings({ provider: 'openai', model: 'gpt-old' }), models),
    'OpenAI · gpt-old · up to 100 replies a day · stops after about $2.00 a day',
  );
});

test('remove key: the confirmation names where the key lives; removal turns auto-reply off', () => {
  const on = settings({ provider: 'anthropic', enabled: true, status: 'active', key: activeKey });
  assert.equal(
    removeKeyPrompt(on),
    `Remove the key? Auto-reply turns off. To be certain the key can't be used anywhere, also delete it at OpenAI.`,
    'the saved key’s provider',
  );
  assert.match(removeKeyPrompt(settings({ provider: 'anthropic' })), /delete it at Anthropic\.$/);
  assert.match(removeKeyPrompt(settings()), /delete it at the provider\.$/);
  const gone = withoutKey(on);
  assert.deepEqual(
    [gone.enabled, gone.status, gone.pause_reason, gone.key],
    [false, 'off', 'key_removed', null],
  );
  assert.equal(gone.provider, 'anthropic', 'the rest of the settings stays');
  const base = { loading: false, failed: false, notFound: false };
  const state = autoReplyState({ ...base, settings: gone });
  assert.equal(state, 'needs-key', 'the switch is disabled again');
  assert.equal(autoReplyKeyAction(state, gone), 'setup');
});

test('permissions: one row per agent, both directions, own agents first', () => {
  const agents = [
    agent({ id: WINRY, name: 'Winry' }),
    agent({ id: COURIER, name: 'Courier' }),
    agent({ id: CHECKER, name: 'Checker' }),
    agent({ id: SCOUT, name: 'Scout', revokedAt: '2026-10-09T00:00:00Z' }),
  ];
  const connections = [
    connection('c1', COURIER, WINRY),
    connection('c2', WINRY, COURIER),
    connection('c3', CHECKER, WINRY),
    connection('c4', SCOUT, WINRY),
    connection('c5', COURIER, CHECKER),
  ];
  const rows = permissionRows(WINRY, agents, connections, [
    cross({ id: 'x1' }),
    cross({ id: 'x2', status: 'revoked' }),
    cross({ id: 'x3', to_agent_id: COURIER }),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.name, row.owner, row.local, row.cross]),
    [
      ['Checker', 'You', ['c3'], []],
      ['Courier', 'You', ['c1', 'c2'], []],
      ['Nova', 'Mira', [], ['x1']],
    ],
  );
});

test('permissions: outgoing connections to other owners name the agent, not its owner', () => {
  const rows = permissionRows(
    WINRY,
    [agent({ id: WINRY, name: 'Winry' })],
    [],
    [
      cross({
        id: 'x9',
        direction: 'outgoing',
        from_agent_id: WINRY,
        from_owner_label: 'You',
        to_agent_id: NOVA,
        to_agent_name: 'Nova',
      }),
    ],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, 'Nova');
  assert.equal(rows[0]!.owner, null);
  assert.equal(ownerLine(rows[0]!.owner), 'Another owner’s agent');
  assert.equal(ownerLine('You'), 'Your agent');
  assert.equal(ownerLine('Mira'), 'Owned by Mira');
});

test('permissions summary for the home row', () => {
  const row = { key: 'k', name: 'n', owner: 'You', local: ['c'], cross: [] };
  assert.equal(permissionsSummary([]), 'None');
  assert.equal(permissionsSummary([row]), '1 agent');
  assert.equal(permissionsSummary([row, { ...row, key: 'j' }]), '2 agents');
});

test('connect offers your other live agents that are not connected yet', () => {
  const agents = [
    agent({ id: WINRY, name: 'Winry' }),
    agent({ id: COURIER, name: 'Courier' }),
    agent({ id: CHECKER, name: 'Checker' }),
    agent({ id: SCOUT, name: 'Scout', revokedAt: '2026-10-09T00:00:00Z' }),
  ];
  const rows = permissionRows(WINRY, agents, [connection('c1', WINRY, COURIER)], []);
  assert.deepEqual(
    connectable(WINRY, agents, rows).map((item) => item.name),
    ['Checker'],
  );
});
