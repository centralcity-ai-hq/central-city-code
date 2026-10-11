/**
 * Elric on a hosted model provider's Messages API (POST /v1/messages, no SDK), for Tier 1 and
 * Tier 2. The same contract as the self-hosted adapter (adapter.ts): the adapter gets only the
 * prompt, the tool schemas and a token cap, returns text or tool *requests*, and every failure is
 * a fixed AdapterError code. Provider text, and the API key, never appear in an error, a log or
 * a returned value.
 *
 * - Prompt caching: a cache breakpoint on the system prompt (caches tools + system) and one on
 *   the last message (caches the room history for the next step of the same run).
 * - Native tool use: tool_use blocks become ElricToolCall requests; tool results go back as
 *   tool_result blocks. The service still decides what runs (the approval gate is unchanged).
 * - No waking state and no health probe: a hosted API does not scale from zero.
 * - Fallback: on a rate limit, an overload or another provider failure, the call goes once to
 *   the self-hosted endpoint when one is configured; otherwise the error stands and the
 *   owner sees ELRIC_MODEL_FAILED_NOTICE.
 */
import { httpsWebhookTransport, type WebhookTransport } from '../wake/webhooks.js';
import {
  AdapterError,
  unavailableAdapter,
  checkBaseUrl,
  OpenAICompatibleAdapter,
  OPENAI_COMPATIBLE_LIMITS,
  elricTransport,
  loopbackAllowed,
  type AdapterErrorCode,
  type ElricMessage,
  type ElricThinkingBlock,
  type ElricToolCall,
  type FetchLike,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from './adapter.js';
import { ELRIC_THINKING_BUDGET_TOKENS } from './config.js';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** Output tokens per call on each tier (never above ELRIC_CONFIG.maxOutputTokens: budgets). */
export const ELRIC_ANTHROPIC_MAX_TOKENS: Record<1 | 2, number> = { 1: 1_600, 2: 2_400 };
/** One call may use almost the whole run budget (55 s); the service caps it at what is left. */
const TIER_TIMEOUT_MS = 55_000;

type Env = Record<string, string | undefined>;
type WireBlock = Record<string, unknown>;
type WireMessage = { role: 'user' | 'assistant'; content: WireBlock[] };

const TOOL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const safeId = (id: string, index: number) => (TOOL_ID.test(id) ? id : `call_${index}`);
const EPHEMERAL = { type: 'ephemeral' } as const;

/** ElricMessage[] → Messages API turns (consecutive same-role turns merged, as the API needs). */
export function toAnthropicMessages(messages: ElricMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  const add = (role: WireMessage['role'], blocks: WireBlock[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  messages.forEach((message, index) => {
    if (message.role === 'user') add('user', [{ type: 'text', text: message.content || ' ' }]);
    else if (message.role === 'tool')
      add('user', [
        {
          type: 'tool_result',
          tool_use_id: safeId(message.toolCallId, index),
          content: message.content,
        },
      ]);
    else
      add('assistant', [
        // Thinking first and unchanged (with its signature), as the API requires on tool turns.
        ...(message.thinking ?? []).map((block) => ({ ...block })),
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: 'tool_use',
          id: safeId(call.id, index),
          name: call.name,
          input: call.args ?? {},
        })),
      ]);
  });
  // Cache breakpoint on the newest block: the history up to here is reused by the next step.
  const tail = out.at(-1)?.content.at(-1);
  if (tail) tail.cache_control = EPHEMERAL;
  return out;
}

/**
 * Extended thinking for this request: asked for, and every earlier assistant turn with tool calls
 * carries its thinking (a step answered by the fallback has none, and the API refuses a thinking
 * request whose tool turn lacks it; that step then runs without thinking).
 */
export function thinkingFor(request: ModelRequest): boolean {
  if (!request.thinking) return false;
  return request.messages.every(
    (message) =>
      message.role !== 'assistant' || !message.toolCalls?.length || !!message.thinking?.length,
  );
}

/**
 * The request body. `maxTokens` caps the tier's answer; with thinking, the thinking budget is
 * added on top (thinking tokens count toward max_tokens). The request's own cap can only lower it.
 */
export function toAnthropicWire(request: ModelRequest, model: string, maxTokens: number) {
  const thinking = thinkingFor(request);
  const cap = thinking ? maxTokens + ELRIC_THINKING_BUDGET_TOKENS : maxTokens;
  return {
    model,
    max_tokens: Math.max(1, Math.min(cap, request.maxOutputTokens)),
    ...(thinking
      ? { thinking: { type: 'enabled', budget_tokens: ELRIC_THINKING_BUDGET_TOKENS } }
      : {}),
    system: [{ type: 'text', text: request.system, cache_control: EPHEMERAL }],
    messages: toAnthropicMessages(request.messages),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
          tool_choice: { type: 'auto' },
        }
      : {}),
  };
}

/** HTTP status → fixed code, and whether the model may have run (charged). */
function failure(status: number, retryAfter?: string | null): AdapterError {
  if (status === 401 || status === 403) return new AdapterError('unauthorized');
  if (status === 404) return new AdapterError('model_unavailable');
  if (status === 413) return new AdapterError('too_large');
  if (status === 429) {
    const seconds = Number(retryAfter ?? NaN);
    return new AdapterError(
      'rate_limited',
      false,
      Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.ceil(seconds * 1000) } : {},
    );
  }
  // 529 overloaded: refused before any work.
  if (status === 529) return new AdapterError('server_error');
  if (status >= 500) return new AdapterError('server_error', true);
  if (status >= 300 && status < 400) return new AdapterError('bad_response', true);
  return new AdapterError('bad_request');
}

async function readCapped(
  response: Awaited<ReturnType<FetchLike>>,
  max: number,
): Promise<string | null> {
  const declared = Number(response.headers?.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = (await response.text?.()) ?? '';
  return Buffer.byteLength(text) > max ? null : text;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/**
 * Reads a Messages API event stream (stream: true) and rebuilds the same message object the
 * non-streaming API returns, so one parser serves both. `onText` gets the answer text so far
 * (text blocks only, joined like the final answer); thinking, signatures and tool input are
 * assembled silently. An `error` event (for example overloaded) is a server_error.
 */
export async function readMessageStream(
  response: Awaited<ReturnType<FetchLike>>,
  max: number,
  onText?: (text: string) => void,
): Promise<string | null> {
  const blocks: Array<Record<string, unknown> & { type?: unknown }> = [];
  const partialJson = new Map<number, string>();
  let message: Record<string, unknown> | null = null;
  const usage: Record<string, unknown> = {};
  let size = 0;
  let buffer = '';
  const answer = () =>
    blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n\n');
  const handle = (data: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new AdapterError('bad_response', true);
    }
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start': {
        message = (event.message as Record<string, unknown>) ?? {};
        Object.assign(usage, (message.usage as Record<string, unknown>) ?? {});
        break;
      }
      case 'content_block_start':
        if (index >= 0 && index < 64)
          blocks[index] = { ...((event.content_block as Record<string, unknown>) ?? {}) };
        break;
      case 'content_block_delta': {
        const block = blocks[index];
        const delta = (event.delta as Record<string, unknown>) ?? {};
        if (!block) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`;
          onText?.(answer());
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string')
          block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.thinking}`;
        else if (delta.type === 'signature_delta' && typeof delta.signature === 'string')
          block.signature = `${typeof block.signature === 'string' ? block.signature : ''}${delta.signature}`;
        else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string')
          partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json);
        break;
      }
      case 'content_block_stop': {
        const block = blocks[index];
        if (block?.type === 'tool_use' && partialJson.has(index)) {
          try {
            block.input = JSON.parse(partialJson.get(index) || '{}');
          } catch {
            block.input = null;
          }
        }
        break;
      }
      case 'message_delta':
        Object.assign(usage, (event.usage as Record<string, unknown>) ?? {});
        break;
      case 'error':
        throw new AdapterError('server_error', true);
      default:
        break;
    }
  };
  const consume = (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) handle(data);
    }
  };
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      consume(decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n'));
    }
    consume(`${decoder.decode()}\n\n`);
  } else {
    const text = (await response.text?.()) ?? '';
    if (Buffer.byteLength(text) > max) return null;
    consume(`${text.replace(/\r\n/g, '\n')}\n\n`);
  }
  if (!message) throw new AdapterError('bad_response', true);
  return JSON.stringify({ ...(message as object), content: blocks.filter(Boolean), usage });
}

export class AnthropicAdapter implements ModelAdapter {
  /** Priced per token (token-cost.ts). */
  readonly pricing = 'anthropic' as const;
  /** Private field: never enumerable, never in JSON or util.inspect output. */
  readonly #key: string;
  private readonly endpoint: string;
  private readonly fetcher: FetchLike;
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      maxTokens: number;
      timeoutMs?: number;
      /** Called on a 401/403 (the key was refused), before the error is thrown. */
      onUnauthorized?: () => void;
      /** Tests only. */
      baseUrl?: string;
      fetch?: FetchLike;
      allowLoopback?: boolean;
    },
  ) {
    this.#key = options.apiKey;
    // The key is held in #key only; drop it from the options object.
    this.options = { ...options, apiKey: '' };
    this.endpoint = new URL('/v1/messages', options.baseUrl ?? ANTHROPIC_API_URL).href;
    this.fetcher =
      options.fetch ?? elricTransport({ allowLoopback: options.allowLoopback ?? false });
  }
  get model(): string {
    return this.options.model;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const streaming = typeof request.onText === 'function';
    const body = JSON.stringify({
      ...toAnthropicWire(request, this.model, this.options.maxTokens),
      ...(streaming ? { stream: true } : {}),
    });
    if (Buffer.byteLength(body) > OPENAI_COMPATIBLE_LIMITS.maxRequestBytes)
      throw new AdapterError('too_large');
    const controller = new AbortController();
    const tierTimeout = this.options.timeoutMs ?? TIER_TIMEOUT_MS;
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(tierTimeout, request.timeoutMs ?? tierTimeout)),
    );
    let text: string | null;
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: streaming ? 'text/event-stream' : 'application/json',
          'x-api-key': this.#key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        const error = failure(response.status, response.headers?.get('retry-after'));
        if (error.code === 'unauthorized') this.options.onUnauthorized?.();
        throw error;
      }
      text = streaming
        ? await readMessageStream(
            response,
            OPENAI_COMPATIBLE_LIMITS.maxResponseBytes,
            request.onText,
          )
        : await readCapped(response, OPENAI_COMPATIBLE_LIMITS.maxResponseBytes);
    } catch (error) {
      if (error instanceof AdapterError)
        // The transport's "connection not open yet" means unreachable here: no scale-from-zero.
        throw error.code === 'waking' ? new AdapterError('unreachable') : error;
      if (controller.signal.aborted)
        throw new AdapterError('timeout', (error as { written?: boolean }).written ?? true);
      throw new AdapterError('unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (text === null) throw new AdapterError('too_large', true);
    let json: {
      type?: unknown;
      content?: unknown;
      usage?: Record<string, unknown>;
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new AdapterError('bad_response', true);
    }
    if (json?.type !== 'message' || !Array.isArray(json.content))
      throw new AdapterError('bad_response', true);
    const texts: string[] = [];
    const toolCalls: ElricToolCall[] = [];
    const thinking: ElricThinkingBlock[] = [];
    for (const [index, raw] of json.content.entries()) {
      const block = raw as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        signature?: unknown;
        data?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      // Kept only to send back on the next step; never part of the answer.
      else if (
        block?.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        typeof block.signature === 'string'
      )
        thinking.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
      else if (block?.type === 'redacted_thinking' && typeof block.data === 'string')
        thinking.push({ type: 'redacted_thinking', data: block.data });
      else if (block?.type === 'tool_use' && toolCalls.length < 16) {
        const input = block.input;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id.slice(0, 100) : `call_${index}`,
          name: typeof block.name === 'string' ? block.name.slice(0, 100) : '',
          args:
            input && typeof input === 'object' && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : null,
        });
      }
    }
    const content = texts.length ? texts.join('\n\n') : null;
    if (content === null && !toolCalls.length) throw new AdapterError('bad_response', true);
    const u = json.usage ?? {};
    const reported = typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number';
    // As the API reports them: input_tokens is the uncached part only; cache reads and cache
    // writes are separate and priced separately (token-cost.ts).
    const usage = {
      inputTokens: count(u.input_tokens),
      outputTokens: count(u.output_tokens),
      cacheReadInputTokens: count(u.cache_read_input_tokens),
      cacheCreationInputTokens: count(u.cache_creation_input_tokens),
      reported,
    };
    // The configured model, never a string the API returned.
    return {
      text: content,
      toolCalls,
      ...(thinking.length ? { thinking } : {}),
      usage,
      model: this.model,
      pricing: 'anthropic',
    };
  }
}

/** Failures after which the fallback endpoint is tried. */
const FALLBACK_ON = new Set<AdapterErrorCode>([
  'rate_limited',
  'server_error',
  'unreachable',
  'timeout',
  'bad_response',
  'model_unavailable',
  'unauthorized',
]);
/** Below this much time left, the fallback is not tried (it could not answer in time). */
const FALLBACK_MIN_MS = 3_000;
/** After the fallback was unreachable or timed out, it is skipped for this long (per process). */
export const FALLBACK_BREAKER_MS = 60_000;
/** The share of the time left that the fallback may use, so a hanging one never eats the run. */
const FALLBACK_TIME_SHARE = 0.5;

/**
 * The primary adapter, and once on failure the fallback (the self-hosted endpoint). The
 * public model and label stay those of the primary. A fallback that is still starting counts as
 * unreachable: nothing waits for a cold endpoint here.
 */
export class FallbackAdapter implements ModelAdapter {
  constructor(
    private readonly primary: ModelAdapter,
    private readonly fallback: ModelAdapter,
    private readonly clock: () => number = Date.now,
  ) {}
  get model(): string {
    return this.primary.model;
  }
  /** The primary's pricing: the reservation covers the primary's (per-token) worst case. */
  get pricing(): ModelAdapter['pricing'] {
    return this.primary.pricing;
  }
  /** A step may be answered by the GPU-priced fallback: reservations cover both worst cases. */
  readonly fallbackPricing = 'gpu' as const;
  /** When the fallback last failed as unreachable or timed out (the circuit breaker). */
  private fallbackDownAt = -Infinity;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = this.clock();
    try {
      return await this.primary.complete(request);
    } catch (error) {
      if (!(error instanceof AdapterError) || !FALLBACK_ON.has(error.code)) throw error;
      // The fallback was down a moment ago: do not spend this run's time on it again.
      if (this.clock() - this.fallbackDownAt < FALLBACK_BREAKER_MS) throw error;
      const left =
        request.timeoutMs === undefined ? undefined : request.timeoutMs - (this.clock() - started);
      if (left !== undefined && left < FALLBACK_MIN_MS) throw error;
      const timeoutMs =
        left === undefined ? undefined : Math.max(FALLBACK_MIN_MS, left * FALLBACK_TIME_SHARE);
      try {
        const answer = await this.fallback.complete({
          ...request,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        // A fallback answer is priced by GPU-seconds (self-hosted), never at the primary's rates.
        return { ...answer, model: this.primary.model, pricing: 'gpu' };
      } catch (second) {
        const fallbackCode: AdapterErrorCode =
          second instanceof AdapterError && second.code !== 'waking' ? second.code : 'unreachable';
        if (fallbackCode === 'unreachable' || fallbackCode === 'timeout')
          this.fallbackDownAt = this.clock();
        // The primary's code stays the cause (e.g. overloaded); the fallback's travels with it.
        throw new AdapterError(
          error.code,
          error.sent || (second instanceof AdapterError && second.sent),
          { ...error.detail, fallbackCode },
        );
      }
    }
  }
}

/** A refused key alerts ops at most once per this window (per process). */
export const KEY_ALERT_EVERY_MS = 15 * 60_000;

/**
 * A refused provider key (401/403) is never silent: a structured log line and a POST to
 * CITY_OPS_ALERT_WEBHOOK when set, then the call falls back as usual. Throttled; never throws;
 * the text names no key, owner or room.
 */
export function keyRefusedAlert(
  env: Env,
  options: {
    transport?: WebhookTransport;
    log?: (line: string) => void;
    clock?: () => number;
    fallback: boolean;
  },
): () => void {
  const log = options.log ?? ((line: string) => console.warn(line));
  const clock = options.clock ?? Date.now;
  const transport = options.transport ?? httpsWebhookTransport;
  let last = -Infinity;
  return () => {
    const now = clock();
    if (now - last < KEY_ALERT_EVERY_MS) return;
    last = now;
    const text = options.fallback
      ? 'Elric: the model provider refused the key (401/403). Replies are coming from the fallback model until it is fixed.'
      : 'Elric: the model provider refused the key (401/403). Elric cannot answer until it is fixed.';
    log(JSON.stringify({ event: 'elric_provider_key_refused', fallback: options.fallback }));
    const url = env.CITY_OPS_ALERT_WEBHOOK;
    if (!url) return;
    void transport(
      url,
      JSON.stringify({ text, event: 'elric_provider_key_refused' }),
      { 'content-type': 'application/json' },
      5_000,
    )
      .then(({ status }) => {
        if (status < 200 || status >= 300)
          log(JSON.stringify({ event: 'elric_provider_alert_failed', status }));
      })
      .catch(() => log(JSON.stringify({ event: 'elric_provider_alert_failed' })));
  };
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const KEY = /^[\x21-\x7e]{8,512}$/;

/** True when CITY_ELRIC_PROVIDER selects the hosted provider; any other value but openai fails. */
export function elricAnthropicSelected(env: Env = process.env): boolean {
  const provider = env.CITY_ELRIC_PROVIDER;
  if (provider === undefined || provider === '' || provider === 'openai') return false;
  if (provider === 'anthropic') return true;
  throw new Error('CITY_ELRIC_PROVIDER must be anthropic or openai.');
}

/**
 * The hosted-provider wiring (CITY_ELRIC_PROVIDER):
 * - `CITY_ELRIC_ANTHROPIC_KEY` (secret, required);
 * - `CITY_ELRIC_T1_MODEL` (the model id lives only in the environment; unset, every call is
 *   `model_unavailable`) and
 *   `CITY_ELRIC_T2_MODEL` (optional, defaults to the Tier 1 model);
 * - `CITY_ELRIC_FALLBACK_URL` + `CITY_ELRIC_FALLBACK_MODEL` (optional, the self-hosted
 *   endpoint; `CITY_ELRIC_MODEL_KEY` is its bearer, as before).
 * `adapters` stays empty: there is no health probe for a hosted API.
 */
export function elricAnthropicModels(
  env: Env = process.env,
  options: {
    fetch?: FetchLike;
    hosted?: boolean;
    allowLoopback?: boolean;
    alertTransport?: WebhookTransport;
    log?: (line: string) => void;
  } = {},
): { adapterFor(tier: 1 | 2): ModelAdapter; adapters: Record<string, never> } {
  const key = env.CITY_ELRIC_ANTHROPIC_KEY;
  // Never echo the value.
  if (!key)
    throw new Error('CITY_ELRIC_ANTHROPIC_KEY is required with CITY_ELRIC_PROVIDER=anthropic.');
  if (!KEY.test(key)) throw new Error('CITY_ELRIC_ANTHROPIC_KEY is not a valid key value.');
  const fallbackUrl = env.CITY_ELRIC_FALLBACK_URL;
  const fallbackModel = env.CITY_ELRIC_FALLBACK_MODEL;
  if (Boolean(fallbackUrl) !== Boolean(fallbackModel))
    throw new Error('CITY_ELRIC_FALLBACK_URL and CITY_ELRIC_FALLBACK_MODEL must be set together.');
  if (fallbackModel && !MODEL_NAME.test(fallbackModel))
    throw new Error('CITY_ELRIC_FALLBACK_MODEL is not a model name.');
  const fallbackKey = env.CITY_ELRIC_MODEL_KEY || undefined;
  if (fallbackKey && !KEY.test(fallbackKey))
    throw new Error('CITY_ELRIC_MODEL_KEY is not a valid bearer value.');
  const hostedRule = loopbackAllowed(env, options.hosted);
  // On a deployment the fallback is https to a public host, whatever a caller passes.
  const loopback = hostedRule ? (options.allowLoopback ?? true) : false;
  if (fallbackUrl) checkBaseUrl(fallbackUrl, loopback);
  const fallback =
    fallbackUrl && fallbackModel
      ? new OpenAICompatibleAdapter({
          baseUrl: fallbackUrl,
          model: fallbackModel,
          timeoutMs: TIER_TIMEOUT_MS,
          allowLoopback: loopback,
          ...(fallbackKey ? { apiKey: fallbackKey } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : null;
  const onUnauthorized = keyRefusedAlert(env, {
    fallback: fallback !== null,
    ...(options.alertTransport ? { transport: options.alertTransport } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const tiers = {} as Record<1 | 2, ModelAdapter>;
  for (const tier of [1, 2] as const) {
    const model = env[`CITY_ELRIC_T${tier}_MODEL`] || (tier === 2 ? env.CITY_ELRIC_T1_MODEL : '');
    // No model configured: this tier answers model_unavailable (never a startup failure).
    if (!model) {
      tiers[tier] = unavailableAdapter('unconfigured');
      continue;
    }
    if (!MODEL_NAME.test(model)) throw new Error(`CITY_ELRIC_T${tier}_MODEL is not a model name.`);
    const primary = new AnthropicAdapter({
      apiKey: key,
      model,
      maxTokens: ELRIC_ANTHROPIC_MAX_TOKENS[tier],
      timeoutMs: TIER_TIMEOUT_MS,
      onUnauthorized,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    tiers[tier] = fallback ? new FallbackAdapter(primary, fallback) : primary;
  }
  return { adapters: {}, adapterFor: (tier) => tiers[tier] };
}
