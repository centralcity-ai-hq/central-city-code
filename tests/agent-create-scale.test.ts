import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

/**
 * Creating an agent in a large workspace. Every workspace write still reads and rewrites the whole
 * document (linear in its agents), but nothing in the write path may be quadratic: before
 * migrations 110 and 111 the workspace triggers compared every agent with the whole agents array,
 * so one create in a workspace of 3,000 agents took seconds and 7,000 tens of seconds, all while
 * holding the workspace row lock that every other write of that workspace waits for. This compares
 * one create (and one rename) at 200 and at 4,000 agents, after the small round has warmed the
 * connection's cached trigger plans: twenty times the agents may cost at most about twenty times
 * as much (the bound leaves room for a noisy runner); the quadratic triggers cost over a hundred
 * times as much. tests/workspace-triggers-linear.test.ts measures each trigger on its own.
 * Synthetic data.
 */
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const SMALL = 200;
const LARGE = 4000;
const ROUNDS = 5;
/** Twenty times the agents: linear growth is at most 20x, the quadratic triggers were over 100x. */
const MAX_RATIO = 30;

test('creating or renaming an agent does not grow quadratically with the workspace', async (t) => {
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    limits: { agentsPerWorkspace: 100_000, apiRequestsPerMinute: 100_000 },
  });
  t.after(() => app.close());
  const db = app.city.db;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name: 'Fleet owner', password: 'Synthetic fleet owner password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const operatorId = res.json().operator.id as string;
  const create = () =>
    app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...headers, cookie },
      payload: JSON.stringify({
        name: 'Fleet agent',
        description: 'Synthetic fleet agent.',
        capability: 'research',
        mode: 'external',
      }),
    });
  const first = await create();
  assert.equal(first.statusCode, 201, first.body);
  const stored = async () =>
    (
      await db.query<{ data: { agents: Array<Record<string, unknown>> } }>(
        'SELECT data FROM workspaces WHERE operator_id=$1',
        [operatorId],
      )
    ).rows[0]!.data;
  const template = (await stored()).agents[0]!;

  /** Seeds `size` agents stored the way the create route stores them, each with presence. */
  async function seed(size: number) {
    const data = await stored();
    data.agents = Array.from({ length: size }, (_, index) => ({
      ...template,
      id: randomUUID(),
      name: `Fleet agent ${index}`,
    }));
    await db.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
      operatorId,
      JSON.stringify(data),
    ]);
    await db.query(
      `INSERT INTO agent_presence(agent_id,operator_id,last_seen_at,sequence,updated_at)
       SELECT a->>'id',$1,$2,1,$2 FROM jsonb_array_elements($3::jsonb) a
       ON CONFLICT (agent_id) DO NOTHING`,
      [operatorId, Date.now(), JSON.stringify(data.agents)],
    );
    return data.agents[Math.floor(size / 2)]!.id as string;
  }
  async function median(action: () => Promise<{ statusCode: number; body: string }>) {
    const timings: number[] = [];
    for (let round = 0; round <= ROUNDS; round++) {
      const started = performance.now();
      const reply = await action();
      const elapsed = performance.now() - started;
      assert.ok(reply.statusCode < 300, reply.body);
      if (round > 0) timings.push(elapsed); // the first round warms up
    }
    return timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)]!;
  }
  async function measure(size: number) {
    const target = await seed(size);
    let rename = 0;
    return {
      create: await median(create),
      rename: await median(() =>
        app.inject({
          method: 'PATCH',
          url: `/api/agents/${target}`,
          headers: { ...headers, cookie },
          payload: JSON.stringify({ name: `Renamed ${rename++}` }),
        }),
      ),
    };
  }

  const small = await measure(SMALL);
  const large = await measure(LARGE);
  // Every create was recorded once in the pending log, as before.
  const created = (
    await db.query<{ count: string | number }>(
      'SELECT count(*) AS count FROM count_log_pending WHERE operator_id=$1',
      [operatorId],
    )
  ).rows[0]!;
  assert.equal(Number(created.count), 1 + SMALL + LARGE + 2 * (ROUNDS + 1));
  for (const kind of ['create', 'rename'] as const) {
    const ratio = large[kind] / small[kind];
    t.diagnostic(
      `${kind}: ${small[kind].toFixed(1)} ms at ${SMALL}, ${large[kind].toFixed(1)} ms at ${LARGE} (x${ratio.toFixed(1)})`,
    );
    assert.ok(
      ratio < MAX_RATIO,
      `${kind} at ${LARGE} agents took ${ratio.toFixed(1)}x the time at ${SMALL} (${large[kind].toFixed(0)} ms)`,
    );
  }
});
