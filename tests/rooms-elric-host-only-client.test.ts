import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpRoomsClient } from '../src/rooms/api.js';
import { ApiError } from '../src/api.js';
import { ELRIC_HOST_ONLY_CODE, ELRIC_HOST_ONLY_MESSAGE } from '../shared/elric-copy.js';

/**
 * The console client: "Add my AI" never offers the person's Elric, and the server's
 * elric_host_only refusal reaches people as one plain sentence. Synthetic data, fetch stubbed.
 */
function stubFetch(t: { after(fn: () => void): void }, routes: Record<string, [number, unknown]>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const [status, body] = routes[String(input)] ?? [404, { error: 'Not found.' }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('the agent list for "Add my AI" leaves out the Elric of the signed-in person', async (t) => {
  stubFetch(t, {
    '/api/snapshot': [
      200,
      {
        agents: [
          { id: 'elric-1', name: 'Elric' },
          { id: 'ai-1', name: 'Research helper' },
          { id: 'ai-2', name: 'Old helper', revokedAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ],
    '/api/elric': [200, { agent_id: 'elric-1', eligible: true }],
  });
  assert.deepEqual(await createHttpRoomsClient().listAgents(), [
    { id: 'ai-1', name: 'Research helper' },
  ]);
});

test('a refused Elric join shows "Only the room\'s host can add Elric to this room."', async (t) => {
  stubFetch(t, {
    '/api/rooms/room-1/join': [403, { error: 'something else', code: ELRIC_HOST_ONLY_CODE }],
  });
  await assert.rejects(
    createHttpRoomsClient().join({ room_id: 'room-1', agent_id: 'elric-1', idempotency_key: 'k' }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === ELRIC_HOST_ONLY_CODE &&
      error.message === ELRIC_HOST_ONLY_MESSAGE,
  );
});
