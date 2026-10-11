/**
 * Elric's ModelAdapter (docs/ELRIC.md). The platform, not the model, holds every credential: the
 * adapter receives only the prompt, the tool schemas and a token cap, and returns text or tool
 * *requests*. The server decides what runs.
 *
 * - `MockAdapter`: deterministic and scriptable (tests; the only adapter wired in this slice).
 * - `OpenAICompatibleAdapter`: a self-hosted OpenAI-compatible endpoint (POST /v1/chat/completions,
 *   no streaming). Fixed base URL from configuration (endpoints.ts), no SDK, no redirects, a
 *   connect timeout and a total timeout, a request and a response size cap, and every failure
 *   reduced to a fixed code: provider text is never returned. A 503, or a connection that cannot
 *   be opened, is `waking` (an endpoint scaling from zero); the service waits and retries.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicAddress, publicLookup } from '../oauth/clients.js';

export interface ElricToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}
export interface ElricToolCall {
  id: string;
  name: string;
  /** Parsed arguments; null when the model sent something that is not a JSON object. */
  args: Record<string, unknown> | null;
}
/**
 * A provider's thinking block, kept opaque and unchanged: it goes back to the same provider on the
 * next step of the same run (the API requires it on tool turns) and is never posted, logged or
 * stored.
 */
export type ElricThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };
export type ElricMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: ElricToolCall[];
      thinking?: ElricThinkingBlock[];
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ModelRequest {
  system: string;
  messages: ElricMessage[];
  tools?: ElricToolSpec[];
  maxOutputTokens: number;
  /** Extended thinking for this run (providers that support it; the others ignore it). */
  thinking?: boolean;
  /**
   * Streamed text: called with the answer text so far (never thinking) as it arrives, on
   * providers that stream; the others ignore it. The returned response is the full answer.
   */
  onText?: (text: string) => void;
  /** This call's total time limit (the service's remaining run budget); never above the tier's. */
  timeoutMs?: number;
}
export interface ModelResponse {
  text: string | null;
  /** Thinking blocks of this answer (never shown): passed back with the tool results. */
  thinking?: ElricThinkingBlock[];
  toolCalls: ElricToolCall[];
  /** `reported: false` when the endpoint sent no usage counts (the service charges an estimate). */
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Per-token providers only (API cache_read_input_tokens / cache_creation_input_tokens). */
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reported?: boolean;
  };
  model: string;
  /**
   * How this answer is priced: 'anthropic' per token (token-cost.ts), 'gpu' (or omitted) by
   * GPU-seconds (self-hosted). Overrides the adapter's pricing (a fallback answer says 'gpu').
   */
  pricing?: 'anthropic' | 'gpu';
}
export interface ModelAdapter {
  readonly model: string;
  /**
   * 'anthropic': priced per token (token-cost.ts); the reservation and the pre-call estimate use
   * the per-token worst case. Omitted: GPU-second costing (self-hosted).
   */
  readonly pricing?: 'anthropic';
  /**
   * The pricing of a configured fallback that may answer a step instead ('gpu': the self-hosted
   * endpoint). The reservation and the estimate then cover the larger of the two worst cases.
   */
  readonly fallbackPricing?: 'gpu';
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export type AdapterErrorCode =
  | 'timeout'
  | 'unreachable'
  | 'rate_limited'
  | 'server_error'
  | 'unauthorized'
  | 'model_unavailable'
  | 'too_large'
  | 'bad_request'
  | 'bad_response'
  /** The endpoint is starting (scale from zero): retry after a short wait. */
  | 'waking';

/**
 * The only error an adapter throws: a fixed code, never provider text. `sent`: the request reached
 * the model server (it may have spent GPU time), so the service counts the step's estimate;
 * false for failures before anything was sent (refused or unopened connection, waking, a request
 * over the cap).
 */
export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    public readonly sent = false,
    public readonly detail: {
      /** When the fallback endpoint was tried and failed too: its code (`code` is the primary's). */
      fallbackCode?: AdapterErrorCode;
      /** A 429's Retry-After, in milliseconds. */
      retryAfterMs?: number;
    } = {},
  ) {
    super(`model_${code}`);
  }
}

/** The default when no model endpoint is configured: every call is `model_unavailable`. */
export function unavailableAdapter(model: string): ModelAdapter {
  return {
    model,
    complete: async () => {
      throw new AdapterError('model_unavailable');
    },
  };
}

/** One scripted step: a reply, tool requests, an error, or a function of the request. */
export type MockStep =
  | { text: string; usage?: Partial<ModelResponse['usage']> }
  | { toolCalls: Array<{ name: string; args: Record<string, unknown> | null; id?: string }> }
  | { error: AdapterErrorCode }
  | ((request: ModelRequest) => MockStep | Promise<MockStep>);

/**
 * Deterministic adapter for tests. Every request is recorded (`requests`) so tests assert on what
 * the model RECEIVED. Unscripted calls answer a fixed text. `beforeReply` runs inside the call
 * (e.g. to pause Elric while a call is in flight).
 */
export class MockAdapter implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private readonly script: MockStep[] = [];
  beforeReply?: (request: ModelRequest, index: number) => void | Promise<void>;
  constructor(
    readonly model = 'mock-model',
    private readonly fallback = 'Mock reply.',
  ) {}
  /** Appends steps to the script (consumed in order). */
  push(...steps: MockStep[]): this {
    this.script.push(...steps);
    return this;
  }
  get calls(): number {
    return this.requests.length;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    // A deep copy: later mutation of the caller's arrays never rewrites what was received.
    this.requests.push(JSON.parse(JSON.stringify(request)) as ModelRequest);
    const index = this.requests.length - 1;
    await this.beforeReply?.(request, index);
    let step: MockStep = this.script.shift() ?? { text: this.fallback };
    while (typeof step === 'function') step = await step(request);
    const inputTokens = Math.ceil(
      (request.system.length + JSON.stringify(request.messages).length) / 4,
    );
    if ('error' in step) throw new AdapterError(step.error);
    if ('toolCalls' in step)
      return {
        text: null,
        toolCalls: step.toolCalls.map((call, n) => ({
          id: call.id ?? `call_${index}_${n}`,
          name: call.name,
          args: call.args,
        })),
        usage: { inputTokens, outputTokens: 20 },
        model: this.model,
      };
    return {
      text: step.text,
      toolCalls: [],
      usage: {
        inputTokens: step.usage?.inputTokens ?? inputTokens,
        outputTokens: step.usage?.outputTokens ?? Math.ceil(step.text.length / 4),
        ...(step.usage?.cacheReadInputTokens !== undefined
          ? { cacheReadInputTokens: step.usage.cacheReadInputTokens }
          : {}),
        ...(step.usage?.cacheCreationInputTokens !== undefined
          ? { cacheCreationInputTokens: step.usage.cacheCreationInputTokens }
          : {}),
      },
      model: this.model,
    };
  }
}

export type FetchLike = (
  url: string,
  init: {
    method: 'POST' | 'GET';
    headers: Record<string, string>;
    body?: string;
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text?: () => Promise<string>;
}>;

export const OPENAI_COMPATIBLE_LIMITS = {
  /** Total time of one call, connection to last byte (no streaming: the body comes at the end). */
  timeoutMs: 20_000,
  /** Time to open the connection (TCP, and TLS for https). Longer is treated as `waking`. */
  connectTimeoutMs: 5_000,
  /** Total time of a health probe (GET /v1/models). */
  probeTimeoutMs: 5_000,
  /** Largest response body read (bytes). */
  maxResponseBytes: 1_000_000,
  /** Largest request body sent (bytes). */
  maxRequestBytes: 512_000,
} as const;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.includes(hostname);

/**
 * One rule for "this is a deployment" (Vercel, a hosted configuration, CITY_HOSTED, or
 * NODE_ENV=production), shared by the loopback rule and the test-only mock switch.
 */
export function elricHosted(
  env: Record<string, string | undefined> = process.env,
  hosted = false,
): boolean {
  return hosted || env.VERCEL === '1' || env.CITY_HOSTED === '1' || env.NODE_ENV === 'production';
}

/** Loopback endpoints (a local model server) are for development only, never on a deployment. */
export function loopbackAllowed(
  env: Record<string, string | undefined> = process.env,
  hosted = false,
): boolean {
  return !elricHosted(env, hosted);
}

/**
 * Only https, or http to a loopback host (a local model server during development; never on a
 * deployment). No credentials, query or fragment. A literal IP must be public (loopback aside).
 */
export function checkBaseUrl(raw: string, allowLoopback = loopbackAllowed()): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Elric model endpoint is not a valid URL.');
  }
  const loopback = isLoopbackHost(url.hostname);
  if (loopback && !allowLoopback)
    throw new Error('Elric model endpoint must not be a loopback host on a deployment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Elric model endpoint must use https (http only on loopback).');
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (!loopback && isIP(bare) && !isPublicAddress(bare))
    throw new Error('Elric model endpoint must be a public address.');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Elric model endpoint must not carry credentials, a query or a fragment.');
  return url;
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

function codeForStatus(status: number): AdapterErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'model_unavailable';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  // Scale-from-zero gateways answer 503 while the model server starts.
  if (status === 503) return 'waking';
  if (status >= 500) return 'server_error';
  return 'bad_request';
}

/**
 * The production transport (node:http/https, like the other outbound clients): no connection
 * reuse, no redirects followed, https hosts resolved through publicLookup (public addresses only,
 * checked at connection time), http only to loopback when allowed. A connection that is refused
 * or not open within `connectTimeoutMs` rejects with AdapterError('waking'); DNS and address
 * refusals with 'unreachable'. The caller's signal bounds the whole call.
 */
export function elricTransport(
  options: { connectTimeoutMs?: number; allowLoopback?: boolean } = {},
): FetchLike {
  const connectTimeoutMs = options.connectTimeoutMs ?? OPENAI_COMPATIBLE_LIMITS.connectTimeoutMs;
  return (raw, init) =>
    new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = checkBaseUrl(raw, options.allowLoopback ?? loopbackAllowed());
      } catch {
        return reject(new AdapterError('unreachable'));
      }
      const loopback = isLoopbackHost(url.hostname);
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      let settled = false;
      let responded = false;
      /** The whole request was handed to the connection: the server may be working on it. */
      let written = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        action();
      };
      const req = send(
        url,
        {
          method: init.method,
          headers: {
            ...init.headers,
            ...(init.body === undefined ? {} : { 'content-length': Buffer.byteLength(init.body) }),
          },
          agent: false,
          ...(loopback ? {} : { lookup: publicLookup as never }),
        },
        (res: IncomingMessage) => {
          responded = true;
          settle(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: {
                get: (name: string) => {
                  const value = res.headers[name.toLowerCase()];
                  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
                },
              },
              body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
            }),
          );
        },
      );
      // Connect timeout: cleared once the connection (and TLS) is open.
      const connectTimer = setTimeout(() => {
        req.destroy();
        settle(() => reject(new AdapterError('waking')));
      }, connectTimeoutMs);
      req.on('socket', (socket) => {
        const opened = () => clearTimeout(connectTimer);
        if (!socket.connecting) return opened();
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', opened);
      });
      const abort = () => {
        req.destroy();
        settle(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError', written })));
      };
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
      req.on('error', (error: NodeJS.ErrnoException) =>
        settle(() => {
          if (init.signal.aborted)
            return reject(Object.assign(new Error('aborted'), { name: 'AbortError', written }));
          // Sent and then dropped before an answer: the server may have worked on it.
          if (written && !responded) return reject(new AdapterError('server_error', true));
          const refused = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE'];
          reject(
            new AdapterError(
              !responded && refused.includes(error.code ?? '') ? 'waking' : 'unreachable',
            ),
          );
        }),
      );
      req.on('finish', () => {
        written = true;
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}

function toWire(request: ModelRequest, model: string) {
  const messages: unknown[] = [{ role: 'system', content: request.system }];
  for (const message of request.messages) {
    if (message.role === 'user') messages.push({ role: 'user', content: message.content });
    else if (message.role === 'tool')
      messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    else
      messages.push({
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              })),
            }
          : {}),
      });
  }
  return {
    model,
    messages,
    max_tokens: request.maxOutputTokens,
    stream: false,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  };
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A self-hosted OpenAI-compatible endpoint. `apiKey` is an optional static bearer
 * for the platform's own endpoint (from the secret store); it is never logged, never returned
 * and never part of a prompt.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly endpoint: string;
  constructor(
    private readonly options: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      fetch?: FetchLike;
      timeoutMs?: number;
      connectTimeoutMs?: number;
      allowLoopback?: boolean;
    },
  ) {
    const base = checkBaseUrl(options.baseUrl, options.allowLoopback ?? loopbackAllowed());
    const root = base.href.endsWith('/') ? base : `${base.href}/`;
    this.endpoint = new URL('v1/chat/completions', root).href;
    this.modelsEndpoint = new URL('v1/models', root).href;
    this.fetcher =
      options.fetch ??
      elricTransport({
        ...(options.connectTimeoutMs === undefined
          ? {}
          : { connectTimeoutMs: options.connectTimeoutMs }),
        ...(options.allowLoopback === undefined ? {} : { allowLoopback: options.allowLoopback }),
      });
  }
  private readonly modelsEndpoint: string;
  private readonly fetcher: FetchLike;
  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }
  /**
   * Health probe: GET /v1/models, no tokens spent. `ready` on 200, `waking` while the endpoint
   * starts (503, or the connection cannot be opened yet), `down` otherwise. Never throws; never
   * returns provider text.
   */
  async probe(timeoutMs = OPENAI_COMPATIBLE_LIMITS.probeTimeoutMs): Promise<{
    state: 'ready' | 'waking' | 'down';
    code?: AdapterErrorCode;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(this.modelsEndpoint, {
        method: 'GET',
        headers: this.headers(false),
        redirect: 'error',
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 200) return { state: 'ready' };
      const code =
        response.status >= 300 && response.status < 400
          ? 'bad_response'
          : codeForStatus(response.status);
      return { state: code === 'waking' ? 'waking' : 'down', code };
    } catch (error) {
      const code: AdapterErrorCode =
        error instanceof AdapterError
          ? error.code
          : controller.signal.aborted
            ? 'timeout'
            : 'unreachable';
      return { state: code === 'waking' ? 'waking' : 'down', code };
    } finally {
      clearTimeout(timer);
    }
  }
  get model(): string {
    return this.options.model;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body = JSON.stringify(toWire(request, this.options.model));
    if (Buffer.byteLength(body) > OPENAI_COMPATIBLE_LIMITS.maxRequestBytes)
      throw new AdapterError('too_large');
    const fetcher = this.fetcher;
    const controller = new AbortController();
    const tierTimeout = this.options.timeoutMs ?? OPENAI_COMPATIBLE_LIMITS.timeoutMs;
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(tierTimeout, request.timeoutMs ?? tierTimeout)),
    );
    let text: string | null;
    let status: number;
    try {
      const response = await fetcher(this.endpoint, {
        method: 'POST',
        headers: this.headers(true),
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      status = response.status;
      if (status !== 200) {
        // Drain (close) the unread body: with no connection reuse the socket would stay open.
        await response.body?.cancel().catch(() => {});
        if (status >= 300 && status < 400) throw new AdapterError('bad_response', true);
        const code = codeForStatus(status);
        // A 503 means the model server is still starting: nothing ran.
        throw new AdapterError(code, code !== 'waking');
      }
      text = await readCapped(response, OPENAI_COMPATIBLE_LIMITS.maxResponseBytes);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (controller.signal.aborted)
        throw new AdapterError('timeout', (error as { written?: boolean }).written ?? true);
      throw new AdapterError('unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (text === null) throw new AdapterError('too_large', true);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AdapterError('bad_response', true);
    }
    const choice = (json as { choices?: unknown[] })?.choices?.[0] as
      { message?: { content?: unknown; tool_calls?: unknown } } | undefined;
    const message = choice?.message;
    if (!message || typeof message !== 'object') throw new AdapterError('bad_response', true);
    const usage = (json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
      .usage;
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ElricToolCall[] = calls.slice(0, 16).map((raw, index) => {
      const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      return {
        id: typeof call.id === 'string' ? call.id.slice(0, 100) : `call_${index}`,
        name: typeof call.function?.name === 'string' ? call.function.name.slice(0, 100) : '',
        args: parseArgs(call.function?.arguments),
      };
    });
    const content = typeof message.content === 'string' ? message.content : null;
    if (content === null && !toolCalls.length) throw new AdapterError('bad_response', true);
    const model = (json as { model?: unknown }).model;
    return {
      text: content,
      toolCalls,
      usage: {
        inputTokens: count(usage?.prompt_tokens),
        outputTokens: count(usage?.completion_tokens),
        reported:
          typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number',
      },
      model: typeof model === 'string' ? model.slice(0, 100) : this.options.model,
    };
  }
}
