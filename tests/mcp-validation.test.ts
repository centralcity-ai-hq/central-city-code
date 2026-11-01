import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { z as zod, type z } from 'zod';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  argumentHint,
  compactJsonSchema,
  withUniformValidation,
} from '../server/remote-mcp/validation.js';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { ANONYMOUS_TOOLS } from '../shared/assistant-tools.js';
import { openOnlyInputSchemas, remoteInputSchemas } from '../server/remote-mcp/tools.js';
import { openInviteTools } from '../server/remote-mcp/open-invite.js';
import { roomReadToolInput } from '../server/rooms/contract.js';
import { guestToolsNow } from '../server/links/invites.js';
import { rpcResult } from './oauth-helpers.js';
import { sessionPair } from './session-cookie-pair.js';

/**
 * Every schema failure on every remote MCP tool answers with the uniform invalid_arguments body
 * (server/remote-mcp/validation.ts), not the SDK's plain-text "Invalid arguments for tool ...":
 * isError, {error: {code, message naming the fields, retryable: false, issues: [{path, message}]}},
 * and never the received value. tools/list keeps advertising the exact schemas. Synthetic data.
 */
process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-open-invite-test-root-secret';
/** A value that must never appear in any answer. */
const MARKER = 'zzqvalidationmarker';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 1;
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      // Bootstrap and redeem of one invite come from one address.
      remoteAddress: url.includes('/invites/') ? '203.0.113.12' : `198.51.100.${address++}`,
    });
  const registered = await post('/api/auth/register', {
    name: 'Validation host',
    password: 'Synthetic validation password',
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = sessionPair(registered.cookies);
  const agent = await post(
    '/api/agents',
    { name: 'Validation desk', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  assert.equal(agent.statusCode, 201, agent.body);
  const room = await post(
    '/api/rooms',
    { name: 'Validation room', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    { cookie },
  );
  assert.equal(room.statusCode, 201, room.body);
  const link = await post(
    '/api/links',
    { target: 'room', room_id: room.json().room.id },
    { cookie },
  );
  assert.equal(link.statusCode, 201, link.body);
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  const start = await post('/api/public/invites/bootstrap', { code });
  assert.equal(start.statusCode, 200, start.body);
  const joined = await post('/api/public/invites/redeem', {
    code,
    handle: start.json().handle,
    name: 'Validation guest',
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const roomCredential = JSON.stringify(joined.json()).match(/crc_[A-Za-z0-9_-]+/)![0];

  // An AI-owned workspace co-owned by the host; keys are minted with the scopes a test needs.
  const workspace = await post('/api/public/workspaces', {
    name: 'Validation workspace',
    idempotency_key: randomUUID(),
  });
  assert.equal(workspace.statusCode, 201, workspace.body);
  const claimed = await post(
    '/api/workspaces/claim',
    { claim_token: workspace.json().claim_token },
    { cookie },
  );
  assert.equal(claimed.statusCode, 200, claimed.body);
  const mintKey = async (scopes: readonly string[]) => {
    const minted = await post(
      '/api/workspace-keys',
      { label: 'validation', scopes: [...scopes] },
      { cookie, 'x-city-workspace': workspace.json().workspace_id },
    );
    assert.equal(minted.statusCode, 201, minted.body);
    return minted.json().workspace_key as string;
  };
  const rpc = async (url: string, token: string | undefined, method: string, params: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: { jsonrpc: '2.0', id: 1, method, params },
      remoteAddress: '203.0.113.12',
    });
  const call = async (url: string, token: string | undefined, name: string, args: unknown) => {
    const res = await rpc(url, token, 'tools/call', { name, arguments: args });
    assert.equal(res.statusCode, 200, res.body);
    const parsed = rpcResult(res.body);
    assert.equal(parsed.error, undefined, res.body);
    return { body: res.body, result: parsed.result as ToolResult };
  };
  const list = async (url: string, token?: string) => {
    const res = await rpc(url, token, 'tools/list', {});
    assert.equal(res.statusCode, 200, res.body);
    return rpcResult(res.body).result.tools as Array<{ name: string; inputSchema: unknown }>;
  };
  const roomId = room.json().room.id as string;
  return {
    app,
    key: await mintKey(ASSISTANT_SCOPES),
    mintKey,
    roomCredential,
    roomId,
    rpc,
    call,
    list,
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** Asserts the uniform body and returns it: code, a field-naming message, issues, no value. */
function invalidArguments(
  outcome: { body: string; result: ToolResult },
  expected: Array<{ path: string; message: string | RegExp }>,
) {
  const { body, result } = outcome;
  assert.equal(result.isError, true, body);
  assert.doesNotMatch(body, /Invalid arguments for tool|Input validation error/, body);
  assert.ok(!body.includes(MARKER), `the received value is echoed: ${body}`);
  const error = JSON.parse(result.content[0]!.text).error as {
    code: string;
    message: string;
    retryable: boolean;
    issues: Array<{ path: string; message: string }>;
  };
  assert.equal(error.code, 'invalid_arguments', body);
  assert.equal(error.retryable, false);
  assert.match(error.message, /^Check these fields: /);
  assert.ok(Array.isArray(error.issues) && error.issues.length > 0, body);
  for (const issue of error.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ['message', 'path']);
    assert.equal(typeof issue.path, 'string');
    assert.equal(typeof issue.message, 'string');
  }
  for (const want of expected) {
    const issue = error.issues.find((item) => item.path === want.path);
    assert.ok(issue, `no issue for ${want.path}: ${body}`);
    if (typeof want.message === 'string') assert.equal(issue.message, want.message);
    else assert.match(issue.message, want.message);
    assert.ok(error.message.includes(want.path), error.message);
  }
  return error;
}

test('a non-UUID from_agent_id on city_send_message gets invalid_arguments with issues', async (t) => {
  const f = await fixture(t);
  const error = invalidArguments(
    await f.call('/mcp', f.key, 'city_send_message', {
      from_agent_id: `${MARKER}-not-a-uuid`,
      to_agent_id: randomUUID(),
      text: 'hello',
      idempotency_key: randomUUID(),
    }),
    [{ path: 'from_agent_id', message: 'Must be a UUID' }],
  );
  assert.equal(error.message, 'Check these fields: from_agent_id (must be a UUID).');
});

test('a missing required field on city_room_post via /mcp/open gets invalid_arguments', async (t) => {
  const f = await fixture(t);
  const outcome = await f.call('/mcp/open', undefined, 'city_room_post', {
    room_credential: f.roomCredential,
    text: MARKER,
  });
  invalidArguments(outcome, [{ path: 'idempotency_key', message: 'Required' }]);
  // The post contract still states the outcome explicitly.
  assert.match(outcome.result.content[1]!.text, /^Not posted: .*Nothing was added to the room\.$/);
});

test('a wrong type on city_ask gets invalid_arguments naming the field', async (t) => {
  const f = await fixture(t);
  invalidArguments(
    await f.call('/mcp', f.key, 'city_ask', {
      agent_id: randomUUID(),
      question: 424242,
      need_sources: MARKER,
    }),
    [
      { path: 'question', message: 'Must be text' },
      { path: 'need_sources', message: 'Must be true or false' },
    ],
  );
});

test('an unknown extra field gets invalid_arguments on every endpoint', async (t) => {
  const f = await fixture(t);
  const unknown = { path: 'surprise_field', message: 'Unknown field' };
  // /mcp (workspace credential).
  invalidArguments(await f.call('/mcp', f.key, 'city_workspace', { surprise_field: MARKER }), [
    unknown,
  ]);
  // /mcp/open, anonymous tools and invite tools.
  invalidArguments(
    await f.call('/mcp/open', undefined, 'city_list_templates', { surprise_field: MARKER }),
    [unknown],
  );
  invalidArguments(
    await f.call('/mcp/open', undefined, 'city_room_members', {
      room_credential: f.roomCredential,
      surprise_field: MARKER,
    }),
    [unknown],
  );
  // /mcp with a room-only crc_ credential.
  invalidArguments(
    await f.call('/mcp', f.roomCredential, 'city_room_members', {
      room_id: randomUUID(),
      surprise_field: MARKER,
    }),
    [unknown],
  );
  invalidArguments(
    await f.call('/mcp', f.roomCredential, 'city_room_read', {
      room_id: randomUUID(),
      wait: 5,
      surprise_field: MARKER,
    }),
    [unknown, { path: 'wait', message: 'Unknown field' }],
  );
});

test('the most common wrong arguments get a fixed hint, never an echoed value', async (t) => {
  const f = await fixture(t);
  const hintOf = (outcome: { result: ToolResult }) =>
    JSON.parse(outcome.result.content[0]!.text).error.hint as string | undefined;
  // A guest on /mcp/open passing room_id and agent_id instead of its credential.
  const ids = await f.call('/mcp/open', undefined, 'city_room_read', {
    room_id: MARKER,
    agent_id: MARKER,
  });
  invalidArguments(ids, [
    { path: 'room_id', message: 'Unknown field' },
    { path: 'agent_id', message: 'Unknown field' },
  ]);
  assert.match(hintOf(ids)!, /pass room_credential .* in place of room_id and agent_id/);
  // The text under another name: the hint says text, and the post contract line carries it.
  const named = await f.call('/mcp/open', undefined, 'city_room_post', {
    room_credential: f.roomCredential,
    message: MARKER,
    idempotency_key: randomUUID(),
  });
  assert.equal(named.result.isError, true);
  assert.ok(!named.body.includes(MARKER), 'the received value is never echoed');
  assert.equal(hintOf(named), 'Put the message in text (or parts).');
  assert.match(
    named.result.content[1]!.text,
    /Put the message in text \(or parts\)\. Nothing was added/,
  );
  // On /mcp, room_id is right: no credential hint there.
  const member = await f.call('/mcp', f.key, 'city_workspace', { room_id: MARKER });
  assert.equal(hintOf(member), undefined);
});

test('valid arguments still reach the tool, parsed', async (t) => {
  const f = await fixture(t);
  const { result, body } = await f.call('/mcp', f.key, 'city_workspace', {});
  assert.notEqual(result.isError, true, body);
  const posted = await f.call('/mcp/open', undefined, 'city_room_post', {
    room_credential: f.roomCredential,
    text: 'Synthetic hello',
    idempotency_key: randomUUID(),
  });
  assert.notEqual(posted.result.isError, true, posted.body);
});

test('scope checks keep their order around argument validation', async (t) => {
  const f = await fixture(t);
  // The HTTP step-up (403 insufficient_scope) still comes before argument validation.
  const readOnly = await f.mintKey(['workspace:read']);
  const refused = await f.rpc('/mcp', readOnly, 'tools/call', {
    name: 'city_send_message',
    arguments: { from_agent_id: MARKER, to_agent_id: randomUUID(), text: 'hello' },
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(String(refused.headers['www-authenticate']), /error="insufficient_scope"/);
  assert.ok(!refused.body.includes(MARKER));
  // Argument validation still comes before the in-handler check (create: needs agents:create).
  const joiner = await f.mintKey(['workspace:read', 'rooms:join']);
  invalidArguments(
    await f.call('/mcp', joiner, 'city_join_room', {
      link: MARKER,
      create: { name: 'Validation joiner' },
    }),
    [{ path: 'idempotency_key', message: 'Required' }],
  );
  const needsCreate = await f.call('/mcp', joiner, 'city_join_room', {
    link: 'https://centralcity.ai/j/unknown',
    create: { name: 'Validation joiner' },
    idempotency_key: randomUUID(),
  });
  assert.equal(needsCreate.result.isError, true);
  assert.equal(JSON.parse(needsCreate.result.content[0]!.text).error.code, 'insufficient_scope');
});

/** The inputSchema the SDK advertises for a zod schema (same conversion as tools/list). */
const advertised = (schema: z.ZodType) =>
  JSON.parse(
    JSON.stringify({
      type: 'object',
      ...schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    }),
  );

test('tools/list still advertises the exact input schemas on every endpoint', async (t) => {
  // The core tools' schemas. The Feed's tools (live by default) are checked by their own tests
  // (tests/feed-service-search-tool.test.ts and the Feed pay tests): switched off here.
  const feedBefore = process.env.CITY_FEED;
  process.env.CITY_FEED = '0';
  t.after(() => {
    if (feedBefore === undefined) delete process.env.CITY_FEED;
    else process.env.CITY_FEED = feedBefore;
  });
  const f = await fixture(t);
  const check = (
    tools: Array<{ name: string; inputSchema: unknown }>,
    expected: Record<string, z.ZodType>,
    compact = false,
  ) => {
    assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(expected).sort());
    for (const tool of tools) {
      const want = advertised(expected[tool.name]!);
      assert.deepEqual(tool.inputSchema, compact ? compactJsonSchema(want) : want, tool.name);
    }
  };
  const all: Record<string, z.ZodType> = { ...remoteInputSchemas, ...openOnlyInputSchemas };
  check(await f.list('/mcp', f.key), remoteInputSchemas);
  check(
    await f.list('/mcp/open'),
    {
      ...Object.fromEntries(ANONYMOUS_TOOLS.map((name) => [name, all[name]!])),
      ...(openInviteTools() as Record<string, z.ZodType>),
    },
    // /mcp/open advertises compact copies (no $schema, no pattern beside format: uuid).
    true,
  );
  const remote = remoteInputSchemas as Record<string, z.ZodType>;
  check(
    await f.list('/mcp', f.roomCredential),
    Object.fromEntries(
      guestToolsNow()
        .filter((name) => remote[name])
        .map((name) => [name, name === 'city_room_read' ? roomReadToolInput : remote[name]!]),
    ),
  );
});

test('/mcp with a room credential lists the guest pin, brief, overview and mention tools and runs them', async (t) => {
  const f = await fixture(t);
  const names = (await f.list('/mcp', f.roomCredential)).map((tool) => tool.name);
  for (const name of [
    'city_room_pins',
    'city_room_brief',
    'city_room_pin',
    'city_room_unpin',
    'city_room_overview',
    'city_mentions',
    'city_ack_mentions',
  ])
    assert.ok(names.includes(name), `${name} missing: ${names.join(', ')}`);
  const brief = await f.call('/mcp', f.roomCredential, 'city_room_brief', {
    room_id: f.roomId,
  });
  assert.notEqual(brief.result.isError, true, brief.body);
  assert.equal(typeof JSON.parse(brief.result.content[0]!.text).brief, 'string', brief.body);
});

test('every listed tool on every endpoint answers an unknown field with invalid_arguments', async (t) => {
  const f = await fixture(t);
  const endpoints: Array<[string, string, string | undefined]> = [
    ['/mcp (workspace key)', '/mcp', f.key],
    ['/mcp (room-only crc_)', '/mcp', f.roomCredential],
    ['/mcp/open (invites on)', '/mcp/open', undefined],
  ];
  for (const [label, url, token] of endpoints) {
    const tools = await f.list(url, token);
    assert.ok(tools.length > 0, label);
    for (const { name } of tools) {
      const outcome = await f.call(url, token, name, { surprise_field: MARKER });
      assert.equal(outcome.result.isError, true, `${label} ${name}: ${outcome.body}`);
      const error = JSON.parse(outcome.result.content[0]!.text).error;
      assert.equal(error.code, 'invalid_arguments', `${label} ${name}: ${outcome.body}`);
      invalidArguments(outcome, [{ path: 'surprise_field', message: 'Unknown field' }]);
    }
  }
});

test('the handler receives the parsed arguments (defaults and transforms applied)', async () => {
  const server = new McpServer({ name: 'validation-probe', version: '0.0.0' });
  const received: unknown[] = [];
  server.registerTool(
    'probe',
    {
      description: 'Records its arguments.',
      inputSchema: zod
        .object({
          name: zod.string().trim().min(1),
          limit: zod.number().int().min(1).max(50).default(20),
        })
        .strict(),
    },
    async (args: unknown) => {
      received.push(args);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );
  const handler = createMcpHandler(() => withUniformValidation(server), {
    legacy: 'stateless',
  });
  const call = async (args: unknown) => {
    const response = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'probe', arguments: args },
        }),
      }),
    );
    return rpcResult(await response.text()).result as ToolResult;
  };
  try {
    const ok = await call({ name: '  Padded name  ' });
    assert.notEqual(ok.isError, true, JSON.stringify(ok));
    // The default (limit 20) and the transform (trim) reached the handler.
    assert.deepEqual(received, [{ name: 'Padded name', limit: 20 }]);
    const refused = await call({ name: '   ', limit: MARKER });
    assert.equal(refused.isError, true);
    assert.deepEqual(
      JSON.parse(refused.content[0]!.text).error.issues.map((i: { path: string }) => i.path),
      ['name', 'limit'],
    );
    assert.equal(received.length, 1, 'the handler must not run for invalid arguments');
  } finally {
    await handler.close();
  }
});

test('a server without the SDK tool registry fails loudly, not inside Object.entries', () => {
  assert.throws(
    () => withUniformValidation({} as McpServer),
    new Error(
      'MCP SDK internals changed: _registeredTools not found; recheck server/remote-mcp/validation.ts after the SDK upgrade',
    ),
  );
});

test('DM, pin and search argument hints name the real field', () => {
  const unknown = (path: string) => [{ path, message: 'Unknown field' }];
  assert.match(argumentHint('city_room_dm_send', unknown('to'), true)!, /to_agent_id/);
  assert.match(argumentHint('city_room_pin', unknown('seq'), true)!, /message_seq/);
  assert.equal(
    argumentHint('city_room_search', unknown('query'), true),
    'Put the search words in q.',
  );
  // seq is right for react: no hint there.
  assert.equal(argumentHint('city_room_react', unknown('message_seq'), true), undefined);
});

test('task argument hints: comment body, lease minutes, result evidence', () => {
  const unknown = (path: string) => [{ path, message: 'Unknown field' }];
  assert.equal(
    argumentHint('city_room_task_comment_add', unknown('text'), true),
    'Put the comment in body.',
  );
  assert.equal(
    argumentHint('city_room_task_claim', unknown('ttl_seconds'), false),
    'The lease is ttl_minutes (5-120).',
  );
  // summary is a real field now; the result's text under another name points at it.
  assert.equal(argumentHint('city_room_task_result', unknown('summary'), true), undefined);
  assert.equal(
    argumentHint('city_room_task_result', unknown('text'), true),
    'Put the result in summary.',
  );
  assert.equal(argumentHint('city_room_task_list', unknown('text'), true), undefined);
});

test('broken JSON on the MCP endpoints is a JSON-RPC parse error; other routes keep theirs', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const broken = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', host: 'centralcity.ai' },
      payload: '{bad',
      remoteAddress: '198.51.100.200',
    });
  for (const url of ['/mcp/open', '/mcp']) {
    const res = await broken(url);
    assert.equal(res.statusCode, 400, url);
    assert.deepEqual(res.json(), {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
  assert.deepEqual((await broken('/api/public/invites/tools/city_room_read')).json(), {
    error: 'Invalid JSON',
  });
});
