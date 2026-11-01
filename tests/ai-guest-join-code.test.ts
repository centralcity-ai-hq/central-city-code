import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CityLimits } from '../server/limits.js';
import { createApp } from '../server/app.js';
import { formatShortCode, newShortCode, normalizeShortCode } from '../server/links/short-code.js';
import {
  SMOKE_GUEST_NAME,
  callOpenTool,
  injectTransport,
  joinWithInvite,
  outcomeErrorCode,
  type SmokeTransport,
  type ToolOutcome,
} from '../scripts/smoke/ai-guest.js';
import { sessionPair } from './session-cookie-pair.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-joincode-test-root-stand-in';

const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

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
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.12') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Join-code host',
    password: 'Synthetic join-code test password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = sessionPair(registered.cookies);
  const host = { cookie };
  const agent = await post(
    '/api/agents',
    { name: 'Host', capability: 'research', mode: 'hosted' },
    host,
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    { name: 'Join-code room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    host,
  );
  assert.equal(room.statusCode, 201, room.body);
  const roomId = room.json().room.id;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  // The short code the way a host would read it: the room link output on main.
  const shortCode = link.json().code as unknown;
  assert.equal(typeof shortCode, 'string', 'the room link output carries a short code');
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
      remoteAddress: '203.0.113.12',
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  return { app, post, host, roomId, code, shortCode: shortCode as string, transport };
}

/**
 * The uniform refusal message in a refused join's raw RPC body, if any. The
 * join helper keeps only the raw body, so the message is parsed from it
 * (JSON or SSE `data:` lines), never from any secret value.
 */
function messageInRaw(raw: string): string | null {
  try {
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
    ) as { result?: { content?: Array<{ text?: unknown }> } };
    const content = envelope.result?.content?.[0]?.text;
    if (typeof content !== 'string') return null;
    const message = (JSON.parse(content) as { error?: { message?: unknown } }).error?.message;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** Well-formed short codes no link aliases (all unknown by construction). */
function unknownShortCodes(known: string, count: number): string[] {
  const seen = new Set([normalizeShortCode(known)]);
  const codes: string[] = [];
  while (codes.length < count) {
    const candidate = formatShortCode(newShortCode());
    const normalized = normalizeShortCode(candidate);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    codes.push(candidate);
  }
  return codes;
}

test('a guest joins with the room short code, bare and as a /j/ link', async (t) => {
  const f = await fixture(t);
  const short = f.shortCode;
  // Guardrail: the short code is 8+ unambiguous characters.
  assert.match(short, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(short.replace(/-/g, '').length >= 8, 'short codes stay 8+ characters');
  // The bare code stands for the invite link it aliases on this origin (#131: the
  // short code rides in the existing invite_link field, no separate code input).
  const bare = await callOpenTool(f.transport, 'city_join_invite', {
    invite_link: short,
    name: SMOKE_GUEST_NAME,
    idempotency_key: randomUUID(),
  });
  assert.ok(bare.result && !bare.result.isError, 'bare short-code join must succeed');
  const bareContent = bare.result!.structuredContent!;
  assert.equal(bareContent['room_id'], f.roomId);
  assert.match(bareContent['room_credential'] as string, /^crc_/);
  // The /j/<code> form admits a second guest to the same room.
  const linked = await joinWithInvite(f.transport, short, SMOKE_GUEST_NAME, randomUUID());
  assert.equal(linked.ok, true, 'short-code /j/ link join must succeed');
  assert.equal(linked.guest!.roomId, f.roomId);
  assert.notEqual(linked.guest!.agentId, bareContent['agent_id']);
});

test('wrong-code attempts all return the same "invalid or expired" answer', async (t) => {
  const f = await fixture(t);
  // Well-formed but unknown codes in both shapes: each must get the uniform
  // invite_invalid answer (malformed links are a different refusal,
  // invalid_request, by design). Nothing may leak whether a code exists.
  const wrongLong = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const wrongShort = unknownShortCodes(f.shortCode, 3);
  const codes: string[] = [];
  const messages: Array<string | null> = [];
  for (const [index, code] of wrongLong.entries()) {
    const attempt = await joinWithInvite(f.transport, code, SMOKE_GUEST_NAME);
    assert.equal(attempt.ok, false, `wrong long code ${index} must be refused`);
    assert.equal(attempt.code, 'invite_invalid');
    assert.ok(!attempt.raw.includes(code));
    codes.push(attempt.code!);
    messages.push(messageInRaw(attempt.raw));
  }
  for (const [index, code] of wrongShort.entries()) {
    // Alternate the input form: /j/<code> links and the bare code alike.
    const attempt =
      index % 2 === 0
        ? await joinWithInvite(f.transport, code, SMOKE_GUEST_NAME)
        : await (async () => {
            const outcome: ToolOutcome = await callOpenTool(f.transport, 'city_join_invite', {
              invite_link: code,
              name: SMOKE_GUEST_NAME,
              idempotency_key: randomUUID(),
            });
            return {
              ok: Boolean(outcome.result && !outcome.result.isError),
              code: outcomeErrorCode(outcome),
              raw: outcome.raw,
            };
          })();
    assert.equal(attempt.ok, false, `wrong short code ${index} must be refused`);
    assert.equal(attempt.code, 'invite_invalid');
    assert.ok(!attempt.raw.includes(code));
    codes.push(attempt.code!);
    messages.push(messageInRaw(attempt.raw));
  }
  assert.ok(codes.every((code) => code === 'invite_invalid'));
  assert.ok(messages[0] !== null, 'the refusal carries a message');
  assert.ok(
    messages.every((message) => message === messages[0]),
    'one identical answer',
  );
});
