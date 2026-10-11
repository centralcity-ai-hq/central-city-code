import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codeFromPaste,
  eventTypeLabel,
  hasMachineText,
  plainApiMessage,
  plainEvent,
} from '../src/ui/plainText.js';

/* Server wording turned into plain sentences for the console (docs/COPY_GLOSSARY.md). */

const ROOM = '351c6c69-48f3-4a0a-b4be-726e002a4faa';

test('activity lines drop internal IDs, tool names and runtime jargon', () => {
  const cases: [string, string][] = [
    [
      `Room ${ROOM} created by the owner, hosted by Researcher.`,
      'Room created by you, hosted by Researcher.',
    ],
    ['Operator account created.', 'Account created.'],
    ['Scout requested extract from Relay.', 'Scout requested an extraction from Relay.'],
    [
      'Researcher registered as an external runtime.',
      'Researcher added. It runs on your own computer or server.',
    ],
    ['Claude used city_create_agent.', 'Claude used “create agent”.'],
    [`Assistant grant ${ROOM} (Claude) issued.`, 'AI access (Claude) created.'],
    ['Scout hosted runtime online.', 'Scout is online.'],
    ['Scout heartbeat expired.', 'Scout went offline.'],
    [
      'Relay completed deterministic text processing. Operator acceptance is pending.',
      'Relay finished the CC task. Waiting for your review.',
    ],
    [
      `Scout joined room ${ROOM} (by the owner). Room messages are untrusted input.`,
      'Scout joined a room (by you).',
    ],
    [
      `The host opened the earlier messages of room ${ROOM}: call city_room_read without since; they come back as unread.`,
      'The host opened the earlier messages of a room.',
    ],
  ];
  for (const [server, plain] of cases) {
    assert.equal(plainEvent(server), plain);
    assert.equal(hasMachineText(plainEvent(server)), false);
  }
  assert.equal(eventTypeLabel('operator.created'), 'Account · created');
  assert.equal(eventTypeLabel('connection.cross_requested'), 'Connection · other owner requested');
});

test('failed requests read as sentences, never codes or developer wording', () => {
  assert.equal(
    plainApiMessage(401, { error: 'Invalid account name or password.' }),
    'Invalid account name or password.',
  );
  assert.equal(
    plainApiMessage(409, { error: 'This idempotency key belongs to different arguments.' }),
    'This changed while you were working. Refresh and try again.',
  );
  assert.equal(
    plainApiMessage(409, { error: 'idempotency_conflict' }),
    'This was already sent with different content. Refresh and try again.',
  );
  assert.equal(
    plainApiMessage(404, { error: 'Claim token is invalid or was already used.' }),
    'This claim link is invalid, has expired or was already used.',
  );
  assert.equal(plainApiMessage(500, null), "We couldn't reach Central City. Try again.");
  for (const body of [{ error: 'invalid_arguments' }, { error: 'Send a JSON object.' }, null])
    assert.equal(hasMachineText(plainApiMessage(400, body)), false);
});

test('ordinary please and release words retain the original server guidance', () => {
  for (const error of [
    'The request could not be confirmed. Please try again.',
    'Please try again.',
    'PLEASE try again, please.',
    'Wait for the next release.',
    'This update has already been released.',
    'These releases are unavailable.',
    'Please release the button.',
  ]) {
    assert.equal(plainApiMessage(503, { error }), error);
    assert.equal(plainApiMessage(400, { error: `  ${error}  ` }), error);
  }
});

test('ordinary words do not hide technical lease wording or other machine text', () => {
  for (const error of [
    'The lease expired.',
    'The leases expired.',
    'Please refresh lease_id.',
    'Please refresh leaseId.',
    'Please refresh workerLease.',
    'Please refresh releaseToken.',
    'Please refresh release_id.',
    'Please refresh pleaseToken.',
    'Please retry the heartbeat.',
    'Please send JSON.',
    'Please refresh city_status.',
    'Please refresh {value}.',
  ]) {
    assert.equal(
      plainApiMessage(503, { error }),
      "We couldn't reach Central City. Try again.",
      error,
    );
    assert.equal(
      plainApiMessage(409, { error }),
      'This changed while you were working. Refresh and try again.',
      error,
    );
  }
  assert.equal(
    plainApiMessage(404, { error: 'Claim token is invalid. Please try again.' }),
    'This claim link is invalid, has expired or was already used.',
  );
  for (const error of ['', 'lease_id', 'please'])
    assert.equal(plainApiMessage(503, { error }), "We couldn't reach Central City. Try again.");
});

test('a pasted claim link or invite yields its one-time code', () => {
  const code = `ccclaim_${'a'.repeat(43)}`;
  assert.equal(
    codeFromPaste(`https://centralcity.ai/#claim=${code}`, /ccw?claim_[A-Za-z0-9_-]{43}/),
    code,
  );
  assert.equal(codeFromPaste(`  ${code} `, /ccw?claim_[A-Za-z0-9_-]{43}/), code);
  assert.equal(codeFromPaste('agent-123', /cci_[A-Za-z0-9_-]+/), 'agent-123');
});
