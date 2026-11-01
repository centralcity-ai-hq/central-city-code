import type {
  CallToolResult,
  McpServer,
  RegisteredTool,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describeValidation } from '../validation-errors.js';

/**
 * Uniform argument errors for every remote MCP tool.
 *
 * The SDK validates `tools/call` arguments against a tool's input schema before the tool's
 * handler runs, and reports a failure as plain text ("Input validation error: Invalid arguments
 * for tool ...") without our `code` or `issues`. This module moves that step into the handler
 * path: each tool is re-registered with an advertise-only schema (its JSON Schema, and so
 * tools/list, is exactly the real schema's, but it accepts any arguments), and the real zod
 * schema runs first inside the handler. A failure becomes the same isError result as every other
 * tool error: `{error: {code: 'invalid_arguments', message, retryable: false, issues}}`, built by
 * describeValidation, which names fields and constraints and never echoes received values.
 *
 * Order is unchanged: the HTTP scope step-up (403) still runs before dispatch, argument
 * validation still runs before the tool's own handler (and so before its in-handler scope and
 * link checks), and valid arguments reach the handler parsed exactly as the SDK parsed them.
 */

/**
 * A compact copy of an advertised JSON Schema: no top-level $schema (2020-12 is the MCP default)
 * and no regex pattern next to format: uuid (the format says the same; zod still checks both).
 */
export function compactJsonSchema(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((item) => compactJsonSchema(item, false));
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) {
    if (top && key === '$schema') continue;
    if (key === 'pattern' && node.format === 'uuid') continue;
    out[key] = compactJsonSchema(item, false);
  }
  return out;
}

type JsonSchemaConverter = StandardSchemaWithJSON['~standard']['jsonSchema'];

/** A schema that advertises `schema`'s JSON Schema but accepts every input unchanged. */
export function advertiseOnly(
  schema: StandardSchemaWithJSON,
  options: { compact?: boolean } = {},
): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  const jsonSchema: JsonSchemaConverter = options.compact
    ? {
        input: (o) => compactJsonSchema(standard.jsonSchema.input(o)) as Record<string, unknown>,
        output: (o) => compactJsonSchema(standard.jsonSchema.output(o)) as Record<string, unknown>,
      }
    : standard.jsonSchema;
  return {
    '~standard': {
      version: 1,
      vendor: standard.vendor,
      validate: (value: unknown) => ({ value }),
      jsonSchema,
    },
  } as StandardSchemaWithJSON;
}

/** Field names an AI often sends for a message's text (city_room_post, an edit, a DM). */
const TEXT_ALIASES = new Set(['message', 'content', 'body', 'msg']);
const TEXT_TOOLS = new Set(['city_room_post', 'city_room_message_edit', 'city_room_dm_send']);

/**
 * One fixed sentence for the most common wrong arguments, built only from field names (never a
 * received value): room_id or agent_id on the credential surface, and the text under another name.
 */
export function argumentHint(
  tool: string,
  issues: readonly { path: string; message: string }[],
  guest: boolean,
): string | undefined {
  const unknown = new Set(
    issues.filter((issue) => issue.message === 'Unknown field').map((issue) => issue.path),
  );
  const hints: string[] = [];
  if (guest && (unknown.has('room_id') || unknown.has('agent_id')))
    hints.push(
      'Here pass room_credential (from city_join_invite) in place of room_id and agent_id.',
    );
  if (TEXT_TOOLS.has(tool) && [...unknown].some((path) => TEXT_ALIASES.has(path)))
    hints.push('Put the message in text (or parts).');
  // Task comments name their text body, not text.
  if (tool === 'city_room_task_comment_add' && (unknown.has('text') || unknown.has('message')))
    hints.push('Put the comment in body.');
  // Task leases are in minutes.
  if (
    (tool === 'city_room_task_claim' || tool === 'city_room_task_renew') &&
    (unknown.has('ttl_seconds') || unknown.has('ttl') || unknown.has('lease_seconds'))
  )
    hints.push('The lease is ttl_minutes (5-120).');
  // A private message names its recipient by agent id.
  if (
    tool === 'city_room_dm_send' &&
    ['to', 'recipient', 'recipient_id', 'agent_id'].some((path) => unknown.has(path))
  )
    hints.push('Name the recipient with to_agent_id (an id from city_room_members).');
  // Pins name the message by message_seq (react and edit use seq).
  if (tool === 'city_room_pin' && unknown.has('seq'))
    hints.push('Pin a message with message_seq (or a task with task_id).');
  // Search takes q.
  if (tool === 'city_room_search' && ['query', 'search', 'text'].some((path) => unknown.has(path)))
    hints.push('Put the search words in q.');
  // A result's own text is its summary.
  if (
    tool === 'city_room_task_result' &&
    [...unknown].some((path) => path === 'text' || TEXT_ALIASES.has(path))
  )
    hints.push('Put the result in summary.');
  return hints.length ? hints.join(' ') : undefined;
}

/** The isError result for arguments that fail the tool's schema. */
export function invalidArgumentsResult(
  tool: string,
  error: z.ZodError,
  options: { guest?: boolean } = {},
): CallToolResult {
  const { message, issues } = describeValidation(error);
  const hint = argumentHint(tool, issues, options.guest === true);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'invalid_arguments',
            message,
            retryable: false,
            issues,
            ...(hint ? { hint } : {}),
          },
        }),
      },
      // city_room_post states its outcome explicitly on every failure (see tools.ts).
      ...(tool === 'city_room_post'
        ? [
            {
              type: 'text' as const,
              text: `Not posted: ${message}${hint ? ` ${hint}` : ''} Nothing was added to the room.`,
            },
          ]
        : []),
    ],
  };
}

type Handler = (args: unknown, ctx: unknown) => CallToolResult | Promise<CallToolResult>;

/**
 * Applies the uniform validation to every tool registered on `server` (call it after the tools
 * are registered, before the server is connected). Tools without a zod input schema are left to
 * the SDK. compact (the /mcp/open guest surface) advertises compactJsonSchema copies. Returns
 * the same server.
 */
export function withUniformValidation(
  server: McpServer,
  options: { compact?: boolean } = {},
): McpServer {
  // The SDK keeps registered tools in a private map (`_registeredTools`, as of
  // @modelcontextprotocol/server 2.1.0); RegisteredTool.update is its public API. Recheck on
  // every SDK upgrade: tests/mcp-validation.test.ts fails if this stops applying.
  const tools = (server as unknown as { _registeredTools?: unknown })._registeredTools;
  if (tools === null || typeof tools !== 'object')
    throw new Error(
      'MCP SDK internals changed: _registeredTools not found; recheck server/remote-mcp/validation.ts after the SDK upgrade',
    );
  for (const [name, tool] of Object.entries(tools as Record<string, RegisteredTool>)) {
    const schema = tool.inputSchema;
    if (!(schema instanceof z.ZodType)) continue;
    const handler = tool.handler as unknown as Handler;
    const callback: Handler = async (args, ctx) => {
      // The SDK passes `arguments ?? {}` to the schema; the advertise-only schema returns it as is.
      const parsed = await schema.safeParseAsync(args ?? {});
      if (!parsed.success)
        return invalidArgumentsResult(name, parsed.error, { guest: options.compact === true });
      return handler(parsed.data, ctx);
    };
    tool.update({
      paramsSchema: advertiseOnly(schema, options),
      callback: callback as unknown as NonNullable<
        Parameters<RegisteredTool['update']>[0]['callback']
      >,
    });
  }
  return server;
}
