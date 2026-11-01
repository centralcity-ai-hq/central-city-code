import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { Job } from '../shared/types.js';

/** Local, deliberately narrow mapping boundary; this module provides no transport or authority. */
export const A2A_PIN = Object.freeze({
  release: '1.0.0',
  wireVersion: '1.0',
  binding: 'JSONRPC',
  upstreamCommit: '173695755607e884aa9acf8ce4feed90e32727a1',
  protobufSha256: '4b74c0baa923ae0acb55474e548f1d6e5d3f83b80d757b65f8bf3e99a3c2257f',
});

export const A2A_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  inputCharacters: 12000,
  outputBytes: 32 * 1024,
});

export type MappingErrorCode =
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_BINDING'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_OPERATION'
  | 'UNSUPPORTED_PARAMETERS'
  | 'INVALID_NATIVE_JOB'
  | 'CANCEL_NOT_CONFIRMED';

export class A2AMappingError extends Error {
  constructor(
    public readonly code: MappingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'A2AMappingError';
  }
}

export interface WireSelection {
  version: string | undefined;
  binding: string;
}

export function requirePinnedA2A(selection: WireSelection): void {
  // An absent header implies legacy 0.3 in A2A; this spike intentionally does not support it.
  if (selection.version !== A2A_PIN.wireVersion) {
    throw new A2AMappingError(
      'UNSUPPORTED_VERSION',
      'Only A2A wire version 1.0 is supported by this mapping.',
    );
  }
  if (selection.binding !== A2A_PIN.binding) {
    throw new A2AMappingError(
      'UNSUPPORTED_BINDING',
      'Only the JSONRPC representation is supported by this mapping.',
    );
  }
}

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const rpcId = z.union([identifier, z.number().int().safe()]);
type RpcId = z.infer<typeof rpcId>;
const envelope = z
  .object({ jsonrpc: z.literal('2.0'), id: rpcId, method: z.string(), params: z.unknown() })
  .strict();
const sendParameters = z
  .object({
    message: z
      .object({
        messageId: identifier,
        role: z.literal('ROLE_USER'),
        parts: z.tuple([
          z
            .object({
              text: z
                .string()
                .min(1)
                .max(A2A_LIMITS.inputCharacters)
                .refine((text) => text.trim().length > 0)
                // Text the database can't store (a NUL, half an emoji): invalid params, not a 500.
                .refine(
                  (text) =>
                    !text.includes('\u0000') &&
                    (text as string & { isWellFormed(): boolean }).isWellFormed(),
                ),
              mediaType: z.literal('text/plain').optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
    // The native queue cannot implement A2A's default blocking SendMessage semantics yet.
    configuration: z
      .object({
        returnImmediately: z.literal(true),
        historyLength: z.literal(0).optional(),
        acceptedOutputModes: z.tuple([z.literal('application/json')]).optional(),
      })
      .strict(),
  })
  .strict();
const getParameters = z.object({ id: identifier, historyLength: z.literal(0).optional() }).strict();
const cancelParameters = z.object({ id: identifier }).strict();

export type A2AIntent =
  | { method: 'SendMessage'; rpcId: RpcId; messageId: string; input: string }
  | { method: 'GetTask'; rpcId: RpcId; taskId: string }
  | { method: 'CancelTask'; rpcId: RpcId; taskId: string };

/** Returns untrusted intent only. Caller must authenticate, authorize, bind IDs and deduplicate. */
export function parseA2AIntent(raw: string, selection: WireSelection): A2AIntent {
  requirePinnedA2A(selection);
  if (Buffer.byteLength(raw, 'utf8') > A2A_LIMITS.requestBytes) {
    throw new A2AMappingError('PAYLOAD_TOO_LARGE', 'Request exceeds the local mapping limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new A2AMappingError('INVALID_JSON', 'Request is not valid JSON.');
  }
  const request = envelope.safeParse(value);
  if (!request.success)
    throw new A2AMappingError(
      'INVALID_REQUEST',
      'A single JSON-RPC 2.0 request with an ID is required.',
    );
  const { id, method, params } = request.data;
  if (method === 'SendMessage') {
    const parsed = sendParameters.safeParse(params);
    if (!parsed.success)
      throw new A2AMappingError(
        'UNSUPPORTED_PARAMETERS',
        'Only a new text-only message with returnImmediately=true is mapped.',
      );
    return {
      method,
      rpcId: id,
      messageId: parsed.data.message.messageId,
      input: parsed.data.message.parts[0].text,
    };
  }
  if (method === 'GetTask' || method === 'CancelTask') {
    const parsed = (method === 'GetTask' ? getParameters : cancelParameters).safeParse(params);
    if (!parsed.success)
      throw new A2AMappingError(
        'UNSUPPORTED_PARAMETERS',
        'Only a task ID and optional zero history length for GetTask are mapped.',
      );
    return { method, rpcId: id, taskId: parsed.data.id };
  }
  throw new A2AMappingError(
    'UNSUPPORTED_OPERATION',
    'This mapping handles SendMessage, GetTask and CancelTask intent only.',
  );
}

const stateMap = {
  queued: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
} as const satisfies Record<Job['status'], string>;

export type A2ATask = {
  id: string;
  contextId: string;
  status: { state: (typeof stateMap)[Job['status']]; timestamp: string };
  artifacts?: Array<{
    artifactId: string;
    parts: Array<{ data: Record<string, unknown>; mediaType: 'application/json' }>;
  }>;
};

const utcTimestamp = z.iso
  .datetime({ precision: 3 })
  .refine((value) => Number.isFinite(Date.parse(value)));
const projectionInput = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
  updatedAt: utcTimestamp,
  completedAt: utcTimestamp.nullable(),
  output: z.unknown(),
});

function copyOutput(output: unknown): Record<string, unknown> {
  if (output === null || Array.isArray(output) || typeof output !== 'object') {
    throw new A2AMappingError(
      'INVALID_NATIVE_JOB',
      'Completed native jobs require a JSON object output.',
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(output, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error('Non-finite JSON number');
      if (
        typeof value === 'undefined' ||
        typeof value === 'bigint' ||
        typeof value === 'function' ||
        typeof value === 'symbol'
      )
        throw new Error('Non-JSON value');
      return value;
    });
  } catch {
    throw new A2AMappingError(
      'INVALID_NATIVE_JOB',
      'Output must contain only serializable JSON values.',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > A2A_LIMITS.outputBytes) {
    throw new A2AMappingError('PAYLOAD_TOO_LARGE', 'Output exceeds the local mapping limit.');
  }
  const copy: unknown = JSON.parse(serialized);
  if (copy === null || Array.isArray(copy) || typeof copy !== 'object') {
    throw new A2AMappingError(
      'INVALID_NATIVE_JOB',
      'Output must remain a JSON object after serialization.',
    );
  }
  return copy as Record<string, unknown>;
}

/** Project only after an authorized lookup. Wire IDs are supplied by a future scoped ID store. */
export function projectNativeJob(
  job: Job,
  selection: WireSelection & { taskId: string; contextId: string },
): A2ATask {
  requirePinnedA2A(selection);
  if (
    !identifier.safeParse(selection.taskId).success ||
    !identifier.safeParse(selection.contextId).success
  ) {
    throw new A2AMappingError('INVALID_REQUEST', 'Bounded opaque wire IDs are required.');
  }
  const parsed = projectionInput.safeParse(job);
  if (!parsed.success)
    throw new A2AMappingError('INVALID_NATIVE_JOB', 'Native status or timestamp is invalid.');
  const { status, completedAt, updatedAt, output } = parsed.data;
  const terminal = status === 'completed' || status === 'failed' || status === 'canceled';
  if (terminal && completedAt === null)
    throw new A2AMappingError(
      'INVALID_NATIVE_JOB',
      'A terminal job must record its completion time.',
    );
  const task: A2ATask = {
    id: selection.taskId,
    contextId: selection.contextId,
    status: { state: stateMap[status], timestamp: terminal ? completedAt! : updatedAt },
  };
  if (status === 'completed')
    task.artifacts = [
      {
        artifactId: `${selection.taskId}:output`,
        parts: [{ data: copyOutput(output), mediaType: 'application/json' }],
      },
    ];
  // Acceptance, cost, prompts, provider/requester IDs and internal errors intentionally stay local.
  return task;
}

/** Shapes a response only; it cannot execute or confirm a cancellation on its own. */
export function createTaskResponse(intent: A2AIntent, task: A2ATask) {
  if (intent.method !== 'SendMessage' && intent.taskId !== task.id) {
    throw new A2AMappingError(
      'INVALID_REQUEST',
      'Task response does not match the requested wire ID.',
    );
  }
  if (intent.method === 'CancelTask' && task.status.state !== 'TASK_STATE_CANCELED') {
    throw new A2AMappingError(
      'CANCEL_NOT_CONFIRMED',
      'A cancellation request is not a canceled task.',
    );
  }
  return {
    jsonrpc: '2.0' as const,
    id: intent.rpcId,
    result: intent.method === 'SendMessage' ? { task } : task,
  };
}
