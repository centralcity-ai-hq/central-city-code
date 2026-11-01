import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { AgentMessage, InboxPage } from '../server/messaging/contract.js';
import { parseA2AIntent, type A2ATask } from '../protocol/a2a.js';
import type { RoomLinkView, RoomMember } from '../server/rooms/contract.js';
import type {
  CompactRoomMessage as RoomMessage,
  CompactRoomView as RoomView,
} from '../server/remote-mcp/compact-room.js';
import { createApp } from '../server/app.js';
import { highEntropyKey } from '../server/autonomy/index.js';
import {
  PROTOCOL_SCHEMAS,
  SCHEMA_BASE,
  SCHEMA_DIR,
  a2aRequestMirror,
  a2aTaskMirror,
  agentMessageMirror,
  buildProtocolSchemas,
  caseInsensitivePattern,
  diffProtocolSchemas,
  inboxPageMirror,
  joinDocumentMirror,
  roomLinkViewSchema,
  roomMemberSchema,
  roomMessageSchema,
  roomViewSchema,
} from '../scripts/export-protocol-schemas.js';

// Ajv is not a direct dependency; use the copy the MCP SDK already ships (no package.json change).
const sdkRequire = createRequire(
  fileURLToPath(import.meta.resolve('@modelcontextprotocol/server')),
);
const Ajv2020 = sdkRequire('ajv/dist/2020').default as new (options: object) => {
  addSchema(schema: object): unknown;
  getSchema(id: string): ((value: unknown) => boolean) | undefined;
};
const addFormats = sdkRequire('ajv-formats').default as (ajv: unknown) => void;

const CONFORMANCE_DIR = fileURLToPath(new URL('../protocol/conformance/', import.meta.url));
const VERDICTS = ['valid', 'invalid', 'semantic'] as const;

// Compile-time pins: the mirror schemas describe exactly the TypeScript wire types.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const pin = <T extends true>(value: T) => value;
pin<Equal<z.infer<typeof agentMessageMirror>, AgentMessage>>(true);
pin<Equal<z.infer<typeof inboxPageMirror>, InboxPage>>(true);
pin<Equal<z.infer<typeof a2aTaskMirror>, A2ATask>>(true);
// The room output schemas (the MCP tools' zod) describe exactly the service's TypeScript types.
pin<Equal<z.infer<typeof roomViewSchema>, RoomView>>(true);
pin<Equal<z.infer<typeof roomMessageSchema>, RoomMessage>>(true);
pin<Equal<z.infer<typeof roomMemberSchema>, RoomMember>>(true);
pin<Equal<z.infer<typeof roomLinkViewSchema>, RoomLinkView>>(true);

function validator() {
  const ajv = new Ajv2020({
    strict: true,
    // `oneOf: [{required: [text]}, {required: [parts]}]` names properties declared by the parent.
    strictRequired: false,
    allErrors: true,
  });
  addFormats(ajv);
  for (const [, schema] of buildProtocolSchemas())
    if (typeof schema.$id === 'string') ajv.addSchema(schema);
  return (file: string) => {
    const validate = ajv.getSchema(SCHEMA_BASE + file);
    assert.ok(validate, `schema ${file} compiles`);
    return validate;
  };
}

/** The reference verdicts: every zod source, plus the real A2A parser for requests. */
function referenceVerdicts(file: string, value: unknown): boolean[] {
  const entry = PROTOCOL_SCHEMAS.find((item) => item.file === file)!;
  const verdicts = [entry.schema.safeParse(value).success];
  if (entry.schema === a2aRequestMirror) {
    let parsed = true;
    try {
      parseA2AIntent(JSON.stringify(value), { version: '1.0', binding: 'JSONRPC' });
    } catch {
      parsed = false;
    }
    verdicts.push(parsed);
  }
  return verdicts;
}

async function fixtures() {
  const found: Array<{ file: string; verdict: (typeof VERDICTS)[number]; name: string }> = [];
  for (const entry of PROTOCOL_SCHEMAS) {
    const base = entry.file.replace(/\.schema\.json$/, '');
    for (const verdict of VERDICTS) {
      let names: string[] = [];
      try {
        names = (await readdir(join(CONFORMANCE_DIR, base, verdict))).filter((name) =>
          name.endsWith('.json'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const name of names.sort())
        found.push({ file: entry.file, verdict, name: `${base}/${verdict}/${name}` });
    }
  }
  return found;
}

test('committed JSON Schemas match the zod sources (regenerate with scripts/export-protocol-schemas.ts)', async () => {
  assert.deepEqual(await diffProtocolSchemas(), []);
});

test('every schema is draft 2020-12 with an $id under the public schema base', () => {
  const ids = new Set<string>();
  for (const [file, schema] of buildProtocolSchemas()) {
    if (file === 'index.json') continue;
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', file);
    assert.equal(schema.$id, SCHEMA_BASE + file, file);
    assert.ok(!ids.has(schema.$id as string), `duplicate $id ${file}`);
    ids.add(schema.$id as string);
  }
  assert.equal(ids.size, PROTOCOL_SCHEMAS.length);
});

test('conformance fixtures get identical verdicts from JSON Schema and the zod source', async () => {
  const compiled = validator();
  const all = await fixtures();
  for (const entry of PROTOCOL_SCHEMAS) {
    const base = entry.file.replace(/\.schema\.json$/, '');
    for (const verdict of ['valid', 'invalid'] as const)
      assert.ok(
        all.some((item) => item.file === entry.file && item.verdict === verdict),
        `${base} has ${verdict} fixtures`,
      );
  }
  for (const fixture of all) {
    const value: unknown = JSON.parse(await readFile(join(CONFORMANCE_DIR, fixture.name), 'utf8'));
    const schemaVerdict = compiled(fixture.file)(value);
    const reference = referenceVerdicts(fixture.file, value);
    if (fixture.verdict === 'semantic') {
      // A rule JSON Schema cannot express: the schema accepts, the reference rejects. If the schema
      // starts rejecting it, move the fixture to invalid/.
      assert.equal(schemaVerdict, true, `${fixture.name}: JSON Schema accepts`);
      for (const verdict of reference) assert.equal(verdict, false, `${fixture.name}: zod rejects`);
      continue;
    }
    const expected = fixture.verdict === 'valid';
    assert.equal(schemaVerdict, expected, `${fixture.name}: JSON Schema verdict`);
    for (const verdict of reference)
      assert.equal(verdict, expected, `${fixture.name}: zod verdict`);
  }
});

test('existing A2A protocol fixtures validate against the exported A2A schemas', async () => {
  const compiled = validator();
  const read = async (name: string) =>
    JSON.parse(
      await readFile(new URL(`../protocol/fixtures/${name}.json`, import.meta.url), 'utf8'),
    ) as unknown;
  assert.equal(compiled('a2a/request.v1.schema.json')(await read('a2a-send-message')), true);
  assert.equal(compiled('a2a/task.v1.schema.json')(await read('a2a-completed-task')), true);
});

test('case-insensitive zod patterns are rewritten exactly for flagless JSON Schema', () => {
  assert.equal(caseInsensitivePattern('^[a-z0-9]+\\/[a-f]$'), '^[a-zA-Z0-9]+\\/[a-fA-F]$');
  assert.throws(() => caseInsensitivePattern('^abc$'));
  const pattern = new RegExp(
    (
      buildProtocolSchemas().get('messaging/message-part.v1.schema.json') as {
        oneOf: Array<{ properties: { mimeType?: { pattern: string } } }>;
      }
    ).oneOf[1]!.properties.mimeType!.pattern,
  );
  for (const value of ['application/json', 'Application/JSON', 'TEXT/PLAIN'])
    assert.ok(pattern.test(value), value);
});

/**
 * Implementation paths (files or directories such as server/rooms/) dangle in the public protocol
 * repository: describe rules instead. URL paths such as /api/rooms stay allowed.
 */
const IMPLEMENTATION_PATH = /(?<![\w./-])(?:server|shared|scripts|src|tests|api)\/[\w.-]/;

test('the implementation-path guard catches files and directories but not URL paths', () => {
  for (const text of [
    'See server/rooms/ for details.',
    'Source: server/rooms/contract.ts.',
    '(shared/manifest.ts)',
    'run scripts/export-protocol-schemas.ts',
    '`tests/protocol-schemas.test.ts`',
    'src/ui',
    'api/index.ts',
  ])
    assert.match(text, IMPLEMENTATION_PATH, text);
  for (const text of [
    'REST under `/api/rooms` and `/api/links`',
    'GET /api/rooms/:room/messages',
    'https://centralcity.ai/api/links',
    'the server secret',
    'a shared thread',
  ])
    assert.doesNotMatch(text, IMPLEMENTATION_PATH, text);
});

/** Internal names from scripts/public-docs/private-patterns.ts, when this checkout has the file. */
const privatePatternsUrl = new URL('../scripts/public-docs/private-patterns.ts', import.meta.url);
const privateReferences: RegExp[] = existsSync(fileURLToPath(privatePatternsUrl))
  ? ((await import(privatePatternsUrl.href)) as { PRIVATE_REFERENCES: RegExp[] }).PRIVATE_REFERENCES
  : [];

test('published protocol files carry no internal references or loopback hosts', async () => {
  const patterns = [
    /\blocalhost\b|\b127\.0\.0\.1\b|\[::1\]/,
    /(?<![\w-])handoffs?\/|(?<![\w-])coordination\//i,
    ...privateReferences,
    /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+/,
    /\b[A-Za-z0-9][A-Za-z0-9-]*\.(?:local|lan|home\.arpa|internal)\b/,
    /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
    IMPLEMENTATION_PATH,
  ];
  const scan = async (dir: string): Promise<number> => {
    let count = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        count += await scan(path);
        continue;
      }
      const text = await readFile(path, 'utf8');
      for (const pattern of patterns) assert.doesNotMatch(text, pattern, path);
      count++;
    }
    return count;
  };
  assert.ok((await scan(SCHEMA_DIR)) > PROTOCOL_SCHEMAS.length);
  assert.ok((await scan(CONFORMANCE_DIR)) > PROTOCOL_SCHEMAS.length * 2);
  const specs = (await readdir(join(SCHEMA_DIR, '..'))).filter((name) => name.endsWith('.md'));
  assert.ok(specs.includes('ROOMS.md'));
  for (const name of specs) {
    const text = await readFile(join(SCHEMA_DIR, '..', name), 'utf8');
    for (const pattern of patterns) assert.doesNotMatch(text, pattern, name);
    assert.doesNotMatch(text, /\bINTERNAL\b|\bCONFIDENTIAL\b/, name);
  }
});

test('live room and join-link responses validate against the exported schemas', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const compiled = validator();
  const check = (file: string, value: unknown) => {
    assert.equal(compiled(file)(value), true, `${file}: ${JSON.stringify(value).slice(0, 300)}`);
  };
  const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
  const call = async (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const account = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: 'Synthetic schema test password' }),
    });
    const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
    const agent = await call(cookie, 'POST', '/api/agents', {
      name: `${name} agent`,
      capability: 'research',
      mode: 'hosted',
    });
    return { cookie, agentId: agent.agent.id as string };
  };
  const host = await account('Schema host');
  const guest = await account('Schema member');
  const created = await call(host.cookie, 'POST', '/api/rooms', {
    agent_id: host.agentId,
    name: 'Schema room',
    idempotency_key: randomUUID(),
  });
  check('rooms/room.v1.schema.json', created.room);
  check('rooms/link.v1.schema.json', created.link);
  const room = created.room.id as string;
  const joined = await call(guest.cookie, 'POST', `/api/rooms/${room}/join`, {
    token: new URL(created.link.link).hash.slice(1),
    agent_id: guest.agentId,
    idempotency_key: randomUUID(),
  });
  check('rooms/room.v1.schema.json', joined.room);
  const posted = await call(guest.cookie, 'POST', `/api/rooms/${room}/messages`, {
    parts: [
      { type: 'text', text: 'Schema check' },
      { type: 'data', data: { ok: true } },
    ],
    idempotency_key: randomUUID(),
  });
  check('rooms/message.v1.schema.json', posted.message);
  check(
    'rooms/read-page.v1.schema.json',
    await call(host.cookie, 'GET', `/api/rooms/${room}/messages?since=0`),
  );
  for (const member of (await call(host.cookie, 'GET', `/api/rooms/${room}/members`)).members)
    check('rooms/member.v1.schema.json', member);
  check('rooms/link.v1.schema.json', await call(host.cookie, 'POST', `/api/rooms/${room}/link`));

  const document = async (url: string, status: number) => {
    const res = await app.inject({
      method: 'GET',
      url: `${new URL(url, 'https://x.invalid').pathname}?format=json`,
    });
    assert.equal(res.statusCode, status, res.body);
    const body: unknown = res.json();
    check('links/join-document.v1.schema.json', body);
    assert.equal(joinDocumentMirror.safeParse(body).success, true);
  };
  const roomLink = await call(host.cookie, 'POST', '/api/links', { target: 'room', room_id: room });
  await document(roomLink.url, 200);
  await document((await call(host.cookie, 'POST', '/api/links', { target: 'connect' })).url, 200);
  await document(`/j/${'A'.repeat(43)}`, 404);

  // ROOMS.md §1 and §5: an AI-only workspace lacks rooms:host, refused before the tool runs.
  const ai = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Schema AI', idempotency_key: randomUUID() }),
    remoteAddress: '198.51.100.30',
  });
  assert.equal(ai.statusCode, 201, ai.body);
  const refused = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${ai.json().workspace_key as string}`,
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'city_create_room',
        arguments: { agent_id: randomUUID(), name: 'Not yet', idempotency_key: randomUUID() },
      },
    }),
  });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(String(refused.headers['www-authenticate']), /error="insufficient_scope"/);
  assert.match(String(refused.headers['www-authenticate']), /rooms:host/);
  assert.equal(refused.json().error, 'insufficient_scope');
});

test('valid fixtures of tools callable anonymously use keys the anonymous path accepts', async () => {
  for (const tool of ['city_create_agent', 'city_apply_team']) {
    const dir = join(CONFORMANCE_DIR, 'mcp', `${tool}.input`, 'valid');
    for (const name of await readdir(dir)) {
      const value = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
      for (const field of ['idempotency_key', 'idempotencyKey'])
        if (field in value)
          assert.equal(highEntropyKey(value[field]), true, `${tool}/valid/${name}: ${field}`);
    }
  }
});
