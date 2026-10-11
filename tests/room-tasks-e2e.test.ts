import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ROOM_TASK_TOOLS } from '../server/rooms/tasks-tools.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { fixture, mcpCall, rpcResult, type App } from './oauth-helpers.js';

registerRoomTasksMigration();

/**
 * Two-MCP-client end-to-end test (plan in docs/ROOM_TASKS.md "End-to-end test plan").
 * Two workspace-key MCP clients (two different owners) against one app built with
 * CITY_ROOM_TASKS=1: host creates a room, member B joins, A creates a task from a
 * message, A and B race to claim, winner renews + posts fake step-2 evidence, host
 * rejects -> the other claims -> result -> approve -> done, plus one injected
 * stale-token conflict. Green-but-skipped until the tools are wired: when
 * city_room_task_create is absent from tools/list the file skips with the reason.
 * Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
let addressCounter = 91;

type McpResult = {
  isError?: boolean;
  structuredContent?: any;
  content: { type: string; text: string }[];
};

/** An AI-owned workspace co-owned by a person, with a full-scope key (mirrors tests/mcp-join-clarity.test.ts). */
async function keyOwner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.60`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `E2E co-owner ${addressCounter}`,
      password: 'Synthetic co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.61`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'room task e2e', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string };
}

async function callMcp(app: App, credential: string, name: string, args: unknown = {}) {
  const res = await mcpCall(app, credential, 'tools/call', { name, arguments: args });
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return rpcResult(res.body).result as McpResult;
}

async function okMcp(app: App, credential: string, name: string, args: unknown = {}) {
  const result = await callMcp(app, credential, name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent as any;
}

function errorOf(result: McpResult) {
  assert.equal(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content[0]!.text).error as {
    code: string;
    message: string;
    retryable: boolean;
    details?: any;
    issues?: { path: string; message: string }[];
  };
}

/** Annotations per the docs/ROOM_TASKS.md contract table. */
const EXPECTED_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  city_room_task_create: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  city_room_task_claim: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_renew: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_release: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_result: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_review: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_request_review: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  city_room_task_peer_review: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_list: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  city_room_task_get: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  city_room_task_events: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  city_room_task_templates: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  city_room_task_comment_add: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  city_room_task_comment_list: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  city_room_task_comment_delete: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Fake step-2 evidence until proposals merge (contract validates the shape only). */
const EVIDENCE = { kind: 'proposal', ref: 'proposal-7', revision: 'rev-3' };

test('PR3 e2e: two MCP clients race, review and hit one stale conflict', async (t) => {
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const { app } = await fixture(t);

  // Gate: green-but-skipped before the tools are wired, live after.
  const hostProbe = await keyOwner(app, 'Task e2e host workspace');
  const toolsRes = await mcpCall(app, hostProbe.key, 'tools/list', {});
  assert.equal(toolsRes.statusCode, 200, toolsRes.body);
  const tools = rpcResult(toolsRes.body).result.tools as {
    name: string;
    annotations: Record<string, boolean>;
  }[];
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  if (!byName.city_room_task_create) {
    t.skip('room task tools not wired yet');
    return;
  }

  // Annotations match the contract table for all nine tools.
  assert.deepEqual([...ROOM_TASK_TOOLS].sort(), Object.keys(EXPECTED_ANNOTATIONS).sort());
  for (const name of ROOM_TASK_TOOLS) {
    assert.ok(byName[name], `${name} is listed`);
    for (const [hint, want] of Object.entries(EXPECTED_ANNOTATIONS[name]!))
      assert.equal(byName[name]!.annotations[hint], want, `${name} ${hint}`);
  }

  // Two owners' agents in one room: host A creates, member B joins.
  const memberProbe = await keyOwner(app, 'Task e2e member workspace');
  const hostKey = hostProbe.key;
  const memberKey = memberProbe.key;
  const hostAgent = (
    await okMcp(app, hostKey, 'city_create_agent', {
      name: 'Task e2e host',
      description: 'Synthetic task e2e member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const memberAgent = (
    await okMcp(app, memberKey, 'city_create_agent', {
      name: 'Task e2e member',
      description: 'Synthetic task e2e member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const created = await okMcp(app, hostKey, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Synthetic task e2e desk',
    topic: 'Task e2e topic',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const joined = await okMcp(app, memberKey, 'city_join_room', {
    link: created.link.link,
    agent_id: memberAgent,
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.joined, true);

  // A creates a task from a message.
  const posted = await okMcp(app, hostKey, 'city_room_post', {
    room_id: roomId,
    agent_id: hostAgent,
    text: 'Synthetic e2e brief: ship the widget',
    idempotency_key: randomUUID(),
  });
  const seq = posted.message.seq as number;
  assert.ok(Number.isInteger(seq) && seq >= 1);
  const made = await okMcp(app, hostKey, 'city_room_task_create', {
    room_id: roomId,
    agent_id: hostAgent,
    title: 'Ship the widget',
    body: 'Steps:\n\n1. Build\n2. Review',
    from_message_seq: seq,
    idempotency_key: randomUUID(),
  });
  assert.equal(made.replayed, false);
  assert.equal(made.task.number, 1);
  assert.equal(made.task.status, 'open');
  const taskId = made.task.id as string;

  // A and B race to claim: exactly one wins, the other gets task_claimed.
  const [first, second] = await Promise.all([
    callMcp(app, hostKey, 'city_room_task_claim', {
      room_id: roomId,
      task_id: taskId,
      agent_id: hostAgent,
      idempotency_key: randomUUID(),
    }),
    callMcp(app, memberKey, 'city_room_task_claim', {
      room_id: roomId,
      task_id: taskId,
      agent_id: memberAgent,
      idempotency_key: randomUUID(),
    }),
  ]);
  const winners = [first, second].filter((result) => !result.isError);
  const losers = [first, second].filter((result) => result.isError);
  assert.equal(winners.length, 1, JSON.stringify([first.content, second.content]));
  assert.equal(losers.length, 1);
  const winner = winners[0]!;
  const winnerToken = winner.structuredContent.claim_token as string;
  assert.match(winnerToken, /^ccclaim_/);
  const winnerIsHost = winner === first;
  const winnerKey = winnerIsHost ? hostKey : memberKey;
  const winnerAgent = winnerIsHost ? hostAgent : memberAgent;
  const loserKey = winnerIsHost ? memberKey : hostKey;
  const loserAgent = winnerIsHost ? memberAgent : hostAgent;
  const denied = errorOf(losers[0]!);
  assert.equal(denied.code, 'task_claimed');
  assert.equal(denied.details.claimed_by, winnerAgent);
  assert.ok(denied.details.expires_at);
  assert.ok(denied.details.grace_until);
  assert.equal(winner.structuredContent.task.status, 'claimed');

  // The winner renews: expiries only, never a token.
  const renewed = await okMcp(app, winnerKey, 'city_room_task_renew', {
    room_id: roomId,
    task_id: taskId,
    claim_token: winnerToken,
  });
  assert.ok(renewed.expires_at);
  assert.ok(renewed.grace_until);
  assert.ok(!('claim_token' in renewed), 'renew never returns a token');

  // The winner posts a result (fake evidence); the host rejects -> open.
  const inReview = await okMcp(app, winnerKey, 'city_room_task_result', {
    room_id: roomId,
    task_id: taskId,
    claim_token: winnerToken,
    evidence: EVIDENCE,
  });
  assert.equal(inReview.task.status, 'in_review');
  assert.deepEqual(inReview.task.result, EVIDENCE);
  const rejected = await okMcp(app, hostKey, 'city_room_task_review', {
    room_id: roomId,
    task_id: taskId,
    decision: 'reject',
  });
  assert.equal(rejected.decision, 'reject');
  assert.equal(rejected.applied, true);
  assert.equal(rejected.task.status, 'open');
  assert.equal(rejected.task.result, null);

  // The kept evidence copy is marked untrusted.
  const events = await okMcp(app, hostKey, 'city_room_task_events', {
    room_id: roomId,
    task_id: taskId,
  });
  const rejectedEvent = events.events.find(
    (item: { action: string }) => item.action === 'rejected',
  );
  assert.ok(
    rejectedEvent,
    JSON.stringify(events.events.map((item: { action: string }) => item.action)),
  );
  assert.deepEqual(rejectedEvent.details, { evidence: EVIDENCE, untrusted: true });

  // The other claims, posts a result, the host approves -> done.
  const retaken = await okMcp(app, loserKey, 'city_room_task_claim', {
    room_id: roomId,
    task_id: taskId,
    agent_id: loserAgent,
    idempotency_key: randomUUID(),
  });
  const loserToken = retaken.claim_token as string;
  assert.match(loserToken, /^ccclaim_/);
  assert.notEqual(loserToken, winnerToken);
  const reviewed = await okMcp(app, loserKey, 'city_room_task_result', {
    room_id: roomId,
    task_id: taskId,
    claim_token: loserToken,
    evidence: EVIDENCE,
  });
  assert.equal(reviewed.task.status, 'in_review');
  const approved = await okMcp(app, hostKey, 'city_room_task_review', {
    room_id: roomId,
    task_id: taskId,
    decision: 'approve',
  });
  assert.equal(approved.decision, 'approve');
  assert.equal(approved.task.status, 'done');
  assert.deepEqual(approved.task.result, EVIDENCE);

  // Done isn't claimable.
  const shut = errorOf(
    await callMcp(app, winnerKey, 'city_room_task_claim', {
      room_id: roomId,
      task_id: taskId,
      agent_id: winnerAgent,
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(shut.code, 'task_not_claimable');
  assert.deepEqual(shut.details, { status: 'done' });

  // Claim tokens never appear in events or list/get output.
  const listedTasks = await okMcp(app, hostKey, 'city_room_task_list', { room_id: roomId });
  const fetched = await okMcp(app, hostKey, 'city_room_task_get', {
    room_id: roomId,
    task_id: taskId,
  });
  const finalEvents = await okMcp(app, hostKey, 'city_room_task_events', {
    room_id: roomId,
    task_id: taskId,
  });
  for (const token of [winnerToken, loserToken]) {
    for (const [label, seen] of Object.entries({
      events: finalEvents,
      list: listedTasks,
      get: fetched,
    }))
      assert.ok(!JSON.stringify(seen).includes(token), `claim token leaks into ${label}`);
  }
  assert.ok(!JSON.stringify({ listedTasks, fetched, finalEvents }).includes('ccclaim_'));

  // A non-member gets room_not_found; an unknown extra argument gets invalid_arguments.
  const outsider = await keyOwner(app, 'Task e2e outsider workspace');
  const hidden = errorOf(
    await callMcp(app, outsider.key, 'city_room_task_get', { room_id: roomId, task_id: taskId }),
  );
  assert.equal(hidden.code, 'room_not_found');
  const surprising = errorOf(
    await callMcp(app, hostKey, 'city_room_task_get', {
      room_id: roomId,
      task_id: taskId,
      surprise_field: 'nope',
    }),
  );
  assert.equal(surprising.code, 'invalid_arguments');
  assert.ok(surprising.issues?.some((issue) => issue.path === 'surprise_field'));

  // One injected conflict: A's stale token after takeover gets claim_stale + stale_rejected.
  const conflicted = await okMcp(app, hostKey, 'city_room_task_create', {
    room_id: roomId,
    agent_id: hostAgent,
    title: 'Takeover target',
    idempotency_key: randomUUID(),
  });
  const conflictId = conflicted.task.id as string;
  const heldA = await okMcp(app, hostKey, 'city_room_task_claim', {
    room_id: roomId,
    task_id: conflictId,
    agent_id: hostAgent,
    idempotency_key: randomUUID(),
  });
  const staleToken = heldA.claim_token as string;
  const forced = await okMcp(app, hostKey, 'city_room_task_release', {
    room_id: roomId,
    task_id: conflictId,
  });
  assert.equal(forced.released, true);
  const heldB = await okMcp(app, memberKey, 'city_room_task_claim', {
    room_id: roomId,
    task_id: conflictId,
    agent_id: memberAgent,
    idempotency_key: randomUUID(),
  });
  assert.equal(heldB.task.claim.agent_id, memberAgent);
  const stale = errorOf(
    await callMcp(app, hostKey, 'city_room_task_renew', {
      room_id: roomId,
      task_id: conflictId,
      claim_token: staleToken,
    }),
  );
  assert.equal(stale.code, 'claim_stale');
  assert.equal(stale.details.current_holder, memberAgent);
  const conflictEvents = await okMcp(app, hostKey, 'city_room_task_events', {
    room_id: roomId,
    task_id: conflictId,
  });
  assert.ok(
    conflictEvents.events.some((item: { action: string }) => item.action === 'stale_rejected'),
    JSON.stringify(conflictEvents.events.map((item: { action: string }) => item.action)),
  );
  // No member ever sees an operator id in the event log (neither owner's).
  const memberView = await callMcp(app, memberKey, 'city_room_task_events', {
    room_id: roomId,
    task_id: conflictId,
  });
  assert.ok(!memberView.isError);
  const seen = JSON.stringify(memberView);
  assert.ok(seen.includes('stale_rejected'));
  assert.ok(!seen.includes(hostProbe.id) && !seen.includes(memberProbe.id), 'no operator id');
  assert.ok(!seen.includes('attempted_by_owner') && !seen.includes('"attempted_by"'));
});
