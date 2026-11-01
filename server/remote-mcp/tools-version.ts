import { createHash } from 'node:crypto';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

/**
 * "New tools: reconnect" hint.
 *
 * /mcp and /mcp/open are stateless Streamable HTTP: no MCP session outlives a request, so there is
 * no session to remember which tool list a client loaded, and no open stream on which a
 * notifications/tools/list_changed could reach a client that connected before a deploy (the old
 * process, and any stream it held, is gone). What the server can see is a stale client's symptom:
 * a call to a tool it does not have, or an argument its schema no longer knows. Those answers keep
 * their content and gain one extra field (and, for tool results, one extra text line) saying to
 * reconnect. tools/list advertises the version under _meta so a client or a person can compare.
 */
export const RECONNECT_HINT =
  'Central City updated its tools; reconnect the connector (or start a new chat) to load them.';
export const TOOLS_VERSION_META_KEY = 'ai.centralcity/tools_version';

/** A short, stable hash of tool names plus their advertised input JSON Schemas. */
export function toolsVersion(tools: Iterable<readonly [string, unknown]>): string {
  const entries = [...tools].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/** One version per tool surface (the set of names), computed once per process. */
const cache = new Map<string, string>();

function inputJsonSchema(tool: RegisteredTool): unknown {
  const standard = (tool.inputSchema as { '~standard'?: { jsonSchema?: { input?: unknown } } })?.[
    '~standard'
  ];
  const input = standard?.jsonSchema?.input;
  if (typeof input !== 'function') return null;
  try {
    return (input as (o: { target: string }) => unknown)({ target: 'draft-2020-12' });
  } catch {
    return null;
  }
}

type Handler = (...args: unknown[]) => Promise<unknown>;
type ToolCallResult = { isError?: boolean; content?: { type: string; text?: string }[] };

/** Adds `reconnect_hint` (and the extra line) to an invalid_arguments result with an unknown field. */
export function withReconnectHint(result: unknown, version: string): unknown {
  const call = result as ToolCallResult | undefined;
  const first = call?.isError ? call.content?.[0] : undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string') return result;
  let body: { error?: Record<string, unknown> };
  try {
    body = JSON.parse(first.text) as typeof body;
  } catch {
    return result;
  }
  const error = body?.error;
  if (!error || error.code !== 'invalid_arguments' || error.hint !== undefined) return result;
  const issues = Array.isArray(error.issues) ? (error.issues as { message?: unknown }[]) : [];
  if (!issues.some((issue) => issue?.message === 'Unknown field')) return result;
  return {
    ...call,
    content: [
      {
        ...first,
        text: JSON.stringify({
          ...body,
          error: { ...error, reconnect_hint: RECONNECT_HINT, tools_version: version },
        }),
      },
      ...call!.content!.slice(1),
      { type: 'text', text: RECONNECT_HINT },
    ],
  };
}

/**
 * Stamps the tools version on tools/list and adds the reconnect hint to stale-client answers on
 * tools/call. Call after every tool is registered (and after withUniformValidation).
 */
export function withToolsVersion(server: McpServer): McpServer {
  // Same SDK internals as validation.ts and shapeToolsList (tools.ts); tests fail if they move.
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredTool> })
    ._registeredTools;
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!tools || typeof tools !== 'object' || !(handlers instanceof Map))
    throw new Error(
      'MCP SDK internals changed: recheck server/remote-mcp/tools-version.ts after the SDK upgrade',
    );
  const names = Object.keys(tools).sort();
  const surface = names.join(',');
  let version = cache.get(surface);
  if (!version) {
    version = toolsVersion(names.map((name) => [name, inputJsonSchema(tools[name]!)] as const));
    cache.set(surface, version);
  }
  const map = handlers as Map<string, Handler>;
  const list = map.get('tools/list');
  const call = map.get('tools/call');
  if (typeof list === 'function')
    map.set('tools/list', async (...args) => {
      const result = (await list(...args)) as { _meta?: Record<string, unknown> } | undefined;
      return result && typeof result === 'object'
        ? { ...result, _meta: { ...result._meta, [TOOLS_VERSION_META_KEY]: version } }
        : result;
    });
  if (typeof call === 'function')
    map.set('tools/call', async (...args) => {
      const name = (args[0] as { params?: { name?: unknown } } | undefined)?.params?.name;
      if (typeof name === 'string' && !Object.hasOwn(tools, name))
        // The SDK's own "not found" error, with the hint appended and as data.
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${name} not found. ${RECONNECT_HINT}`,
          { reconnect_hint: RECONNECT_HINT, tools_version: version },
        );
      return withReconnectHint(await call(...args), version!);
    });
  return server;
}
