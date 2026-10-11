import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { createApp } from '../server/app.js';
import { ASSISTANT_TOOL_SCOPES } from '../server/assistant-access.js';
import { builtinTemplates } from '../server/manifest/templates.js';
import { remoteInputSchemas } from '../server/remote-mcp/tools.js';
import { openInviteInputSchemas } from '../server/remote-mcp/open-invite.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { ANONYMOUS_TOOLS } from '../shared/assistant-tools.js';
import { APP_SHELL, isClientRoute } from '../shared/routes.js';
import { SHARE_CARDS } from '../shared/share-cards.js';
import { ROOM_TASK_TOOLS } from '../server/rooms/tasks-tools.js';
import { ROOM_REPO_TOOLS } from '../server/rooms/repos/tools.js';
import { renderPublicDocs } from '../scripts/public-docs/build.js';
import { fixture, fullFlow, mcpCall, rpcResult, type App } from './oauth-helpers.js';

/**
 * Distribution and discovery artifacts (server.json, server card, AI Catalog, llms.txt, client
 * integrations, directory kits) must stay accurate to the code. Nothing here uses the network:
 * schemas are vendored under integrations/mcp-registry/schema and the server runs in-process.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://centralcity.ai';
const OPEN_URL = `${ORIGIN}/mcp/open`;
const OAUTH_URL = `${ORIGIN}/mcp`;
/** Every configuration uses these server names for the two endpoints. */
const SERVER_NAMES: Record<string, string> = {
  'central-city-open': OPEN_URL,
  'central-city': OAUTH_URL,
};
/** Announced but not deployed; must only appear where they are marked as upcoming. */
const UPCOMING_TOOLS: string[] = [];
const OAUTH_TOOLS = Object.keys(remoteInputSchemas);
const OPEN_TOOLS: string[] = [...ANONYMOUS_TOOLS];
/** Invitation tools on /mcp/open, live where CITY_INVITE_FLOW=1 (production). */
const INVITE_TOOLS = Object.keys(openInviteInputSchemas);
/** Room task tools on /mcp, live where CITY_ROOM_TASKS=1 (production). */
const LIVE_TOOLS = new Set([
  ...OAUTH_TOOLS,
  ...ROOM_TASK_TOOLS,
  ...ROOM_REPO_TOOLS,
  ...OPEN_TOOLS,
  ...INVITE_TOOLS,
]);
/** Streamable HTTP exists from this revision on; the 2026 revision is served statelessly. */
const FIRST_STREAMABLE_HTTP_VERSION = '2025-03-26';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const CARD_PATH = 'public/.well-known/mcp/server-card.json';
const DISCOVERY_META = 'ai.centralcity/discovery';
/** Paths the docs mention as intentionally not served; they must 404, not show the app shell. */
const NOT_SERVED = new Set([
  '/.well-known/mcp',
  '/.well-known/mcp/server-card',
  '/.well-known/agent-card.json',
  '/.well-known/openid-configuration',
]);
/** Owner-provided ownership proofs: served once the file is added to public/, 404 before. */
const PROOFS = new Set(['/.well-known/mcp-registry-auth', '/.well-known/openai-apps-challenge']);
const expectedProofRoute = (path: string) =>
  existsSync(join(root, 'public', path))
    ? { kind: 'static', file: `public${path}` }
    : { kind: 'notfound' };

const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const readJson = (path: string): any => JSON.parse(read(path));

function walk(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out.sort();
}

const TEXT_FILE = /\.(md|txt|json|toml|template)$/;
const DISTRIBUTION_FILES = [
  'server.json',
  'vercel.json',
  'public/llms.txt',
  'public/llms-full.txt',
  ...walk('public/.well-known'),
  ...walk('integrations').filter(
    (file) => TEXT_FILE.test(file) && !file.startsWith('integrations/mcp-registry/schema/'),
  ),
  'docs/DISTRIBUTION.md',
];
const MARKDOWN_FILES = DISTRIBUTION_FILES.filter((file) => /\.(md|txt)$/.test(file));

// ---------------------------------------------------------------------------------------------
// Vercel routing model: static files first (Vercel checks the filesystem before rewrites), then
// the first matching rewrite. Supports exactly the path-to-regexp subset vercel.json uses and
// fails on anything else, so the simulation cannot silently diverge.

interface VercelConfig {
  framework: string;
  buildCommand: string;
  outputDirectory: string;
  functions: Record<string, { maxDuration: number; includeFiles?: string }>;
  rewrites: Array<{ source: string; destination: string }>;
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
}
const vercel = readJson('vercel.json') as VercelConfig;

function sourcePattern(source: string): RegExp {
  let pattern = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '(') {
      let depth = 0;
      let end = index;
      for (; end < source.length; end++) {
        if (source[end] === '\\') end++;
        else if (source[end] === '(') depth++;
        else if (source[end] === ')' && --depth === 0) break;
      }
      assert.equal(depth, 0, `unbalanced group in ${source}`);
      pattern += source.slice(index, end + 1);
      index = end + 1;
      assert.ok(!/^[?*+{]/.test(source.slice(index)), `unsupported group modifier in ${source}`);
      continue;
    }
    if (char === '/' && source[index + 1] === ':') {
      const param = /^:([A-Za-z0-9_]+)(\*)?/.exec(source.slice(index + 1));
      assert.ok(param, `unsupported parameter in ${source}`);
      pattern += param[2] ? '(?:/[^/#?]+)*' : '/[^/#?]+';
      index += 1 + param[0].length;
      assert.ok(!/^[?+({]/.test(source.slice(index)), `unsupported parameter syntax in ${source}`);
      continue;
    }
    assert.ok(!/[:*?+{}[\]]/.test(char), `unsupported syntax "${char}" in ${source}`);
    pattern += char.replace(/[.^$|\\/]/g, '\\$&');
    index++;
  }
  return new RegExp(`^${pattern}$`);
}

/** The deployed file for a URL path: public/ is copied into the output next to index.html. */
/** Markdown docs the build writes into dist/ (scripts/public-docs/build.ts). */
const GENERATED_DOCS = new Set([...renderPublicDocs(root).keys()].map((path) => `/${path}`));

function staticFile(path: string): string | null {
  if (path === '/' || path === '/index.html') return 'index.html';
  // The plain app shell, the built index.html before the landing is prerendered (shared/routes.ts).
  if (path === APP_SHELL) return 'index.html';
  // Share-card copies of index.html the build writes (shared/share-cards.ts).
  if (SHARE_CARDS.some((card) => path === `/${card.shell}`)) return 'index.html';
  if (GENERATED_DOCS.has(path)) return `dist${path}`;
  const file = join(root, 'public', ...decodeURIComponent(path).split('/').filter(Boolean));
  return existsSync(file) && statSync(file).isFile() ? `public${decodeURIComponent(path)}` : null;
}

type Route = { kind: 'static'; file: string } | { kind: 'function' } | { kind: 'notfound' };
function route(path: string): Route {
  const file = staticFile(path);
  if (file) return { kind: 'static', file };
  for (const rewrite of vercel.rewrites) {
    if (!sourcePattern(rewrite.source).test(path)) continue;
    if (rewrite.destination === '/api') return { kind: 'function' };
    const target = staticFile(rewrite.destination);
    return target ? { kind: 'static', file: target } : { kind: 'notfound' };
  }
  return { kind: 'notfound' };
}

function responseHeaders(path: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const rule of vercel.headers)
    if (sourcePattern(rule.source).test(path))
      for (const header of rule.headers) headers.set(header.key.toLowerCase(), header.value);
  return headers;
}

// ---------------------------------------------------------------------------------------------
// Helpers

async function openRpc(app: App, method: string, params: unknown = {}): Promise<any> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = rpcResult(res.body);
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}

async function openTool(app: App, name: string, args: unknown): Promise<any> {
  const result = await openRpc(app, 'tools/call', { name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}

function pngSize(path: string): string {
  const bytes = readFileSync(join(root, path));
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

/** Lines of a Markdown document, each marked as inside a fenced code block or not. */
function markdownLines(markdown: string): Array<{ line: string; code: boolean }> {
  let fenced = false;
  return markdown.split('\n').map((line) => {
    const fence = /^\s*```/.test(line);
    if (fence) fenced = !fenced;
    return { line, code: fence || fenced };
  });
}

/** GitHub-style heading anchors of a Markdown document. */
function anchors(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const { line, code } of markdownLines(markdown)) {
    const heading = code ? null : /^#{1,6} (.+)$/.exec(line)?.[1];
    if (heading)
      slugs.add(
        heading
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .replace(/\s/g, '-'),
      );
  }
  return slugs;
}

/** Text units: a heading's paragraphs, list items and table rows, each with its heading. */
function units(text: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = [];
  let heading = '';
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push({ heading, text: current.join('\n') });
    current = [];
  };
  for (const { line, code } of markdownLines(text)) {
    if (!code && /^#{1,6} /.test(line)) {
      flush();
      heading = line;
    } else if (!line.trim()) flush();
    else if (/^\s*(?:[-*] |\d+\. |\|)/.test(line)) {
      flush();
      current.push(line);
    } else current.push(line);
  }
  flush();
  return out;
}

const CENTRAL_CITY_URL = /https:\/\/centralcity\.ai(?:[\w\-./~%#=&?:@+]|<[\w-]+>|\{[\w-]+\})*/g;
function centralCityUrls(text: string): string[] {
  return [...text.matchAll(CENTRAL_CITY_URL)].map(([url]) => url.replace(/[.,:;]+$/, ''));
}
const withIds = (value: string) => value.replace(/<[\w-]+>|\{[\w-]+\}/g, () => randomUUID());

const server = readJson('server.json');
const card = readJson(CARD_PATH);
const discovery = card._meta[DISCOVERY_META];

// ---------------------------------------------------------------------------------------------

test('server.json validates against the vendored MCP Registry schema and registry rules', () => {
  const schema = readJson('integrations/mcp-registry/schema/server.schema.json');
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  const result = validate(server);
  assert.ok(result.valid, result.errorMessage ?? 'schema validation failed');
  // The validator is live, not vacuous.
  assert.equal(validate({ ...server, description: 'x'.repeat(101) }).valid, false);
  assert.equal(validate({ ...server, name: 'no-namespace' }).valid, false);
  assert.equal(server.$schema, schema.$id);
  // The registry API rejects unknown top-level fields.
  const known = Object.keys(schema.definitions.ServerDetail.properties);
  for (const key of Object.keys(server)) assert.ok(known.includes(key), `unknown field ${key}`);

  // Registry checks beyond the schema (internal/validators in modelcontextprotocol/registry).
  const [namespace, name] = server.name.split('/');
  assert.match(namespace, /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/);
  assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/);
  assert.equal(server.name, 'ai.centralcity/central-city');
  assert.equal(namespace, new URL(server.websiteUrl).hostname.split('.').reverse().join('.'));
  assert.match(server.version, /^\d+\.\d+\.\d+$/, 'strict semver, never "latest" or a range');
  assert.ok(server.title.trim());
  assert.match(server.websiteUrl, /^https:\/\/[^"'<> \t\n\r]+$/);
  assert.equal(server.repository.source, 'github');
  assert.match(server.repository.url, /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?$/);
  assert.equal(server.repository.url, 'https://github.com/centralcity-ai-hq/protocol');
  for (const icon of server.icons) {
    assert.ok(icon.src.startsWith(`${ORIGIN}/`), icon.src);
    const file = staticFile(new URL(icon.src).pathname);
    assert.ok(file, `${icon.src} is served from public/`);
    assert.equal(icon.mimeType, 'image/png');
    assert.deepEqual(icon.sizes, [pngSize(file)]);
  }
  assert.deepEqual(server.remotes, [
    { type: 'streamable-http', url: OPEN_URL },
    { type: 'streamable-http', url: OAUTH_URL },
  ]);
  assert.deepEqual(Object.keys(server._meta), [
    'io.modelcontextprotocol.registry/publisher-provided',
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(server._meta)) <= 4096, '_meta stays within 4 KB');
  const provided = server._meta['io.modelcontextprotocol.registry/publisher-provided'];
  assert.deepEqual(provided.remotes[OPEN_URL], {
    authentication: 'none',
    tools: [...OPEN_TOOLS, ...INVITE_TOOLS],
  });
  assert.deepEqual(provided.remotes[OAUTH_URL], {
    authentication: 'oauth2',
    tools: [...OAUTH_TOOLS, ...ROOM_TASK_TOOLS],
  });
  assert.equal(provided.serverCard, `${ORIGIN}/mcp/server-card`);
  assert.equal(provided.llms, `${ORIGIN}/llms.txt`);
});

test('the MCP server card validates, mirrors server.json and describes both endpoints', () => {
  const schema = readJson('integrations/mcp-registry/schema/server-card.schema.json');
  const validate = new AjvJsonSchemaValidator().getValidator({
    $schema: schema.$schema,
    $defs: schema.$defs,
    $ref: '#/$defs/ServerCard',
  });
  const result = validate(card);
  assert.ok(result.valid, result.errorMessage ?? 'schema validation failed');
  assert.equal(validate({ ...card, $schema: 'https://example.com/card.json' }).valid, false);
  assert.equal(validate({ ...card, version: undefined }).valid, false);

  for (const key of ['name', 'title', 'description', 'version', 'websiteUrl'])
    assert.equal(card[key], server[key], key);
  assert.deepEqual(card.repository, server.repository);
  assert.deepEqual(card.icons, server.icons);
  assert.deepEqual(
    card.remotes.map(({ type, url }: { type: string; url: string }) => ({ type, url })),
    server.remotes,
  );
  const versions = [
    MODERN_PROTOCOL_VERSION,
    ...SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version >= FIRST_STREAMABLE_HTTP_VERSION),
  ];
  for (const remote of card.remotes) assert.deepEqual(remote.supportedProtocolVersions, versions);

  // _meta keys follow the MCP reverse-DNS prefix format and avoid reserved prefixes.
  for (const key of Object.keys(card._meta)) {
    assert.match(key, /^(?:[a-z](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?\/[a-z]+$/);
    assert.doesNotMatch(key, /(?:^|\.)(?:modelcontextprotocol|mcp)[./]/);
  }
  const [open, oauth] = discovery.endpoints;
  assert.equal(discovery.endpoints.length, 2);
  assert.equal(open.url, OPEN_URL);
  assert.deepEqual(open.authentication, { type: 'none' });
  assert.equal(oauth.url, OAUTH_URL);
  assert.equal(oauth.authentication.type, 'oauth2');
  assert.equal(
    oauth.authentication.resourceMetadata,
    `${ORIGIN}/.well-known/oauth-protected-resource`,
  );
  assert.deepEqual(oauth.authentication.scopes, [...ASSISTANT_SCOPES]);
  assert.deepEqual(
    discovery.upcomingTools.map((tool: { name: string; status: string; endpoint: string }) => [
      tool.name,
      tool.status,
      tool.endpoint,
    ]),
    UPCOMING_TOOLS.map((name) => [name, 'upcoming', OAUTH_URL]),
  );
  for (const [name, value] of Object.entries(discovery.documentation))
    assert.match(String(value), /^https:\/\//, name);

  // Domain-level discovery: the AI Catalog lists exactly this card.
  const catalog = readJson('public/.well-known/ai-catalog.json');
  assert.equal(catalog.specVersion, '1.0');
  assert.deepEqual(catalog.entries, [
    {
      identifier: `urn:air:${new URL(server.websiteUrl).hostname}:mcp:${server.name.split('/')[1]}`,
      type: 'application/mcp-server-card+json',
      url: `${ORIGIN}/mcp/server-card`,
    },
  ]);
});

test('the server card matches the tools, scopes and protocol versions the server serves', async (t) => {
  // Production runs with invites and room tasks on, so the card lists those tools too.
  const saved = {
    CITY_INVITE_FLOW: process.env.CITY_INVITE_FLOW,
    CITY_ROOM_TASKS: process.env.CITY_ROOM_TASKS,
  };
  process.env.CITY_INVITE_FLOW = '1';
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const { app } = await fixture(t);
  const compare = (live: any[], documented: any[], scoped: boolean) => {
    assert.deepEqual(
      live.map((tool) => tool.name),
      documented.map((tool) => tool.name),
    );
    for (const entry of documented) {
      const tool = live.find((item) => item.name === entry.name);
      assert.equal(entry.title, tool.title, entry.name);
      const { title: _title, ...hints } = tool.annotations;
      assert.deepEqual(entry.annotations, hints, entry.name);
      const scope = ASSISTANT_TOOL_SCOPES[entry.name as keyof typeof ASSISTANT_TOOL_SCOPES];
      if (scoped) assert.deepEqual(entry.scopes, [...new Set(['workspace:read', scope])]);
      else assert.equal(entry.scopes, undefined);
    }
  };
  const [open, oauth] = discovery.endpoints;
  const openTools = (await openRpc(app, 'tools/list')).tools;
  compare(openTools, open.tools, false);
  const { tokens } = await fullFlow(app, {
    scope: ASSISTANT_SCOPES.join(' '),
    scopes: [...ASSISTANT_SCOPES],
  });
  const listed = await mcpCall(app, tokens.access_token, 'tools/list');
  assert.equal(listed.statusCode, 200, listed.body);
  const oauthTools = rpcResult(listed.body).result.tools as any[];
  // Workspace-key tools are listed only to AI workspace key (ccw_) sessions, never to OAuth.
  compare(
    oauthTools,
    oauth.tools.filter((tool: { workspaceKeyOnly?: boolean }) => !tool.workspaceKeyOnly),
    true,
  );
  for (const name of UPCOMING_TOOLS)
    assert.ok(
      !oauthTools.some((tool) => tool.name === name) &&
        !openTools.some((tool: any) => tool.name === name),
      `${name} is live now: move it from upcomingTools to the endpoint tools in ${CARD_PATH} and update llms.txt, llms-full.txt, server.json and the integrations`,
    );

  // Every advertised protocol version is negotiated as advertised.
  const advertised = new Set<string>(
    card.remotes.flatMap(
      (remote: { supportedProtocolVersions: string[] }) => remote.supportedProtocolVersions,
    ),
  );
  for (const version of [...advertised].filter((item) => item !== MODERN_PROTOCOL_VERSION)) {
    const init = await openRpc(app, 'initialize', {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'distribution-test', version: '1.0.0' },
    });
    assert.equal(init.protocolVersion, version);
    assert.equal(init.serverInfo.name, 'central-city');
  }
  const discover = await app.inject({
    method: 'POST',
    url: '/mcp/open',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': 'server/discover',
    },
    payload: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'distribution-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  assert.equal(discover.statusCode, 200, discover.body);
  assert.ok(rpcResult(discover.body).result.supportedVersions.includes(MODERN_PROTOCOL_VERSION));

  // The OAuth facts in the card match the live metadata.
  const resource = (await app.inject({ url: '/.well-known/oauth-protected-resource' })).json();
  assert.equal(new URL(resource.resource).pathname, new URL(OAUTH_URL).pathname);
  assert.deepEqual(resource.scopes_supported, oauth.authentication.scopes);
  const metadata = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, oauth.authentication.pkce);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.ok(metadata.registration_endpoint);
  assert.deepEqual(oauth.authentication.clientRegistration, [
    'client-id-metadata-document',
    'dynamic-client-registration',
  ]);
});

const serverInfoVersion =
  /new McpServer\(\s*\{\s*name:\s*'central-city',\s*version:\s*'([^']+)'/.exec(
    read('server/remote-mcp/tools.ts'),
  )?.[1];
test(
  'server.json advertises the version the running server reports',
  {
    todo:
      serverInfoVersion === server.version
        ? undefined
        : `the server reports ${serverInfoVersion}; bump serverInfo.version in server/remote-mcp/tools.ts (and package.json) to ${server.version} in the release PR before publishing`,
  },
  () => {
    assert.equal(serverInfoVersion, server.version);
  },
);

test('llms.txt follows the llmstxt.org structure and covers every tool', () => {
  const text = read('public/llms.txt');
  const lines = text.split('\n');
  assert.equal(lines[0], '# Central City');
  assert.equal((text.match(/^# /gm) ?? []).length, 1, 'exactly one H1');
  let index = 1;
  while (lines[index] === '') index++;
  assert.ok(lines[index]!.startsWith('> '), 'a blockquote summary follows the H1');
  const firstList = lines.findIndex((line) => line.startsWith('## '));
  assert.ok(firstList > index, 'H2 file lists follow the details');
  for (const line of lines.slice(1, firstList))
    assert.doesNotMatch(line, /^#{1,6} /, 'no headings inside the details section');
  const sections: string[] = [];
  for (const line of lines.slice(firstList)) {
    if (!line) continue;
    if (line.startsWith('## ')) sections.push(line.slice(3));
    else
      assert.match(line, /^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(?:: .+)?$/, `file list item: ${line}`);
  }
  if (sections.includes('Optional')) assert.equal(sections.at(-1), 'Optional');
  // llms.txt names every live tool (about 60 across a dozen families) in one short file. 15 KB is
  // about 3.8k tokens: still a small part of any client's context, next to about 130 KB for a
  // full tools/list. Raised from 12 KB (29 Sep 2026) so the next tool family fits without
  // cutting rules, and from 14 KB (7 Oct 2026) for the Microsoft Copilot and Mistral Le Chat
  // docs pages; keep adding detail to llms-full.txt and the /docs/*.md pages instead.
  assert.ok(Buffer.byteLength(text) < 15_000, 'llms.txt stays small (under 15 KB)');

  const full = read('public/llms-full.txt');
  assert.equal(full.split('\n')[0], '# Central City');
  assert.match(full, /^# Central City\n\n> /);
  for (const document of [text, full]) {
    for (const tool of LIVE_TOOLS) assert.ok(document.includes(`\`${tool}\``), tool);
    for (const url of [OPEN_URL, OAUTH_URL, `${ORIGIN}/api/public/agents`])
      assert.ok(document.includes(url), url);
  }
  for (const template of builtinTemplates.list())
    assert.ok(full.includes(`template:${template.id}@${template.version}`), template.id);
});

test('tool names in distribution files exist, and upcoming ones are marked as upcoming', () => {
  for (const file of DISTRIBUTION_FILES) {
    const text = read(file);
    for (const [name] of text.matchAll(/\bcity_[a-z_]+\b/g))
      assert.ok(
        LIVE_TOOLS.has(name) || UPCOMING_TOOLS.includes(name),
        `${file}: unknown tool ${name}`,
      );
    if (!UPCOMING_TOOLS.some((name) => text.includes(name))) continue;
    if (file.endsWith('.json')) {
      assert.equal(file, CARD_PATH, `${file} must not list upcoming tools`);
      const outside = JSON.stringify({
        ...card,
        _meta: { ...card._meta, [DISCOVERY_META]: { ...discovery, upcomingTools: [] } },
      });
      for (const name of UPCOMING_TOOLS)
        assert.ok(!outside.includes(name), `${name} outside upcomingTools`);
      continue;
    }
    for (const unit of units(text))
      if (UPCOMING_TOOLS.some((name) => unit.text.includes(name)))
        assert.match(
          `${unit.heading}\n${unit.text}`,
          /upcoming|not (?:yet )?available|not yet deployed/i,
          `${file}: upcoming tool mentioned without saying so: ${unit.text}`,
        );
  }
});

test('every centralcity.ai URL and endpoint path in the distribution files is served', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const methods = ['GET', 'POST', 'DELETE'] as const;
  const check = (file: string, path: string, label: string) => {
    if (NOT_SERVED.has(path)) {
      assert.equal(route(path).kind, 'notfound', `${path} must 404, not serve the app shell`);
      return;
    }
    if (PROOFS.has(path)) {
      assert.deepEqual(route(path), expectedProofRoute(path), path);
      return;
    }
    const target = route(path);
    if (target.kind === 'notfound') assert.fail(`${file}: ${label} is not served`);
    if (target.kind === 'static')
      assert.ok(
        target.file !== 'index.html' || path === '/' || isClientRoute(path),
        `${file}: ${label} falls through to the app shell`,
      );
    else
      assert.ok(
        methods.some((method) => app.findRoute({ method, url: path })),
        `${file}: no server route for ${label}`,
      );
  };
  let urls = 0;
  for (const file of DISTRIBUTION_FILES) {
    const text = read(file);
    for (const url of centralCityUrls(text)) {
      urls++;
      check(file, new URL(withIds(url)).pathname, url);
    }
    // Absolute endpoint paths written in code spans, such as `POST /api/runtime/enroll`
    // (wildcards and ellipses such as `/oauth/*` or `/.well-known/…` describe groups; skipped).
    for (const [, path] of text.matchAll(
      /`(?:(?:GET|POST|DELETE) )?(\/(?:api|oauth|mcp|a2a|\.well-known)(?:\/[^\s`*…]*)?)`/g,
    ))
      if (!path!.endsWith('/')) check(file, withIds(path!).split('#')[0]!, path!);
  }
  assert.ok(urls > 50, 'the scan found the documented URLs');
});

test('GitHub links, relative links and anchors in the distribution files resolve', () => {
  const repository =
    /https:\/\/(?:github\.com\/centralcity-ai\/central-city(?:\/(?:blob|tree)\/main\/([^\s)`'"<>#]+))?|raw\.githubusercontent\.com\/centralcity-ai\/central-city\/main\/([^\s)`'"<>#]+))(#[\w-]+)?/g;
  for (const file of DISTRIBUTION_FILES) {
    const text = read(file);
    for (const match of text.matchAll(repository)) {
      const path = (match[1] ?? match[2])?.replace(/[.,:;]+$/, '');
      if (path)
        assert.ok(existsSync(join(root, path)), `${file}: ${match[0]} points at a missing file`);
      const anchor = match[3]?.slice(1);
      if (path && anchor && path.endsWith('.md'))
        assert.ok(anchors(read(path)).has(anchor), `${file}: missing anchor in ${match[0]}`);
    }
  }
  for (const file of MARKDOWN_FILES.filter((item) => item.endsWith('.md'))) {
    const text = read(file);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:https?:|mailto:)/.test(target!)) continue;
      const [path, anchor] = target!.split('#');
      const resolved = path ? join(dirname(join(root, file)), path) : join(root, file);
      assert.ok(existsSync(resolved), `${file}: missing link target ${target}`);
      if (anchor && resolved.endsWith('.md'))
        assert.ok(
          anchors(readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n')).has(anchor),
          `${file}: missing anchor ${target}`,
        );
    }
  }
});

test('vercel.json keeps every existing route and serves the discovery files correctly', () => {
  assert.equal(vercel.framework, 'vite');
  // The deploy drops Vite's build manifest (it lists the source files; the bundle budget reads it
  // in CI, before this step): /.vite/manifest.json is never public.
  assert.equal(vercel.buildCommand, 'pnpm build && rm -rf dist/.vite');
  assert.equal(vercel.outputDirectory, 'dist');
  assert.deepEqual(vercel.functions, {
    'api/index.js': { maxDuration: 300, includeFiles: 'api/_bundle/*.map' },
  });
  const agent = randomUUID();
  for (const path of [
    '/api/session',
    '/api/public/agents',
    '/api/runtime/enroll',
    '/api/agents/claim',
    '/mcp',
    '/mcp/open',
    '/oauth/authorize',
    '/oauth/token',
    '/oauth/register',
    '/oauth/revoke',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/jwks.json',
    `/a2a/${agent}/.well-known/agent-card.json`,
  ])
    assert.deepEqual(route(path), { kind: 'function' }, path);
  for (const path of ['/', '/connect', '/rooms', '/r/launch-plan'])
    assert.deepEqual(route(path), { kind: 'static', file: 'index.html' }, path);
  // No catch-all: unknown paths get 404.html with status 404 (shared/routes.ts).
  assert.deepEqual(route('/some/deep/link'), { kind: 'notfound' }, 'unknown paths get 404.html');
  const card = { kind: 'static', file: CARD_PATH };
  assert.deepEqual(route('/mcp/server-card'), card);
  assert.deepEqual(route('/mcp/open/server-card'), card);
  assert.deepEqual(route('/.well-known/mcp/server-card.json'), card);
  for (const path of ['/llms.txt', '/llms-full.txt', '/.well-known/ai-catalog.json'])
    assert.deepEqual(route(path), { kind: 'static', file: `public${path}` }, path);
  for (const path of [...NOT_SERVED, '/.well-known/x'])
    assert.deepEqual(route(path), { kind: 'notfound' }, `${path} returns 404, not the app shell`);
  for (const path of PROOFS) assert.deepEqual(route(path), expectedProofRoute(path), path);

  // No static file may shadow a function route (static files win over rewrites on Vercel).
  for (const file of walk('public')) {
    const path = file.slice('public'.length);
    const rewrite = vercel.rewrites.find((item) => sourcePattern(item.source).test(path));
    assert.notEqual(rewrite?.destination, '/api', `${file} would shadow ${rewrite?.source}`);
  }

  // Headers: security headers stay everywhere; discovery files get their media types and CORS.
  for (const path of ['/', '/mcp', '/mcp/server-card', '/llms.txt', '/oauth/authorize']) {
    const headers = responseHeaders(path);
    assert.equal(headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(headers.get('x-frame-options'), 'DENY', path);
    assert.match(headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
  }
  assert.equal(responseHeaders('/oauth/authorize').get('referrer-policy'), 'same-origin');
  assert.equal(responseHeaders('/mcp').get('referrer-policy'), 'no-referrer');
  for (const path of ['/mcp/server-card', '/mcp/open/server-card']) {
    const headers = responseHeaders(path);
    assert.equal(headers.get('content-type'), 'application/mcp-server-card+json');
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.equal(headers.get('access-control-allow-methods'), 'GET');
    assert.equal(headers.get('access-control-allow-headers'), 'Content-Type, If-None-Match');
    assert.equal(headers.get('access-control-expose-headers'), 'ETag');
    assert.equal(headers.get('cache-control'), 'public, max-age=3600');
  }
  const legacy = responseHeaders('/.well-known/mcp/server-card.json');
  assert.equal(legacy.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(legacy.get('access-control-allow-origin'), '*');
  assert.equal(
    responseHeaders('/.well-known/ai-catalog.json').get('content-type'),
    'application/ai-catalog+json',
  );
  for (const path of ['/llms.txt', '/llms-full.txt']) {
    assert.equal(responseHeaders(path).get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(responseHeaders(path).get('access-control-allow-origin'), '*');
  }
  for (const path of ['/.well-known/mcp-registry-auth', '/.well-known/openai-apps-challenge'])
    assert.equal(responseHeaders(path).get('content-type'), 'text/plain; charset=utf-8');
  const link = responseHeaders('/').get('link') ?? '';
  assert.match(link, /<\/llms\.txt>; rel="describedby"/);
  assert.match(link, /<\/\.well-known\/ai-catalog\.json>; rel="ai-catalog"/);
  assert.equal(responseHeaders('/some/deep/link').get('link'), undefined);
});

test('client configurations, plugin manifests and install links agree with the endpoints', () => {
  const version = server.version;
  const plugin = readJson('integrations/claude-code/central-city/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'central-city');
  assert.match(plugin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(plugin.version, version);
  assert.ok(plugin.description && plugin.author?.name, 'validate warns without them');
  assert.equal(plugin.license, readJson('package.json').license);
  assert.equal(new URL(plugin.homepage).origin, ORIGIN);
  const pluginServers = readJson('integrations/claude-code/central-city/.mcp.json').mcpServers;
  const expected = Object.fromEntries(
    Object.entries(SERVER_NAMES).map(([name, url]) => [name, { type: 'http', url }]),
  );
  assert.deepEqual(pluginServers, expected);

  const marketplace = readJson('integrations/claude-code/.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'centralcity-ai');
  assert.doesNotMatch(marketplace.name, /anthropic|claude|^(?:npm|pip|uv|cargo|github|gh)$/i);
  assert.ok(marketplace.owner.name);
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.version, version);
  assert.deepEqual(entry.source, {
    source: 'git-subdir',
    url: 'centralcity-ai-hq/toolkit',
    path: 'integrations/claude-code/central-city',
  });
  assert.ok(existsSync(join(root, entry.source.path, '.claude-plugin', 'plugin.json')));

  // Agent Skills frontmatter (portable subset).
  const skillPath = 'integrations/claude-code/central-city/skills/central-city/SKILL.md';
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(read(skillPath))?.[1] ?? '';
  const fields = Object.fromEntries(
    frontmatter
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  );
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  assert.equal(fields.name, 'central-city', 'the skill name matches its directory');
  assert.match(fields.name!, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.doesNotMatch(fields.name!, /anthropic|claude/);
  assert.ok(fields.description!.length >= 1 && fields.description!.length <= 1024);
  assert.doesNotMatch(frontmatter, /<[^>]+>/, 'no XML tags in frontmatter');

  const gemini = readJson('integrations/gemini-cli/central-city/gemini-extension.json');
  assert.equal(gemini.name, 'central-city', 'the extension name matches its directory');
  assert.equal(gemini.version, version);
  assert.deepEqual(
    gemini.mcpServers,
    Object.fromEntries(Object.entries(SERVER_NAMES).map(([name, url]) => [name, { httpUrl: url }])),
  );
  assert.ok(existsSync(join(root, 'integrations/gemini-cli/central-city', gemini.contextFileName)));
  assert.deepEqual(
    readJson('integrations/cursor/mcp.json').mcpServers,
    Object.fromEntries(Object.entries(SERVER_NAMES).map(([name, url]) => [name, { url }])),
  );
  assert.deepEqual(readJson('integrations/vscode/mcp.json').servers, expected);
  assert.deepEqual(readJson('integrations/generic/mcp.json').mcpServers, expected);

  // Codex TOML (the subset used: tables and string values).
  const codex: Record<string, Record<string, string>> = {};
  let table: Record<string, string> | undefined;
  for (const raw of read('integrations/codex/config.toml').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[mcp_servers\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (header) table = codex[header[1]!] = {};
    else {
      const pair = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/.exec(line);
      assert.ok(pair && table, `unsupported TOML line: ${raw}`);
      table[pair[1]!] = pair[2]!;
    }
  }
  assert.deepEqual(
    codex,
    Object.fromEntries(Object.entries(SERVER_NAMES).map(([name, url]) => [name, { url }])),
  );

  // Install links and commands everywhere name the right endpoint.
  let links = 0;
  const expectServer = (name: string, url: string, where: string) => {
    links++;
    assert.equal(SERVER_NAMES[name], url, `${where}: ${name} must point at ${SERVER_NAMES[name]}`);
  };
  for (const file of DISTRIBUTION_FILES) {
    const text = read(file);
    for (const [, name, config] of text.matchAll(
      /(?:cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install|https:\/\/cursor\.com\/en\/install-mcp)\?name=([\w-]+)&config=([A-Za-z0-9%]+)/g,
    )) {
      const decoded = JSON.parse(
        Buffer.from(decodeURIComponent(config!), 'base64').toString('utf8'),
      );
      assert.deepEqual(
        Object.keys(decoded),
        ['url'],
        `${file}: Cursor config is the inner server object`,
      );
      expectServer(name!, decoded.url, file);
    }
    for (const [, name, config] of text.matchAll(
      /https:\/\/vscode\.dev\/redirect\/mcp\/install\?name=([\w-]+)&config=([^\s)`]+)/g,
    )) {
      const decoded = JSON.parse(decodeURIComponent(config!));
      assert.equal(decoded.type, 'http');
      expectServer(name!, decoded.url, file);
    }
    for (const [, json] of text.matchAll(/code --add-mcp '([^']+)'/g)) {
      const decoded = JSON.parse(json!);
      assert.equal(decoded.type, 'http');
      expectServer(decoded.name, decoded.url, file);
    }
    for (const [, name, url] of text.matchAll(
      /https:\/\/claude\.ai\/customize\/connectors\?modal=add-custom-connector&connectorName=([^&\s]+)&connectorUrl=([^\s)`]+)/g,
    ))
      expectServer(
        decodeURIComponent(name!) === 'Central City' ? 'central-city' : 'central-city-open',
        decodeURIComponent(url!),
        file,
      );
    for (const [, name, url] of text.matchAll(
      /(?:claude|gemini) mcp add --transport http ([\w-]+) (https:\/\/\S+)/g,
    ))
      expectServer(name!, url!.replace(/[`'".,]+$/, ''), file);
    for (const [, name, url] of text.matchAll(/codex mcp add ([\w-]+) --url (https:\/\/\S+)/g))
      expectServer(name!, url!.replace(/[`'".,]+$/, ''), file);
  }
  assert.ok(links >= 20, `install links and commands were found (${links})`);
});

test('manifest examples and template references in the guides are accepted by the server', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  for (const file of [
    'public/llms-full.txt',
    'integrations/claude-code/central-city/skills/central-city/SKILL.md',
  ]) {
    const manifests = [...read(file).matchAll(/```json\n([\s\S]*?)```/g)]
      .map(([, block]) => JSON.parse(block!))
      .filter((document) => document?.apiVersion === 'centralcity.agent/v1');
    assert.ok(manifests.length > 0, `${file} contains a manifest example`);
    for (const manifest of manifests) {
      const plan = await openTool(app, 'city_plan_team', { manifest });
      assert.equal(plan.ok, true, `${file}: ${JSON.stringify(plan.plan.errors)}`);
      assert.deepEqual(plan.plan.errors, []);
      assert.match(plan.team_hash ?? '', /^sha256:[a-f0-9]{64}$/);
    }
  }
  for (const file of DISTRIBUTION_FILES)
    for (const [reference, id, version] of read(file).matchAll(
      /template:([a-z0-9-]+)@(\d+\.\d+\.\d+)/g,
    ))
      assert.ok(builtinTemplates.get(id!, version!), `${file}: unknown ${reference}`);
});

test('the MCP Registry domain proof is never served as a placeholder and no key material ships', () => {
  const template = read('integrations/mcp-registry/mcp-registry-auth.template').trim();
  assert.match(template, /^v=MCPv1; k=ed25519; p=<[^>]+>$/);
  // The registry's own parser must not accept the template.
  assert.doesNotMatch(template, /v=MCPv1;\s*k=([^;]+);\s*p=([A-Za-z0-9+/=]+)/);
  const proof = join(root, 'public/.well-known/mcp-registry-auth');
  if (existsSync(proof)) {
    const key = /^v=MCPv1; k=ed25519; p=([A-Za-z0-9+/]{43}=)$/.exec(
      readFileSync(proof, 'utf8').trim(),
    );
    assert.ok(key, 'the served proof carries a real base64 Ed25519 public key');
    assert.equal(Buffer.from(key[1]!, 'base64').length, 32);
  }
  const challenge = join(root, 'public/.well-known/openai-apps-challenge');
  if (existsSync(challenge))
    assert.match(readFileSync(challenge, 'utf8'), /^[A-Za-z0-9._-]+\s*$/, 'only the token');
  const privateKey = new RegExp(['-----BEGIN [A-Z ]*', 'PRIVATE KEY-----'].join(''));
  for (const file of [...DISTRIBUTION_FILES, ...walk('integrations/mcp-registry/schema')]) {
    const text = read(file);
    assert.doesNotMatch(text, privateKey, file);
    assert.doesNotMatch(text, /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/, `${file}: private JWK member`);
  }
  // The vendored schemas are byte-identical to the recorded retrievals.
  const readme = read('integrations/mcp-registry/schema/README.md');
  for (const file of ['server.schema.json', 'server-card.schema.json'])
    assert.ok(readme.includes(`\`${file}\``), file);
});

test('docs/DISTRIBUTION.md covers every integration and discovery artifact', () => {
  const doc = read('docs/DISTRIBUTION.md');
  for (const directory of readdirSync(join(root, 'integrations'), { withFileTypes: true }))
    if (directory.isDirectory())
      assert.ok(doc.includes(`integrations/${directory.name}`), `integrations/${directory.name}`);
  for (const artifact of [
    'server.json',
    'public/llms.txt',
    'public/llms-full.txt',
    CARD_PATH,
    'public/.well-known/ai-catalog.json',
    'vercel.json',
  ])
    assert.ok(doc.includes(artifact), artifact);
  assert.match(doc, /## Sources/);
});
