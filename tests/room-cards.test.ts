import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { CARD_LIMITS, roomCardsMigration } from '../server/rooms/cards.js';
import {
  ROOM_CARD_TOOLS,
  ROOM_CARD_TOOL_SCOPES,
  roomCardOutputSchemas,
} from '../server/rooms/cards-tools.js';
import { remoteInputSchemas, remoteOutputSchemas } from '../server/remote-mcp/tools.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { GUEST_ROOM_TOOLS } from '../server/links/invites.js';
import { eraseAccount } from '../server/account/erase.js';

process.env.CITY_ROOM_TASKS = '1';
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-cards-test-root-not-a-real-secret';

/**
 * Typed room cards (docs/ROOMS.md "Decisions and approvals"): decisions #d-N, approvals #a-N and
 * task results #t-N, over MCP (workspace keys), the invite-link guest API and the owner console.
 * The safety rule under test: only the addressed owner answers an approval, as a person in the
 * console; no AI can, its own owner's included. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  return app;
}
function call(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await call(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
async function fails(app: App, key: string, name: string, args: unknown, code: string) {
  const res = await call(app, key, name, args);
  assert.notEqual(res.statusCode, 200, `${name} should fail: ${res.body}`);
  assert.equal(res.json().code, code, res.body);
  return res;
}
let addressCounter = 1;
type Owner = { id: string; key: string; cookie: string };
async function owner(app: App, name: string): Promise<Owner> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.70`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Cards owner ${addressCounter}`,
      password: 'Synthetic cards owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.71`,
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
    payload: JSON.stringify({ label: 'cards test', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic room member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
/** Console REST as the owner's person, acting in its workspace. */
function rest(app: App, o: Owner, method: 'GET' | 'POST', url: string, body?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...jsonHeaders, cookie: o.cookie, 'x-city-workspace': o.id },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
async function room(app: App) {
  const a = await owner(app, 'Cards host');
  const hostAgent = await agent(app, a.key, 'Host AI');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Decision desk',
    topic: 'Settle the launch plan',
    history: 'full',
    idempotency_key: randomUUID(),
  });
  return { a, hostAgent, roomId: created.room.id as string, link: created.link.link as string };
}
async function member(app: App, link: string, name = 'Member') {
  const b = await owner(app, name);
  const agentId = await agent(app, b.key, `${name} AI`);
  await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: agentId,
    idempotency_key: randomUUID(),
  });
  return { ...b, agentId };
}
/** An invite-link AI with no account behind it (an unclaimed owner). */
async function guest(app: App, a: Owner, roomId: string) {
  const link = await rest(app, a, 'POST', '/api/links', { target: 'room', room_id: roomId });
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const address = `203.0.113.${addressCounter++}`;
  const publicPost = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: address,
    });
  const start = await publicPost('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const joined = await publicPost('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name: 'Invited AI',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const credential = joined.json().credential as string;
  const invoke = (tool: string, args: unknown = {}) =>
    publicPost(`/api/public/invites/tools/${tool}`, args, {
      authorization: `Bearer ${credential}`,
    });
  return { invoke, agentId: joined.json().agent_id as string, credential };
}
const lines = async (app: App, roomId: string) =>
  (
    await app.city.db.query<{ parts: Array<{ text: string }> }>(
      "SELECT parts FROM room_messages WHERE room_id=$1 AND sender_kind='system' ORDER BY seq",
      [roomId],
    )
  ).rows.map((row) => row.parts[0]!.text);

test('the card tools are registered with their scope, schemas and guest access', () => {
  for (const name of ROOM_CARD_TOOLS) {
    assert.ok(remoteInputSchemas[name as keyof typeof remoteInputSchemas], name);
    assert.ok(remoteOutputSchemas[name as keyof typeof remoteOutputSchemas], name);
    assert.equal(ASSISTANT_TOOL_SCOPES[name], ROOM_CARD_TOOL_SCOPES[name]);
    assert.ok((GUEST_ROOM_TOOLS as readonly string[]).includes(name), `${name} for guests`);
  }
  // No tool answers an approval, for anyone.
  for (const name of Object.keys(ASSISTANT_TOOL_SCOPES))
    assert.doesNotMatch(name, /answer|approve/, name);
  assert.equal(roomCardsMigration.version, 330);
  assert.doesNotMatch(
    roomCardsMigration.sql,
    /\b(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/i,
    'additive only',
  );
});

test('members record decisions; only the recorder or the host supersedes', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const c = await member(app, link, 'Charlie');
  const key = randomUUID();
  const first = await ok(app, b.key, 'city_room_decision_record', {
    room_id: roomId,
    title: 'Ship the checklist on Friday',
    body: 'Agreed in the thread.',
    idempotency_key: key,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.card.ref, '#d-1');
  assert.equal(first.card.status, 'current');
  assert.equal(first.card.recorded_by, 'Bravo AI');
  assert.equal(first.card.own, true);
  assert.ok(roomCardOutputSchemas.city_room_decision_record.safeParse(first).success);
  // A retry with the same key is the same card; a different request with it is a conflict.
  const again = await ok(app, b.key, 'city_room_decision_record', {
    room_id: roomId,
    title: 'Ship the checklist on Friday',
    body: 'Agreed in the thread.',
    idempotency_key: key,
  });
  assert.equal(again.replayed, true);
  assert.equal(again.card.id, first.card.id);
  await fails(
    app,
    b.key,
    'city_room_decision_record',
    { room_id: roomId, title: 'Something else', idempotency_key: key },
    'idempotency_conflict',
  );
  // Charlie (another owner, not the host) cannot supersede Bravo's decision.
  await fails(
    app,
    c.key,
    'city_room_decision_record',
    { room_id: roomId, title: 'Ship Monday', supersedes: '#d-1', idempotency_key: randomUUID() },
    'not_recorder',
  );
  // The host can; the old decision then reads superseded by the new one.
  const second = await ok(app, a.key, 'city_room_decision_record', {
    room_id: roomId,
    title: 'Ship Monday instead',
    supersedes: 'd-1',
    idempotency_key: randomUUID(),
  });
  assert.equal(second.card.ref, '#d-2');
  assert.equal(second.card.supersedes, '#d-1');
  const old = await ok(app, c.key, 'city_room_card', { room_id: roomId, card: '#d-1' });
  assert.equal(old.card.status, 'superseded');
  assert.equal(old.card.superseded_by, '#d-2');
  assert.equal(old.card.own, false);
  await fails(
    app,
    a.key,
    'city_room_decision_record',
    { room_id: roomId, title: 'Again', supersedes: '#d-1', idempotency_key: randomUUID() },
    'already_superseded',
  );
  // Open lists show only the current decision; all shows both.
  const open = await ok(app, c.key, 'city_room_cards', { room_id: roomId, kind: 'decision' });
  assert.deepEqual(
    open.cards.map((card: { ref: string }) => card.ref),
    ['#d-2'],
  );
  const all = await ok(app, c.key, 'city_room_cards', { room_id: roomId, status: 'all' });
  assert.deepEqual(
    all.cards.map((card: { ref: string }) => card.ref),
    ['#d-2', '#d-1'],
  );
  assert.equal(all.counts.decision_current, 1);
  assert.equal(all.counts.decision_superseded, 1);
  // The feed has reference-only lines: never the card text.
  const feed = await lines(app, roomId);
  assert.ok(feed.includes('Bravo AI recorded decision #d-1.'), feed.join('\n'));
  assert.ok(feed.some((text) => /recorded decision #d-2; it supersedes #d-1\.$/.test(text)));
  assert.ok(!feed.some((text) => text.includes('Friday')));
  // Credentials never get into a card; strangers see nothing.
  await fails(
    app,
    b.key,
    'city_room_decision_record',
    {
      room_id: roomId,
      title: 'Key is crk_ABCDEFGHIJKLMNOPQRSTUV',
      idempotency_key: randomUUID(),
    },
    'credential_in_message',
  );
  const stranger = await owner(app, 'Stranger');
  await agent(app, stranger.key, 'Stranger AI');
  await fails(app, stranger.key, 'city_room_cards', { room_id: roomId }, 'room_not_found');
  // A closed room's cards are read-only.
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  await fails(
    app,
    b.key,
    'city_room_decision_record',
    { room_id: roomId, title: 'Late', idempotency_key: randomUUID() },
    'room_closed',
  );
});

test('a closed room offers no answer to a pending approval', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  await ok(app, b.key, 'city_room_approval_request', {
    room_id: roomId,
    title: 'Send the partner mail?',
    body: 'Recipient: partner desk.',
    expires_in_hours: 24,
    idempotency_key: randomUUID(),
  });
  const before = await rest(app, b, 'GET', `/api/rooms/${roomId}/cards/a-1`);
  assert.equal(before.json().card.approval.can_answer, true, before.body);
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  const after = await rest(app, b, 'GET', `/api/rooms/${roomId}/cards/a-1`);
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(after.json().card.approval.can_answer, false);
});

test('only the addressed owner answers an approval, as a person in the console', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  // Bravo's AI asks its own owner (a claimed workspace: a person can answer).
  const asked = await ok(app, b.key, 'city_room_approval_request', {
    room_id: roomId,
    title: 'Send the partner mail with the two PDFs?',
    body: 'Recipient: partner desk. Attachments: memo v2, tokenomics v1.',
    expires_in_hours: 24,
    idempotency_key: randomUUID(),
  });
  assert.equal(asked.card.ref, '#a-1');
  assert.equal(asked.card.status, 'pending');
  assert.equal(asked.card.approval.to, 'owner');
  assert.equal(asked.card.approval.can_answer, false, 'never answerable over MCP');
  assert.ok(roomCardOutputSchemas.city_room_approval_request.safeParse(asked).success);
  // The host (another owner) cannot answer it, even in the console.
  const hostTry = await rest(app, a, 'POST', `/api/rooms/${roomId}/cards/a-1/answer`, {
    answer: 'approve',
  });
  assert.equal(hostTry.statusCode, 403, hostTry.body);
  assert.equal(hostTry.json().code, 'not_addressed');
  // Bravo's person sees it answerable in the console and suggests changes: no decision yet.
  const view = await rest(app, b, 'GET', `/api/rooms/${roomId}/cards/a-1`);
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().card.approval.can_answer, true);
  const changes = await rest(app, b, 'POST', `/api/rooms/${roomId}/cards/a-1/answer`, {
    answer: 'changes',
    note: 'Attach the signed memo, not the draft.',
  });
  assert.equal(changes.statusCode, 200, changes.body);
  assert.equal(changes.json().card.status, 'changes_requested');
  assert.equal(changes.json().card.approval.answer_note, 'Attach the signed memo, not the draft.');
  assert.equal(changes.json().decision, null);
  // A second approval, approved: the answer records a decision linked to it.
  await ok(app, b.key, 'city_room_approval_request', {
    room_id: roomId,
    title: 'Send it with the signed memo?',
    idempotency_key: randomUUID(),
  });
  const approved = await rest(app, b, 'POST', `/api/rooms/${roomId}/cards/a-2/answer`, {
    answer: 'approve',
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().card.status, 'approved');
  assert.equal(approved.json().card.approval.decision, '#d-1');
  const decision = approved.json().decision;
  assert.equal(decision.ref, '#d-1');
  assert.equal(decision.title, 'Approved: Send it with the signed memo?');
  assert.equal(decision.from_approval, '#a-2');
  assert.equal(decision.recorded_by_kind, 'person');
  // A double click returns the same outcome; a different answer is refused.
  const twice = await rest(app, b, 'POST', `/api/rooms/${roomId}/cards/a-2/answer`, {
    answer: 'approve',
  });
  assert.equal(twice.statusCode, 200, twice.body);
  assert.equal(twice.json().decision.ref, '#d-1');
  const flip = await rest(app, b, 'POST', `/api/rooms/${roomId}/cards/a-2/answer`, {
    answer: 'not_now',
  });
  assert.equal(flip.statusCode, 409, flip.body);
  // The AI reads the outcome as a card; it cannot answer, and no tool exists to try.
  const read = await ok(app, b.key, 'city_room_card', { room_id: roomId, card: '#a-2' });
  assert.equal(read.card.status, 'approved');
  assert.equal((await call(app, b.key, 'city_room_approval_answer', {})).statusCode, 404);
  // Feed lines name references only.
  const feed = await lines(app, roomId);
  assert.ok(feed.includes('Bravo AI asked its owner for approval #a-1.'), feed.join('\n'));
  assert.ok(
    feed.some((text) => /answered approval #a-2: approved \(decision #d-1\)\.$/.test(text)),
  );
  assert.ok(!feed.some((text) => text.includes('PDF')));
});

test('an invite-link AI records decisions and asks the host; its owner cannot answer', async (t) => {
  const app = await fixture(t);
  const { a, roomId } = await room(app);
  const g = await guest(app, a, roomId);
  const decided = await g.invoke('city_room_decision_record', {
    title: 'Use the short summary format',
    idempotency_key: randomUUID(),
  });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().card.ref, '#d-1');
  assert.equal(decided.json().card.recorded_by, 'Invited AI');
  // Its owner is anonymous: nobody could answer, so the request is refused with the way out.
  const toOwner = await g.invoke('city_room_approval_request', {
    title: 'May I publish the summary?',
    idempotency_key: randomUUID(),
  });
  assert.equal(toOwner.statusCode, 409, toOwner.body);
  assert.equal(toOwner.json().code, 'owner_unavailable');
  const toHost = await g.invoke('city_room_approval_request', {
    title: 'May I publish the summary?',
    to: 'host',
    idempotency_key: randomUUID(),
  });
  assert.equal(toHost.statusCode, 200, toHost.body);
  assert.equal(toHost.json().card.approval.to, 'host');
  // The guest credential cannot answer (no such guest tool), nor smuggle its credential in.
  const answerTry = await g.invoke('city_room_approval_answer', {
    card: '#a-1',
    answer: 'approve',
  });
  assert.equal(answerTry.statusCode, 404, answerTry.body);
  const smuggle = await g.invoke('city_room_decision_record', {
    title: `remember ${g.credential.slice(4)}`,
    idempotency_key: randomUUID(),
  });
  assert.equal(smuggle.statusCode, 400, smuggle.body);
  assert.equal(smuggle.json().code, 'credential_in_message');
  // The host answers in the console: Not now records a decision too.
  const answered = await rest(app, a, 'POST', `/api/rooms/${roomId}/cards/a-1/answer`, {
    answer: 'not_now',
    note: 'After the review.',
  });
  assert.equal(answered.statusCode, 200, answered.body);
  assert.equal(answered.json().card.status, 'not_now');
  assert.equal(answered.json().decision.title, 'Not now: May I publish the summary?');
  assert.equal(answered.json().decision.body, 'After the review.');
  const listed = await g.invoke('city_room_cards', { status: 'all' });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(
    listed
      .json()
      .cards.map((card: { ref: string }) => card.ref)
      .sort(),
    ['#a-1', '#d-1', '#d-2'],
  );
  // The guest withdraws only pending ones.
  const withdraw = await g.invoke('city_room_approval_withdraw', { card: '#a-1' });
  assert.equal(withdraw.statusCode, 409, withdraw.body);
});

test('approvals expire, can be withdrawn, and task results read as #t- cards', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  await ok(app, b.key, 'city_room_approval_request', {
    room_id: roomId,
    title: 'Rotate the deploy key?',
    to: 'host',
    idempotency_key: randomUUID(),
  });
  await ok(app, b.key, 'city_room_approval_request', {
    room_id: roomId,
    title: 'Close the old room?',
    to: 'host',
    idempotency_key: randomUUID(),
  });
  // #a-1 lapses; #a-2 is withdrawn by the asking owner (the host cannot withdraw it).
  await app.city.db.query('UPDATE room_cards SET expires_at=1 WHERE room_id=$1 AND number=1', [
    roomId,
  ]);
  const expired = await ok(app, a.key, 'city_room_card', { room_id: roomId, card: '#a-1' });
  assert.equal(expired.card.status, 'expired');
  const late = await rest(app, a, 'POST', `/api/rooms/${roomId}/cards/a-1/answer`, {
    answer: 'approve',
  });
  assert.equal(late.statusCode, 409, late.body);
  await fails(
    app,
    a.key,
    'city_room_approval_withdraw',
    { room_id: roomId, card: '#a-2' },
    'not_requester',
  );
  const withdrawn = await ok(app, b.key, 'city_room_approval_withdraw', {
    room_id: roomId,
    card: '#a-2',
  });
  assert.equal(withdrawn.card.status, 'withdrawn');
  const open = await ok(app, a.key, 'city_room_cards', { room_id: roomId, kind: 'approval' });
  assert.equal(open.cards.length, 0);
  assert.equal(open.counts.approval_expired, 1);
  assert.equal(open.counts.approval_withdrawn, 1);
  // A handed-in task result is card #t-<number>.
  const task = (
    await ok(app, b.key, 'city_room_task_create', {
      room_id: roomId,
      title: 'Summarise the thread',
      idempotency_key: randomUUID(),
    })
  ).task;
  const claim = await ok(app, b.key, 'city_room_task_claim', {
    room_id: roomId,
    task_id: task.id,
    idempotency_key: randomUUID(),
  });
  await ok(app, b.key, 'city_room_task_result', {
    room_id: roomId,
    task_id: task.id,
    claim_token: claim.claim_token,
    evidence: { kind: 'proposal', ref: 'proposal-1', revision: 'rev-1' },
  });
  const results = await ok(app, a.key, 'city_room_cards', { room_id: roomId, kind: 'result' });
  assert.equal(results.cards.length, 1);
  assert.equal(results.cards[0].ref, `#t-${task.number}`);
  assert.equal(results.cards[0].status, 'in_review');
  assert.equal(results.cards[0].result.submitted_by, 'Bravo AI');
  const one = await ok(app, a.key, 'city_room_card', { room_id: roomId, card: `t-${task.number}` });
  assert.equal(one.card.task.ref, `T${task.number}`);
  assert.ok(roomCardOutputSchemas.city_room_cards.safeParse(results).success);
});

test('many approvals never push the decisions out of the list', async (t) => {
  const app = await fixture(t);
  const { a, roomId, hostAgent } = await room(app);
  const seed = (kind: string, status: string, number: number) =>
    app.city.db.query(
      `INSERT INTO room_cards(id,room_id,kind,number,title,status,created_by_agent_id,created_by_owner_id,
          created_by_kind,created_at,updated_at,addressed_to,addressed_owner_id,expires_at)
        VALUES($1,$2,$3,$4,'Seeded',$5,$6,$7,'agent',0,0,$8,$9,$10)`,
      kind === 'approval'
        ? [randomUUID(), roomId, kind, number, status, hostAgent, a.id, 'owner', a.id, 1]
        : [randomUUID(), roomId, kind, number, status, hostAgent, a.id, null, null, null],
    );
  for (let i = 1; i <= CARD_LIMITS.listLimit + 5; i++) await seed('approval', 'approved', i);
  for (let i = 1; i <= 3; i++) await seed('decision', 'current', i);
  const { cards } = await ok(app, a.key, 'city_room_cards', { room_id: roomId, status: 'all' });
  const of = (kind: string) => cards.filter((card: { kind: string }) => card.kind === kind);
  assert.equal(of('decision').length, 3);
  assert.equal(of('approval').length, CARD_LIMITS.listLimit);
  assert.equal(of('approval')[0].number, CARD_LIMITS.listLimit + 5, 'the newest first');
});

test('a room holds at most the card cap, and deleting the room erases its cards', async (t) => {
  const app = await fixture(t);
  const { a, roomId, hostAgent } = await room(app);
  for (let i = 1; i <= CARD_LIMITS.perRoom; i++)
    await app.city.db.query(
      `INSERT INTO room_cards(id,room_id,kind,number,title,status,created_by_agent_id,created_by_owner_id,
          created_by_kind,created_at,updated_at)
        VALUES($1,$2,'decision',$3,'Seeded','current',$4,$5,'agent',0,0)`,
      [randomUUID(), roomId, i, hostAgent, a.id],
    );
  await fails(
    app,
    a.key,
    'city_room_decision_record',
    { room_id: roomId, title: 'One more', idempotency_key: randomUUID() },
    'card_limit',
  );
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${roomId}`,
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ confirm_name: 'Decision desk' }),
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const left = await app.city.db.query('SELECT 1 FROM room_cards WHERE room_id=$1', [roomId]);
  assert.equal(left.rows.length, 0);
});

test('a person records a decision in the console; references never cross rooms', async (t) => {
  const app = await fixture(t);
  // A person account (not an AI workspace): its rooms have the person in them from creation.
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Console person', password: 'Synthetic console password' }),
    remoteAddress: '198.51.200.10',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const asPerson = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...jsonHeaders, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const hostAgent = await asPerson('POST', '/api/agents', {
    name: 'Host',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(hostAgent.statusCode, 201, hostAgent.body);
  const makeRoom = async (name: string) => {
    const made = await asPerson('POST', '/api/rooms', {
      name,
      agent_id: hostAgent.json().agent.id,
      idempotency_key: randomUUID(),
    });
    assert.equal(made.statusCode, 201, made.body);
    return made.json().room.id as string;
  };
  const roomId = await makeRoom('Console room');
  const recorded = await asPerson('POST', `/api/rooms/${roomId}/decisions`, {
    title: 'Weekly sync moves to Tuesday',
    idempotency_key: randomUUID(),
  });
  assert.equal(recorded.statusCode, 201, recorded.body);
  assert.equal(recorded.json().card.ref, '#d-1');
  assert.equal(recorded.json().card.recorded_by_kind, 'person');
  const listed = await asPerson('GET', `/api/rooms/${roomId}/cards?kind=decision`);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().cards[0].ref, '#d-1');
  // Another room of the same host: an id from the first room is not found in the second.
  const otherId = await makeRoom('Second room');
  const cross = await asPerson('POST', `/api/rooms/${otherId}/decisions`, {
    title: 'Replace it',
    supersedes: recorded.json().card.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(cross.statusCode, 404, cross.body);
  assert.equal(cross.json().code, 'card_not_found');
  const missing = await asPerson('GET', `/api/rooms/${otherId}/cards/d-1`);
  assert.equal(missing.statusCode, 404, missing.body);
});

test('no AI overturns a human decision; only a person in the console supersedes it', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  await ok(app, b.key, 'city_room_approval_request', {
    room_id: roomId,
    title: 'Publish the launch note?',
    idempotency_key: randomUUID(),
  });
  const answered = await rest(app, b, 'POST', `/api/rooms/${roomId}/cards/a-1/answer`, {
    answer: 'not_now',
  });
  assert.equal(answered.statusCode, 200, answered.body);
  assert.equal(answered.json().decision.ref, '#d-1');
  // The answering owner's own AI, and the host's AI, are both refused.
  for (const key of [b.key, a.key])
    await fails(
      app,
      key,
      'city_room_decision_record',
      {
        room_id: roomId,
        title: 'Approved after all',
        supersedes: '#d-1',
        idempotency_key: randomUUID(),
      },
      'human_decision',
    );
  const still = await ok(app, b.key, 'city_room_card', { room_id: roomId, card: '#d-1' });
  assert.equal(still.card.status, 'current');
  // The owner, as a person in the console, may change its own decision.
  const changed = await rest(app, b, 'POST', `/api/rooms/${roomId}/decisions`, {
    title: 'Approved after the review',
    supersedes: '#d-1',
    idempotency_key: randomUUID(),
  });
  assert.equal(changed.statusCode, 201, changed.body);
  assert.equal(changed.json().card.supersedes, '#d-1');
});

test('invisible characters never hide a credential, and removed members write nothing', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  // A zero-width space or a bidi mark inside a credential prefix is removed before the scan.
  for (const title of [
    'Key crk_\u200bABCDEFGHIJKLMNOPQRSTUV',
    'Key c\u2066rk_ABCDEFGHIJKLMNOPQRSTUV',
  ])
    await fails(
      app,
      b.key,
      'city_room_approval_request',
      { room_id: roomId, title, idempotency_key: randomUUID() },
      'credential_in_message',
    );
  // A title of only invisible characters is no title.
  await fails(
    app,
    b.key,
    'city_room_decision_record',
    { room_id: roomId, title: '\u200b\u200c', idempotency_key: randomUUID() },
    'title_required',
  );
  // Stored text has them removed.
  const clean = await ok(app, b.key, 'city_room_decision_record', {
    room_id: roomId,
    title: 'Ship\u200b on Friday',
    idempotency_key: randomUUID(),
  });
  assert.equal(clean.card.title, 'Ship on Friday');
  // A removed member's AI can no longer read or write cards.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: b.agentId });
  await fails(
    app,
    b.key,
    'city_room_decision_record',
    { room_id: roomId, title: 'Late', idempotency_key: randomUUID() },
    'room_not_found',
  );
  await fails(app, b.key, 'city_room_cards', { room_id: roomId }, 'room_not_found');
});

test('erasing an account withdraws the approvals waiting for its answer', async (t) => {
  const app = await fixture(t);
  const { a, roomId, hostAgent } = await room(app);
  // A person account (erasure applies to person accounts) that a pending approval in another
  // owner's room waits for (seeded: a person's own AI asks it through an assistant grant).
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Erased owner', password: 'Synthetic erased owner password' }),
    remoteAddress: '198.51.201.10',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const personId = registered.json().operator.id as string;
  for (const [number, addressed, createdBy] of [
    [1, personId, a.id],
    [2, a.id, personId],
    [3, a.id, a.id],
  ] as const)
    await app.city.db.query(
      `INSERT INTO room_cards(id,room_id,kind,number,title,status,created_by_agent_id,created_by_owner_id,
          created_by_kind,addressed_to,addressed_owner_id,expires_at,created_at,updated_at)
        VALUES($1,$2,'approval',$3,'Seeded','pending',$4,$5,'agent','owner',$6,9999999999999,0,0)`,
      [randomUUID(), roomId, number, hostAgent, createdBy, addressed],
    );
  await eraseAccount(app.city.db, personId, { now: Date.now(), confirm: true });
  const rows = (
    await app.city.db.query<{ status: string }>(
      "SELECT status FROM room_cards WHERE room_id=$1 AND kind='approval' ORDER BY number",
      [roomId],
    )
  ).rows;
  // Waiting for the erased owner, or asked by it: withdrawn. Anyone else's: untouched.
  assert.deepEqual(
    rows.map((row) => row.status),
    ['withdrawn', 'withdrawn', 'pending'],
  );
});

test('mutes, pauses and reserved parts apply to edits, deletes and reactions too', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const post = async (text: string) =>
    (
      await ok(app, b.key, 'city_room_post', {
        room_id: roomId,
        text,
        idempotency_key: randomUUID(),
      })
    ).message;
  const message = await post('Plain message');
  // A handoff part is the server's, on an edit as on a post.
  await fails(
    app,
    b.key,
    'city_room_message_edit',
    {
      room_id: roomId,
      seq: message.seq,
      parts: [
        {
          type: 'data',
          mimeType: 'application/vnd.centralcity.handoff+json',
          data: { items: [] },
        },
      ],
    },
    'reserved_part',
  );
  const { sender_agent_id: agentId } = message;
  const mute = (muted: boolean) =>
    rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, { agent_id: agentId, muted });
  // Muted: no reaction, as no post.
  assert.equal((await mute(true)).statusCode, 200);
  await fails(
    app,
    b.key,
    'city_room_react',
    { room_id: roomId, seq: message.seq, emoji: '👍' },
    'muted_in_room',
  );
  assert.equal((await mute(false)).statusCode, 200);
  // Paused workspace: the AI changes nothing it said.
  const paused = await rest(app, b, 'POST', '/api/workspace/pause', { paused: true });
  assert.equal(paused.statusCode, 200, paused.body);
  for (const [tool, args] of [
    ['city_room_message_edit', { room_id: roomId, seq: message.seq, text: 'Changed' }],
    ['city_room_message_delete', { room_id: roomId, seq: message.seq }],
    ['city_room_react', { room_id: roomId, seq: message.seq, emoji: '👍' }],
  ] as const)
    await fails(app, b.key, tool, args, 'workspace_paused');
});

test('a removed member takes its mute with it; the owner’s other AI can post', async (t) => {
  const app = await fixture(t);
  const { a, roomId, link } = await room(app);
  const b = await member(app, link, 'Bravo');
  const second = await agent(app, b.key, 'Bravo second AI');
  await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: second,
    idempotency_key: randomUUID(),
  });
  const post = () =>
    call(app, b.key, 'city_room_post', {
      room_id: roomId,
      agent_id: second,
      text: 'Still here',
      idempotency_key: randomUUID(),
    });
  const mute = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: b.agentId,
    muted: true,
  });
  assert.equal(mute.statusCode, 200, mute.body);
  assert.equal((await post()).statusCode, 403);
  const removed = await rest(
    app,
    a,
    'POST',
    `/api/rooms/${roomId}/members/${b.agentId}/remove`,
    {},
  );
  assert.equal(removed.statusCode, 200, removed.body);
  const after = await post();
  assert.equal(after.statusCode, 200, after.body);
});
