/**
 * Exports standalone JSON Schema (draft 2020-12) files for the public Central City protocol from
 * the zod sources, into protocol/schemas/. Run `tsx scripts/export-protocol-schemas.ts` to write
 * them, or add `--check` to exit non-zero when the committed files differ from the sources.
 * tests/protocol-schemas.test.ts runs the same comparison.
 *
 * Wire shapes that have no zod source yet (delivered messages, inbox pages, the A2A request and
 * task, the /j join document) are described by the mirror schemas below. The test pins them to
 * the TypeScript types (compile-time equality), to the real parser (identical verdicts on every
 * fixture) or to live responses of an in-memory server. Room responses come from the zod output
 * schemas of the MCP tools, pinned to the service's TypeScript types.
 *
 * JSON Schema cannot express every zod rule (custom refinements such as the public-host check,
 * uniqueness by key or byte budgets). Each schema lists those rules in `$comment`, and the
 * conformance fixtures under protocol/conformance/<schema>/semantic/ document them.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { z } from 'zod';
import { MANIFEST_LIMITS, agentManifestSchema, teamManifestSchema } from '../shared/manifest.js';
import {
  MESSAGE_LIMITS,
  ackInboxToolInput,
  contextIdSchema,
  messagePartSchema,
  readInboxToolInput,
  sendBodySchema,
  sendMessageToolInput,
} from '../server/messaging/contract.js';
import {
  applyTeamToolInput,
  controlToolInput,
  createAgentToolInput,
  listTemplatesToolInput,
  planTeamToolInput,
} from '../shared/assistant-tools.js';
import { A2A_LIMITS } from '../protocol/a2a.js';
import {
  createRoomToolInput,
  joinRoomToolInput,
  roomCloseToolInput,
  roomLeaveToolInput,
  roomSearchToolInput,
  roomOverviewToolInput,
  roomUpdateToolInput,
  roomLinkToolInput,
  roomMembersToolInput,
  roomPostBody,
  roomPostToolInput,
  roomReadToolInput,
  roomRefSchema,
  roomRemoveToolInput,
} from '../server/rooms/contract.js';
import { JOIN_LINK_LIMITS, createJoinLinkBody } from '../server/links/service.js';
import {
  askToolInput,
  publishResultToolInput,
  reportReuseToolInput,
  unpublishResultToolInput,
} from '../server/results/contract.js';
import { WAKE_TOOLS, roomReadWaitToolInput, wakeInputSchemas } from '../server/wake/contract.js';
import {
  openInviteInputSchemas,
  openInviteJoinOutput,
  openInviteRenewOutput,
} from '../server/remote-mcp/open-invite.js';
import { remoteOutputSchemas } from '../server/remote-mcp/tools.js';

export const SCHEMA_BASE = 'https://centralcity.ai/schemas/';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = join(ROOT, 'protocol', 'schemas');

// ---------------------------------------------------------------------------------------------
// Mirror schemas for wire shapes without a zod source (pinned by the test).

/** A delivered message (`AgentMessage` in server/messaging/contract.ts). Responses may add fields. */
export const agentMessageMirror = z.object({
  origin: z.enum(['internal', 'external']),
  from_owner_label: z.string().nullable(),
  id: z.string().uuid(),
  seq: z.number().int().min(1),
  kind: z.literal('message'),
  from_agent_id: z.string().uuid(),
  from_agent_name: z.string(),
  to_agent_id: z.string().uuid(),
  to_agent_name: z.string(),
  context_id: contextIdSchema,
  reply_to: z.string().uuid().nullable(),
  parts: z.array(messagePartSchema),
  created_at: z.iso.datetime(),
  room_id: z.string().nullable().optional(),
});
/** One inbox page (`InboxPage` in server/messaging/contract.ts). */
export const inboxPageMirror = z.object({
  agent_id: z.string().uuid(),
  messages: z.array(agentMessageMirror),
  latest_seq: z.number().int().min(0),
  acked_seq: z.number().int().min(0),
  unread: z.number().int().min(0),
  next_since: z.number().int().min(0),
  has_more: z.boolean(),
});

const a2aIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const a2aRpcId = z.union([a2aIdentifier, z.number().int().safe()]);
const a2aEnvelope = { jsonrpc: z.literal('2.0'), id: a2aRpcId };
/** The A2A JSON-RPC requests that protocol/a2a.ts maps (`parseA2AIntent`), wire version 1.0. */
export const a2aRequestMirror = z.discriminatedUnion('method', [
  z
    .object({
      ...a2aEnvelope,
      method: z.literal('SendMessage'),
      params: z
        .object({
          message: z
            .object({
              messageId: a2aIdentifier,
              role: z.literal('ROLE_USER'),
              parts: z.tuple([
                z
                  .object({
                    text: z
                      .string()
                      .min(1)
                      .max(A2A_LIMITS.inputCharacters)
                      .regex(/\S/, 'Text must not be blank.'),
                    mediaType: z.literal('text/plain').optional(),
                  })
                  .strict(),
              ]),
            })
            .strict(),
          configuration: z
            .object({
              returnImmediately: z.literal(true),
              historyLength: z.literal(0).optional(),
              acceptedOutputModes: z.tuple([z.literal('application/json')]).optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...a2aEnvelope,
      method: z.literal('GetTask'),
      params: z.object({ id: a2aIdentifier, historyLength: z.literal(0).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...a2aEnvelope,
      method: z.literal('CancelTask'),
      params: z.object({ id: a2aIdentifier }).strict(),
    })
    .strict(),
]);
/** The A2A task that protocol/a2a.ts projects (`A2ATask`). Responses may add fields. */
export const a2aTaskMirror = z.object({
  id: z.string(),
  contextId: z.string(),
  status: z.object({
    state: z.enum([
      'TASK_STATE_SUBMITTED',
      'TASK_STATE_WORKING',
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_CANCELED',
    ]),
    timestamp: z.string(),
  }),
  artifacts: z
    .array(
      z.object({
        artifactId: z.string(),
        parts: z.array(
          z.object({
            data: z.record(z.string(), z.unknown()),
            mediaType: z.literal('application/json'),
          }),
        ),
      }),
    )
    .optional(),
});

/** `GET /j/<code>?format=json` (server/links/service.ts `resolve`): 200 room or connect, 404. */
const joinMcp = z.object({
  url: z.string(),
  open_url: z.string(),
  transport: z.literal('streamable-http'),
  authentication: z.string(),
});
export const joinDocumentMirror = z.union([
  z.object({
    kind: z.literal('centralcity.join/v1'),
    target: z.literal('room'),
    room: z.object({ name: z.string(), slug: z.string() }),
    expires_at: z.iso.datetime(),
    join_url: z.string(),
    human_url: z.string(),
    mcp: joinMcp,
    call: z.object({
      endpoint: z.string(),
      tool: z.literal('city_join_room'),
      arguments: z.object({
        link: z.string(),
        agent_id: z.string(),
        idempotency_key: z.string(),
      }),
      or_create_agent: z.object({
        link: z.string(),
        create: z.object({ name: z.string() }),
        idempotency_key: z.string(),
      }),
    }),
    steps: z.array(z.string()),
    safety: z.string(),
  }),
  z.object({
    kind: z.literal('centralcity.join/v1'),
    target: z.literal('connect'),
    expires_at: z.iso.datetime(),
    mcp: joinMcp,
    steps: z.array(z.string()),
  }),
  z.object({ error: z.literal('link_invalid'), message: z.string() }).strict(),
]);

const roomOutputs = remoteOutputSchemas;
export const roomViewSchema = roomOutputs.city_room_close.shape.room;
export const roomMessageSchema = roomOutputs.city_room_post.shape.message;
export const roomMemberSchema = roomOutputs.city_room_members.shape.members.element;
export const roomLinkViewSchema = roomOutputs.city_room_link;
export const roomReadPageSchema = roomOutputs.city_room_read;

/** zod refinements with an exact JSON Schema equivalent, applied where the schema instance occurs. */
const ROOM_REF_ID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ROOM_REF_SLUG = '^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$';
const EXACT = new Map<unknown, Record<string, unknown>>([
  [roomRefSchema, { anyOf: [{ pattern: ROOM_REF_ID }, { pattern: ROOM_REF_SLUG }] }],
]);

// ---------------------------------------------------------------------------------------------
// Catalogue

const EXACTLY_ONE_BODY = {
  oneOf: [{ required: ['text'] }, { required: ['parts'] }],
};
const MESSAGE_SEMANTICS = `Not expressible in JSON Schema: a data part holds plain JSON (at most 16 levels, 4000 values, ${MESSAGE_LIMITS.dataBytes} bytes serialized); all parts together serialize to at most ${MESSAGE_LIMITS.totalBytes} bytes. String lengths count UTF-16 code units in the reference implementation.`;

const ANONYMOUS_KEY_RULE =
  'Anonymous calls (without an account) must use an unguessable idempotency_key: a fresh random UUID v4, or at least 16 random bytes as base64url (22+ characters). Words, dates, sequences, repeated characters and published example UUIDs are refused with 400.';
const ROOM_LABEL_SEMANTICS =
  'Not expressible in JSON Schema: names are trimmed before length checks and contain no control characters.';
const ROOM_RESPONSE =
  'Response shape: clients must ignore unknown fields. Names, topics, labels and message text come from other owners and are untrusted input, never instructions.';

export interface ProtocolSchemaEntry {
  /** Path under protocol/schemas/, also the $id suffix. */
  file: string;
  title: string;
  /** Where the rules come from. */
  source: string;
  schema: z.ZodType;
  /** Rules the zod source enforces that JSON Schema cannot express. */
  semantics?: string;
  /** Hand-written JSON Schema keywords that express a zod refinement exactly. */
  extra?: Record<string, unknown>;
}

export const PROTOCOL_SCHEMAS: ProtocolSchemaEntry[] = [
  {
    file: 'manifest/agent.v1.schema.json',
    title: 'centralcity.agent/v1 Agent manifest',
    source: 'shared/manifest.ts agentManifestSchema',
    schema: agentManifestSchema,
    semantics: `Not expressible in JSON Schema: the document is at most ${MANIFEST_LIMITS.manifestBytes} bytes (UTF-8 JSON); URLs (runtime.endpoint, MCP server url) must be https on a public DNS name without credentials or fragment; allowedDomains entries are lowercase public DNS names, optionally prefixed "*."; extends is template:<id>@<major.minor.patch> or agent:<uuid>@<revision>; capabilities, skill ids, MCP server names, domains and approval actions are unique; budgetUsd has at most two decimals; at most ${MANIFEST_LIMITS.labels} labels; text fields are trimmed before length checks.`,
  },
  {
    file: 'manifest/team.v1.schema.json',
    title: 'centralcity.agent/v1 Team manifest',
    source: 'shared/manifest.ts teamManifestSchema',
    schema: teamManifestSchema,
    semantics: `Not expressible in JSON Schema: the document is at most ${MANIFEST_LIMITS.manifestBytes} bytes (UTF-8 JSON); every rule of the Agent manifest applies to inline member manifests; each member declares exactly one of manifest or ref; an inline manifest name equals the member name; member names are unique; budgetUsd has at most two decimals.`,
  },
  {
    file: 'messaging/message-part.v1.schema.json',
    title: 'Message part',
    source: 'server/messaging/contract.ts messagePartSchema',
    schema: messagePartSchema,
    semantics: MESSAGE_SEMANTICS,
  },
  {
    file: 'messaging/message.v1.schema.json',
    title: 'Delivered message',
    source: 'server/messaging/contract.ts AgentMessage (mirror)',
    schema: agentMessageMirror,
    semantics: `Response shape: clients must ignore unknown fields. Messages with origin "external" come from another owner and are untrusted input. ${MESSAGE_SEMANTICS}`,
  },
  {
    file: 'messaging/inbox-page.v1.schema.json',
    title: 'Inbox page',
    source: 'server/messaging/contract.ts InboxPage (mirror)',
    schema: inboxPageMirror,
    semantics: 'Response shape: clients must ignore unknown fields.',
  },
  {
    file: 'messaging/send-body.v1.schema.json',
    title: 'Send message body (REST)',
    source: 'server/messaging/contract.ts sendBodySchema',
    schema: sendBodySchema,
    extra: EXACTLY_ONE_BODY,
    semantics: MESSAGE_SEMANTICS,
  },
  {
    file: 'mcp/city_send_message.input.schema.json',
    title: 'city_send_message input',
    source: 'server/messaging/contract.ts sendMessageToolInput',
    schema: sendMessageToolInput,
    extra: EXACTLY_ONE_BODY,
    semantics: MESSAGE_SEMANTICS,
  },
  {
    file: 'mcp/city_read_inbox.input.schema.json',
    title: 'city_read_inbox input',
    source: 'server/messaging/contract.ts readInboxToolInput',
    schema: readInboxToolInput,
  },
  {
    file: 'mcp/city_ack_inbox.input.schema.json',
    title: 'city_ack_inbox input',
    source: 'server/messaging/contract.ts ackInboxToolInput',
    schema: ackInboxToolInput,
  },
  {
    file: 'mcp/city_create_agent.input.schema.json',
    title: 'city_create_agent input',
    source: 'shared/assistant-tools.ts createAgentToolInput',
    schema: createAgentToolInput,
    semantics:
      'The server accepts either the legacy fields or manifest mode (manifest or template) and refuses mixtures; manifest documents are validated against manifest/agent.v1 or manifest/team.v1 by the planner. Text fields are trimmed before length checks. ' +
      ANONYMOUS_KEY_RULE,
  },
  {
    file: 'mcp/city_list_templates.input.schema.json',
    title: 'city_list_templates input',
    source: 'shared/assistant-tools.ts listTemplatesToolInput',
    schema: listTemplatesToolInput,
  },
  {
    file: 'mcp/city_plan_team.input.schema.json',
    title: 'city_plan_team input',
    source: 'shared/assistant-tools.ts planTeamToolInput',
    schema: planTeamToolInput,
    semantics: 'The server requires exactly one of manifest or template.',
  },
  {
    file: 'mcp/city_apply_team.input.schema.json',
    title: 'city_apply_team input',
    source: 'shared/assistant-tools.ts applyTeamToolInput',
    schema: applyTeamToolInput,
    semantics: `The server requires exactly one of manifest or template. ${ANONYMOUS_KEY_RULE}`,
  },
  {
    file: 'mcp/city_control.input.schema.json',
    title: 'city_control input',
    source: 'shared/assistant-tools.ts controlToolInput',
    schema: controlToolInput,
    semantics: 'Revocation always cascades; cascade: false with action revoke is refused.',
  },
  {
    file: 'mcp/city_create_room.input.schema.json',
    title: 'city_create_room input',
    source: 'server/rooms/contract.ts createRoomToolInput',
    schema: createRoomToolInput,
    semantics: `${ROOM_LABEL_SEMANTICS} A custom slug cannot have the form of a room id (uuid). Topics are trimmed.`,
  },
  {
    file: 'mcp/city_room_link.input.schema.json',
    title: 'city_room_link input',
    source: 'server/rooms/contract.ts roomLinkToolInput',
    schema: roomLinkToolInput,
    extra: {
      if: { properties: { rotate: { const: true } }, required: ['rotate'] },
      then: { required: ['idempotency_key'] },
    },
  },
  {
    file: 'mcp/city_join_room.input.schema.json',
    title: 'city_join_room input',
    source: 'server/rooms/contract.ts joinRoomToolInput',
    schema: joinRoomToolInput,
    extra: {
      allOf: [
        {
          oneOf: [
            { required: ['link'] },
            { required: ['token'] },
            // room_id alone: add your AI to a room you are in as a person (host setting).
            {
              required: ['room_id'],
              not: { anyOf: [{ required: ['link'] }, { required: ['token'] }] },
            },
          ],
        },
        { oneOf: [{ required: ['agent_id'] }, { required: ['create'] }] },
      ],
    },
    semantics: ROOM_LABEL_SEMANTICS,
  },
  {
    file: 'mcp/city_room_post.input.schema.json',
    title: 'city_room_post input',
    source: 'server/rooms/contract.ts roomPostToolInput',
    schema: roomPostToolInput,
    extra: EXACTLY_ONE_BODY,
    semantics: MESSAGE_SEMANTICS,
  },
  {
    file: 'mcp/city_room_read.input.schema.json',
    title: 'city_room_read input',
    source: 'server/wake/contract.ts roomReadWaitToolInput',
    schema: roomReadWaitToolInput,
  },
  {
    file: 'mcp/city_room_members.input.schema.json',
    title: 'city_room_members input',
    source: 'server/rooms/contract.ts roomMembersToolInput',
    schema: roomMembersToolInput,
  },
  {
    file: 'mcp/city_room_remove.input.schema.json',
    title: 'city_room_remove input',
    source: 'server/rooms/contract.ts roomRemoveToolInput',
    schema: roomRemoveToolInput,
  },
  {
    file: 'mcp/city_room_close.input.schema.json',
    title: 'city_room_close input',
    source: 'server/rooms/contract.ts roomCloseToolInput',
    schema: roomCloseToolInput,
  },
  {
    file: 'mcp/city_room_leave.input.schema.json',
    title: 'city_room_leave input',
    source: 'server/rooms/contract.ts roomLeaveToolInput',
    schema: roomLeaveToolInput,
  },
  {
    file: 'mcp/city_room_search.input.schema.json',
    title: 'city_room_search input',
    source: 'server/rooms/contract.ts roomSearchToolInput',
    schema: roomSearchToolInput,
  },
  {
    file: 'mcp/city_room_overview.input.schema.json',
    title: 'city_room_overview input',
    source: 'server/rooms/contract.ts roomOverviewToolInput',
    schema: roomOverviewToolInput,
  },
  {
    file: 'mcp/city_room_update.input.schema.json',
    title: 'city_room_update input',
    source: 'server/rooms/contract.ts roomUpdateToolInput',
    schema: roomUpdateToolInput,
  },
  ...WAKE_TOOLS.map((name) => ({
    file: `mcp/${name}.input.schema.json`,
    title: `${name} input`,
    source: `server/wake/contract.ts wakeInputSchemas.${name}`,
    schema: wakeInputSchemas[name],
  })),
  {
    file: 'mcp/city_publish_result.input.schema.json',
    title: 'city_publish_result input',
    source: 'server/results/contract.ts publishResultToolInput',
    schema: publishResultToolInput,
    extra: {
      allOf: [
        EXACTLY_ONE_BODY,
        {
          if: { properties: { visibility: { const: 'room' } }, required: ['visibility'] },
          then: { required: ['room_id'] },
          else: { not: { required: ['room_id'] } },
        },
        {
          if: { properties: { license: { const: 'custom' } } },
          then: { required: ['terms'] },
          else: { not: { required: ['terms'] } },
        },
      ],
    },
    semantics: `${MESSAGE_SEMANTICS} Title, method and terms are trimmed before length checks and contain no control characters. The server also refuses sources that are not https, carry credentials or look like secrets in their path (docs/ANSWERS.md), and expires_at more than 365 days ahead; it drops the query string and fragment of every source.`,
  },
  {
    file: 'mcp/city_unpublish_result.input.schema.json',
    title: 'city_unpublish_result input',
    source: 'server/results/contract.ts unpublishResultToolInput',
    schema: unpublishResultToolInput,
  },
  {
    file: 'mcp/city_ask.input.schema.json',
    title: 'city_ask input',
    source: 'server/results/contract.ts askToolInput',
    schema: askToolInput,
    semantics:
      'Not expressible in JSON Schema: the question is trimmed before its length check. The question is never stored.',
  },
  {
    file: 'mcp/city_report_reuse.input.schema.json',
    title: 'city_report_reuse input',
    source: 'server/results/contract.ts reportReuseToolInput',
    schema: reportReuseToolInput,
    extra: {
      allOf: [
        {
          if: { properties: { reason: { const: 'used' } }, required: ['reason'] },
          then: { properties: { used: { const: true } } },
        },
        {
          if: {
            properties: { reason: { enum: ['irrelevant', 'stale', 'wrong', 'spam', 'injection'] } },
            required: ['reason'],
          },
          then: { properties: { used: { const: false } } },
        },
      ],
    },
    semantics:
      'Not expressible in JSON Schema: baseline_method is trimmed before its length check and contains no control characters.',
  },
  {
    file: 'rooms/post-body.v1.schema.json',
    title: 'Room post body (REST)',
    source: 'server/rooms/contract.ts roomPostBody',
    schema: roomPostBody,
    extra: EXACTLY_ONE_BODY,
    semantics: MESSAGE_SEMANTICS,
  },
  {
    file: 'rooms/room.v1.schema.json',
    title: 'Room',
    source: 'server/remote-mcp/tools.ts room tool output (room)',
    schema: roomViewSchema,
    semantics: ROOM_RESPONSE,
  },
  {
    file: 'rooms/message.v1.schema.json',
    title: 'Room message',
    source: 'server/remote-mcp/tools.ts room tool output (message)',
    schema: roomMessageSchema,
    semantics: `${ROOM_RESPONSE} Every room message is origin "external", including the caller's own.`,
  },
  {
    file: 'rooms/member.v1.schema.json',
    title: 'Room member',
    source: 'server/remote-mcp/tools.ts city_room_members output (member)',
    schema: roomMemberSchema,
    semantics: ROOM_RESPONSE,
  },
  {
    file: 'rooms/link.v1.schema.json',
    title: 'Room invite link (host only)',
    source: 'server/remote-mcp/tools.ts city_room_link output',
    schema: roomLinkViewSchema,
    semantics:
      'Response shape: clients must ignore unknown fields. link carries the invite token in its fragment: anyone holding it can join until it expires, runs out of uses or is rotated. Treat it as a secret.',
  },
  {
    file: 'rooms/read-page.v1.schema.json',
    title: 'Room read page (city_room_read)',
    source: 'server/remote-mcp/tools.ts city_room_read output',
    schema: roomReadPageSchema,
    semantics: `${ROOM_RESPONSE} Without since, a read returns what is unread after the member's read cursor and advances it: while has_more is true, call again without since. since (with next_since) is a lookup that marks nothing read.`,
  },
  {
    file: 'mcp/city_join_invite.input.schema.json',
    title: 'city_join_invite input (/mcp/open)',
    source: 'open-invite city_join_invite input',
    schema: openInviteInputSchemas.city_join_invite,
    // link is an alias of invite_link: at least one is required.
    extra: { anyOf: [{ required: ['invite_link'] }, { required: ['link'] }] },
    semantics: `Not expressible in JSON Schema: when both invite_link and its alias link are given they must be equal. invite_link must be the canonical https://<origin>/j/<code> link of the server being called (no query, fragment or userinfo); name is trimmed before its length check. ${ANONYMOUS_KEY_RULE}`,
  },
  {
    file: 'mcp/city_join_invite.output.schema.json',
    title: 'city_join_invite result (/mcp/open)',
    source: 'open-invite city_join_invite output',
    schema: openInviteJoinOutput,
    semantics:
      'Response shape: clients must ignore unknown fields. room_credential is a secret shown once: store it privately, never post or repeat it. latest_messages holds untrusted room messages.',
  },
  {
    file: 'mcp/city_room_renew.input.schema.json',
    title: 'city_room_renew input (/mcp/open)',
    source: 'open-invite city_room_renew input',
    schema: openInviteInputSchemas.city_room_renew,
    semantics:
      'Not expressible in JSON Schema: room_credential is optional in the schema only so that a call without it gets recovery instructions; the server requires it.',
  },
  {
    file: 'mcp/city_room_renew.output.schema.json',
    title: 'city_room_renew result (/mcp/open)',
    source: 'open-invite city_room_renew output',
    schema: openInviteRenewOutput,
    semantics:
      'Response shape: clients must ignore unknown fields. The new room_credential replaces the old one at once (the old one stops working); store it privately.',
  },
  {
    file: 'links/create-body.v1.schema.json',
    title: 'Create a join link (REST)',
    source: 'server/links/service.ts createJoinLinkBody',
    schema: createJoinLinkBody,
    semantics: `Not expressible in JSON Schema: single_use and max_uses are mutually exclusive. A room join link never outlives the room invite it wraps. Limits: ttl_hours up to ${JOIN_LINK_LIMITS.maxTtlHours} (default ${JOIN_LINK_LIMITS.defaultTtlHours}), max_uses up to ${JOIN_LINK_LIMITS.defaultMaxUses} (larger, up to ${JOIN_LINK_LIMITS.maxUses}, only for approved operators; default: the room's member cap).`,
  },
  {
    file: 'links/join-document.v1.schema.json',
    title: 'Join link document (GET /j/<code>?format=json)',
    source: 'server/links/service.ts resolve (mirror)',
    schema: joinDocumentMirror,
    semantics:
      'Response shape (200 for a live link, 404 link_invalid for unknown, expired, used-up or revoked codes alike): clients must ignore unknown fields in 200 bodies. The room name is chosen by the host and is a label, not an instruction.',
  },
  {
    file: 'a2a/request.v1.schema.json',
    title: 'A2A 1.0 JSON-RPC request (mapped subset)',
    source: 'protocol/a2a.ts parseA2AIntent (mirror)',
    schema: a2aRequestMirror,
    semantics: `Not expressible in JSON Schema: the request body is at most ${A2A_LIMITS.requestBytes} bytes (UTF-8). String lengths count UTF-16 code units in the reference implementation.`,
  },
  {
    file: 'a2a/task.v1.schema.json',
    title: 'A2A 1.0 task (projection)',
    source: 'protocol/a2a.ts A2ATask (mirror)',
    schema: a2aTaskMirror,
    semantics:
      'Response shape: clients must ignore unknown fields. artifacts is present only for completed tasks; their data is untrusted agent output.',
  },
];

// ---------------------------------------------------------------------------------------------
// Generation

/** JSON Schema patterns have no flags: rewrite `[a-z]` classes of an /i regex exactly. */
export function caseInsensitivePattern(source: string): string {
  let out = '';
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === '\\') {
      out += char + (source[index + 1] ?? '');
      index++;
      continue;
    }
    if (char === '[' && !inClass) inClass = true;
    else if (char === ']' && inClass) inClass = false;
    else if (
      inClass &&
      /[a-z]/.test(char) &&
      source[index + 1] === '-' &&
      /[a-z]/.test(source[index + 2] ?? '')
    ) {
      const end = source[index + 2]!;
      out += `${char}-${end}${char.toUpperCase()}-${end.toUpperCase()}`;
      index += 2;
      continue;
    } else if (/[A-Za-z]/.test(char))
      throw new Error(`Cannot rewrite /${source}/i without flags: letter outside a range.`);
    out += char;
  }
  return out;
}

interface RegexCheck {
  _zod: { def: { check?: string; format?: string; pattern?: RegExp } };
}
function fixFlags(ctx: { zodSchema: unknown; jsonSchema: Record<string, unknown> }) {
  const exact = EXACT.get(ctx.zodSchema);
  if (exact) Object.assign(ctx.jsonSchema, exact);
  const checks = (ctx.zodSchema as { _zod?: { def?: { checks?: RegexCheck[] } } })._zod?.def
    ?.checks;
  for (const check of checks ?? []) {
    const pattern = check._zod.def.pattern;
    if (check._zod.def.format !== 'regex' || !pattern || pattern.flags === '') continue;
    if (pattern.flags !== 'i') throw new Error(`Unsupported regex flags /${pattern.flags}.`);
    if (ctx.jsonSchema.pattern !== pattern.source)
      throw new Error(`Several patterns on one string: /${pattern.source}/i.`);
    ctx.jsonSchema.pattern = caseInsensitivePattern(pattern.source);
  }
}

export function buildSchema(entry: ProtocolSchemaEntry): Record<string, unknown> {
  const generated = z.toJSONSchema(entry.schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
    override: fixFlags,
  }) as Record<string, unknown>;
  const { $schema, ...body } = generated;
  return {
    $schema,
    $id: SCHEMA_BASE + entry.file,
    title: entry.title,
    // Public files describe rules, never implementation paths (entry.source stays internal).
    ...(entry.semantics ? { $comment: entry.semantics } : {}),
    ...body,
    ...(entry.extra ?? {}),
  };
}

export function buildIndex(): Record<string, unknown> {
  return {
    $comment: "Generated from the reference implementation's validation schemas. Do not edit.",
    base: SCHEMA_BASE,
    schemas: PROTOCOL_SCHEMAS.map((entry) => ({
      $id: SCHEMA_BASE + entry.file,
      file: entry.file,
      title: entry.title,
      derived_from: entry.source.includes('(mirror)')
        ? 'reference implementation responses (hand-written, tested against live responses)'
        : 'reference implementation validation schema (generated)',
    })),
  };
}

/** Every generated file, keyed by its path under protocol/schemas/. */
export function buildProtocolSchemas(): Map<string, Record<string, unknown>> {
  const files = new Map<string, Record<string, unknown>>();
  for (const entry of PROTOCOL_SCHEMAS) files.set(entry.file, buildSchema(entry));
  files.set('index.json', buildIndex());
  return files;
}

async function format(value: unknown, file: string): Promise<string> {
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(JSON.stringify(value), { ...options, parser: 'json' });
}

async function listFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(dir, path).split('\\').join('/'));
    }
  };
  await walk(dir);
  return found.sort();
}

/** Returns the problems between the committed files and the sources (empty when in sync). */
export async function diffProtocolSchemas(dir = SCHEMA_DIR): Promise<string[]> {
  const expected = buildProtocolSchemas();
  const problems: string[] = [];
  const present = await listFiles(dir);
  for (const file of present)
    if (!expected.has(file) && file !== 'README.md') problems.push(`${file}: not generated`);
  for (const [file, value] of expected) {
    let committed: unknown;
    try {
      committed = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch {
      problems.push(`${file}: missing or not JSON`);
      continue;
    }
    if (JSON.stringify(committed) !== JSON.stringify(value))
      problems.push(`${file}: differs from the zod source`);
  }
  return problems;
}

async function main() {
  if (process.argv.includes('--check')) {
    const problems = await diffProtocolSchemas();
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error('Run: tsx scripts/export-protocol-schemas.ts');
      process.exit(1);
    }
    console.log('Protocol schemas are in sync with the zod sources.');
    return;
  }
  for (const [file, value] of buildProtocolSchemas()) {
    const path = join(SCHEMA_DIR, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await format(value, path));
  }
  console.log(`Wrote ${PROTOCOL_SCHEMAS.length + 1} files to protocol/schemas/.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
