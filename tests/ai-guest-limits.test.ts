import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import { ROOM_LIMITS } from '../server/rooms/contract.js';
import { formatShortCode, newShortCode } from '../server/links/short-code.js';
import {
  callOpenTool,
  injectTransport,
  joinWithInvite,
  outcomeErrorCode,
  readAsGuest,
  type JoinOutcome,
  type SmokeTransport,
} from '../scripts/smoke/ai-guest.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-limits-test-root-stand-in-secret';

/**
 * Issue #140 ("Rooms: 100 joins by code and link"): a room of 100 guests joining from one
 * machine by link and by short code, with host cap control and the anonymous admission budgets.
 * Always runs (#140 and #220 are on main); a regression fails here instead of skipping.
 */
const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
/** Every AI guest joins from one machine, the way a room of 100 test guests does. */
const GUEST_ADDRESS = '203.0.113.12';

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  limits: Partial<CityLimits> = {},
) {
  let time = Date.now();
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    now: () => time,
    limits,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = GUEST_ADDRESS) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const get = (url: string, extra = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const registered = await post(
    '/api/auth/register',
    { name: 'Limits host', password: 'Synthetic limits test password' },
    {},
    '203.0.113.40',
  );
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const host = { cookie };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const created = await post(
    '/api/rooms',
    {
      name: 'Limits room',
      agent_id: agent.json().agent.id,
      member_cap: 100,
      idempotency_key: randomUUID(),
    },
    host,
  );
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().room.member_cap, 100);
  const roomId = created.json().room.id as string;
  const roomLink = created.json().link.link as string;
  // Room links default to 20 joins (docs/JOIN_LINKS.md); a room of 100 needs max_uses 100.
  const link = await post('/api/links', { target: 'room', room_id: roomId, max_uses: 100 }, host);
  assert.equal(link.statusCode, 201, link.body);
  const longCode = (link.json().url as string).split('/j/')[1]!;
  const shortCode = link.json().code as string;
  const transport: SmokeTransport = injectTransport(async (req) => {
    const res = await app.inject({
      method: req.method,
      url: req.path,
      headers: {
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
        ...(req.accept ? { accept: req.accept } : {}),
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      },
      ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
      remoteAddress: GUEST_ADDRESS,
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  return {
    app,
    post,
    get,
    host,
    roomId,
    roomLink,
    longCode,
    shortCode,
    transport,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

/** Join with the bare short code in invite_link (the /j/ link form is joinWithInvite's path). */
async function joinBareShortCode(
  transport: SmokeTransport,
  shortCode: string,
  name: string,
): Promise<JoinOutcome> {
  const outcome = await callOpenTool(transport, 'city_join_invite', {
    invite_link: shortCode,
    name,
    idempotency_key: randomUUID(),
  });
  const structured = outcome.result?.structuredContent;
  const credential = structured?.['room_credential'];
  const roomId = structured?.['room_id'];
  const agentId = structured?.['agent_id'];
  if (
    outcome.result &&
    !outcome.result.isError &&
    typeof credential === 'string' &&
    credential.startsWith('crc_') &&
    typeof roomId === 'string' &&
    typeof agentId === 'string'
  )
    return { ok: true, code: null, guest: { credential, roomId, agentId }, raw: outcome.raw };
  return { ok: false, code: outcomeErrorCode(outcome), guest: null, raw: outcome.raw };
}

interface ToolError {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  retry_after_ms?: unknown;
}

/** The MCP tool-error JSON a refused guest call carries (code, message, retry guidance). */
function toolErrorOf(raw: string): ToolError {
  const text = raw.trim();
  const envelope = (
    text.startsWith('{')
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join(''),
        )
  ) as { result?: { content?: Array<{ text?: string }> } };
  const payload = envelope.result?.content?.[0]?.text ?? '{}';
  return (JSON.parse(payload) as { error?: ToolError }).error ?? {};
}

describe('ai-guest limits (issue #140: rooms of 100)', () => {
  test('a room with member_cap 100 admits 30 guests by link and by short code', async (t) => {
    const f = await fixture(t);
    assert.match(f.shortCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const agentIds = new Set<string>();
    for (let index = 0; index < 30; index++) {
      const name = `Limits guest ${index + 1}`;
      const byLink = index % 2 === 0;
      const joined = byLink
        ? await joinWithInvite(f.transport, f.longCode, name, randomUUID())
        : await joinBareShortCode(f.transport, f.shortCode, name);
      assert.equal(joined.ok, true, `guest ${index + 1} joins by ${byLink ? 'link' : 'code'}`);
      const guest = joined.guest!;
      assert.equal(guest.roomId, f.roomId, `guest ${index + 1} lands in the room`);
      agentIds.add(guest.agentId);
    }
    assert.equal(agentIds.size, 30);
    const members = await f.get(`/api/rooms/${f.roomId}/members`, f.host);
    assert.equal(members.statusCode, 200, members.body);
    // The host agent, the host as a person (in its room from creation) and the 30 guests.
    assert.equal(members.json().members.length, 32);
    const list = await f.get('/api/rooms', f.host);
    assert.equal(list.statusCode, 200, list.body);
    const room = (
      list.json().rooms as Array<{ id: string; member_count: number; member_cap: number }>
    ).find((entry) => entry.id === f.roomId)!;
    assert.equal(room.member_count, 32);
    assert.equal(room.member_cap, 100);
  });

  test('the host lowers the cap: existing members stay, new joins get room_full', async (t) => {
    const f = await fixture(t);
    const first = await joinWithInvite(f.transport, f.longCode, 'Cap guest one', randomUUID());
    const second = await joinWithInvite(f.transport, f.longCode, 'Cap guest two', randomUUID());
    assert.equal(first.ok, true, 'first guest joins');
    assert.equal(second.ok, true, 'second guest joins');
    const registered = await f.post(
      '/api/auth/register',
      { name: 'Cap member', password: 'Synthetic limits test password' },
      {},
      '203.0.113.41',
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const other = { cookie };
    const otherAgent = await f.post(
      '/api/agents',
      { name: 'Member', capability: 'research', mode: 'hosted' },
      other,
    );
    assert.equal(otherAgent.statusCode, 201, otherAgent.body);
    const memberJoin = await f.post(
      `/api/rooms/${f.roomId}/join`,
      {
        link: f.roomLink,
        agent_id: otherAgent.json().agent.id,
        idempotency_key: randomUUID(),
      },
      other,
    );
    assert.equal(memberJoin.statusCode, 200, memberJoin.body);
    const setCap = (as: { cookie: string }, cap: number) =>
      f.post(`/api/rooms/${f.roomId}/settings`, { member_cap: cap }, as);
    // A member cannot change the cap.
    assert.equal((await setCap(other, 50)).statusCode, 403);
    // Below the five members (the host agent, the host as a person, two guests and the other
    // owner's AI): refused with the exact #140 code, and nobody is removed.
    const below = await setCap(f.host, 4);
    assert.equal(below.statusCode, 409, below.body);
    assert.equal(below.json().code, 'cap_below_members');
    const kept = await f.get(`/api/rooms/${f.roomId}/members`, f.host);
    assert.equal(kept.statusCode, 200, kept.body);
    assert.equal(kept.json().members.length, 5);
    assert.equal((await readAsGuest(f.transport, first.guest!.credential)).ok, true);
    // Out of range stays out of range.
    assert.equal((await setCap(f.host, 1)).statusCode, 400);
    assert.equal((await setCap(f.host, ROOM_LIMITS.memberCapMax + 1)).statusCode, 400);
    // At exactly the member count: further joins are refused with room_full.
    const exact = await setCap(f.host, 5);
    assert.equal(exact.statusCode, 200, exact.body);
    assert.equal(exact.json().room.member_cap, 5);
    const spare = await f.post(
      '/api/agents',
      { name: 'Spare', capability: 'research', mode: 'hosted' },
      other,
    );
    assert.equal(spare.statusCode, 201, spare.body);
    const full = await f.post(
      `/api/rooms/${f.roomId}/join`,
      { link: f.roomLink, agent_id: spare.json().agent.id, idempotency_key: randomUUID() },
      other,
    );
    assert.equal(full.statusCode, 409, full.body);
    assert.equal(full.json().code, 'room_full');
    // The invite path stays uniform when the room is full; existing guests keep reading.
    const late = await joinWithInvite(f.transport, f.longCode, 'Cap guest late', randomUUID());
    assert.equal(late.ok, false);
    assert.equal(late.code, 'invite_invalid');
    assert.equal((await readAsGuest(f.transport, second.guest!.credential)).ok, true);
  });

  test('a guest pages through the members with cursor and limit', async (t) => {
    const f = await fixture(t);
    const guests = [];
    for (let index = 0; index < 5; index++) {
      const joined = await joinWithInvite(
        f.transport,
        f.longCode,
        `Page guest ${index + 1}`,
        randomUUID(),
      );
      assert.equal(joined.ok, true, `guest ${index + 1} joins`);
      guests.push(joined.guest!);
    }
    const credential = guests[0]!.credential;
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const outcome = await callOpenTool(f.transport, 'city_room_members', {
        room_credential: credential,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      assert.equal(outcome.result?.isError ?? false, false, outcome.raw);
      const page = outcome.result!.structuredContent as {
        members: Array<{ id: string }>;
        next_cursor?: string;
      };
      assert.ok(page.members.length <= 2, 'a page holds at most limit members');
      seen.push(...page.members.map((member) => member.id));
      cursor = page.next_cursor;
      pages++;
      assert.ok(pages <= 10, 'paging ends');
    } while (cursor !== undefined);
    // The host agent, the host as a person and five guests, each exactly once, over four pages
    // of at most two.
    assert.equal(pages, 4);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    for (const guest of guests) assert.ok(seen.includes(guest.agentId));
    // Without limit the whole room fits the default page and no cursor is returned.
    const all = await callOpenTool(f.transport, 'city_room_members', {
      room_credential: credential,
    });
    const whole = all.result!.structuredContent as { members: unknown[]; next_cursor?: string };
    assert.equal(whole.members.length, 7);
    assert.equal(whole.next_cursor, undefined);
    // A malformed cursor is refused, not ignored.
    const bad = await callOpenTool(f.transport, 'city_room_members', {
      room_credential: credential,
      cursor: 'not a cursor!',
    });
    assert.equal(bad.result?.isError ?? bad.error !== undefined, true, bad.raw);
  });

  test('the per-source hourly admission budget answers 429 with Retry-After', async (t) => {
    // Small hourly budget the way the diff's own tests configure it; each join spends two
    // (bootstrap and redeem), so three joins succeed and the fourth exceeds it. Never sleeps:
    // the fixture clock backdates past the hour to prove the window resets.
    const f = await fixture(t, { inviteRequestsPerSourcePerHour: 6 });
    for (let index = 0; index < 3; index++) {
      const joined = await joinWithInvite(
        f.transport,
        f.longCode,
        `Budget guest ${index + 1}`,
        randomUUID(),
      );
      assert.equal(joined.ok, true, `budget guest ${index + 1} joins within budget`);
    }
    const over = await joinWithInvite(f.transport, f.longCode, 'Budget guest 4', randomUUID());
    assert.equal(over.ok, false);
    assert.equal(over.code, 'rate_limited');
    const limited = toolErrorOf(over.raw);
    assert.equal(limited.retryable, true);
    assert.ok(typeof limited.retry_after_ms === 'number' && limited.retry_after_ms > 0);
    // REST answers the same budget with 429 and a Retry-After header.
    const rest = await f.post('/api/public/invites/bootstrap', { code: f.longCode });
    assert.equal(rest.statusCode, 429);
    assert.ok(Number(rest.headers['retry-after']) >= 1);
    // An hour later the budget is back.
    f.advance(3_600_000 + 1);
    const revived = await f.post('/api/public/invites/bootstrap', { code: f.longCode });
    assert.equal(revived.statusCode, 200);
  });

  test('a used-up code answers the same uniform invalid as a wrong code', async (t) => {
    const f = await fixture(t);
    const single = await f.post(
      '/api/links',
      { target: 'room', room_id: f.roomId, single_use: true },
      f.host,
    );
    assert.equal(single.statusCode, 201, single.body);
    const singleCode = (single.json().url as string).split('/j/')[1]!;
    const used = await joinWithInvite(f.transport, singleCode, 'Single guest', randomUUID());
    assert.equal(used.ok, true, 'a single-use code admits exactly one guest');
    // Wrong codes are generated, never literals, and never equal to a live code.
    const wrongLong = randomBytes(32).toString('base64url');
    assert.ok(wrongLong !== singleCode && wrongLong !== f.longCode);
    let wrongShort = formatShortCode(newShortCode());
    for (let attempt = 0; attempt < 5 && wrongShort === f.shortCode; attempt++)
      wrongShort = formatShortCode(newShortCode());
    assert.ok(wrongShort !== f.shortCode);
    const spent = await joinWithInvite(f.transport, singleCode, 'Late guest', randomUUID());
    const wrongLongOut = await joinWithInvite(f.transport, wrongLong, 'Wrong guest', randomUUID());
    const wrongShortOut = await joinWithInvite(
      f.transport,
      wrongShort,
      'Wrong guest',
      randomUUID(),
    );
    for (const [name, outcome] of [
      ['used-up', spent],
      ['wrong long', wrongLongOut],
      ['wrong short', wrongShortOut],
    ] as const) {
      assert.equal(outcome.ok, false, `${name} code is refused`);
      assert.equal(outcome.code, 'invite_invalid', `${name} code stays uniform`);
    }
    assert.equal(toolErrorOf(wrongLongOut.raw).message, toolErrorOf(spent.raw).message);
    assert.equal(toolErrorOf(wrongShortOut.raw).message, toolErrorOf(spent.raw).message);
    assert.ok(!spent.raw.includes(singleCode));
    assert.ok(!wrongLongOut.raw.includes(wrongLong));
    assert.ok(!wrongShortOut.raw.includes(wrongShort));
  });
});
