import {
  elricHosted,
  MockAdapter,
  OpenAICompatibleAdapter,
  checkBaseUrl,
  loopbackAllowed,
  unavailableAdapter,
  type FetchLike,
  type ModelAdapter,
} from './adapter.js';
import { ELRIC_CONFIG } from './config.js';
import { TITLE_SYSTEM_PROMPT } from './titles.js';
import { elricAnthropicModels, elricAnthropicSelected } from './anthropic.js';

/**
 * Elric's self-hosted model endpoints (docs/ELRIC_MODEL.md), one per router tier, from the
 * environment (names only, values from the secret store):
 *
 * - `CITY_ELRIC_T1_URL`, `CITY_ELRIC_T1_MODEL`: Tier 1 (the small model, short answers);
 * - `CITY_ELRIC_T2_URL`, `CITY_ELRIC_T2_MODEL`: Tier 2 (the large model, summaries and tools);
 * - `CITY_ELRIC_MODEL_KEY` (optional): a static bearer for the platform's own endpoints. It is
 *   sent only to them, never logged, never returned and never part of a prompt.
 *
 * URLs are https (http only to loopback, and loopback only off a deployment), without
 * credentials, query or fragment; a literal IP must be public. An invalid value fails startup.
 * Nothing configured: the default stays (every model call is `model_unavailable`).
 */
export type ElricTierNumber = 1 | 2;

export interface ElricEndpoint {
  tier: ElricTierNumber;
  baseUrl: string;
  model: string;
  /** Total time of one call on this tier (the large model generates more slowly). */
  timeoutMs: number;
}

/**
 * Per-tier total timeouts (connection to last byte; no streaming). 45 s on both tiers: a full
 * 600-token answer on a 24 GB L4 takes about 35 s at the measured single-stream speed. Each step
 * rechecks (and renews the lease) before its call, so the lease covers one step, not the run.
 */
export const ELRIC_TIER_TIMEOUT_MS: Record<ElricTierNumber, number> = { 1: 45_000, 2: 45_000 };

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const KEY = /^[\x21-\x7e]{8,512}$/;

type Env = Record<string, string | undefined>;

/** The configured endpoints; a tier with neither variable set is absent. */
export function elricEndpoints(
  env: Env = process.env,
  hosted = false,
): Partial<Record<ElricTierNumber, ElricEndpoint>> {
  const out: Partial<Record<ElricTierNumber, ElricEndpoint>> = {};
  // A hosted provider (anthropic.ts): the tier models are its ids, from the environment; no URLs.
  if (elricAnthropicSelected(env)) return out;
  for (const tier of [1, 2] as const) {
    const url = env[`CITY_ELRIC_T${tier}_URL`];
    const model = env[`CITY_ELRIC_T${tier}_MODEL`];
    if (!url && !model) continue;
    if (!url || !model)
      throw new Error(
        `CITY_ELRIC_T${tier}_URL and CITY_ELRIC_T${tier}_MODEL must be set together.`,
      );
    if (!MODEL_NAME.test(model)) throw new Error(`CITY_ELRIC_T${tier}_MODEL is not a model name.`);
    // Throws (without echoing the value) on anything but https / loopback-in-development.
    checkBaseUrl(url, loopbackAllowed(env, hosted));
    out[tier] = { tier, baseUrl: url, model, timeoutMs: ELRIC_TIER_TIMEOUT_MS[tier] };
  }
  return out;
}

/** The optional bearer for the platform's own endpoints. */
function modelKey(env: Env): string | undefined {
  const key = env.CITY_ELRIC_MODEL_KEY;
  if (key === undefined || key === '') return undefined;
  if (!KEY.test(key)) throw new Error('CITY_ELRIC_MODEL_KEY is not a valid bearer value.');
  return key;
}

export interface ElricModelWiring {
  adapterFor(tier: ElricTierNumber): ModelAdapter;
  /** The self-hosted adapters per configured tier (the health probe uses them). */
  adapters: Partial<Record<ElricTierNumber, OpenAICompatibleAdapter>>;
}

/**
 * The adapters for the configured endpoints, or null when none is configured. A tier without an
 * endpoint answers `model_unavailable`. `fetch` and `allowLoopback` are for tests only.
 */
export function elricModels(
  env: Env = process.env,
  options: {
    fetch?: FetchLike;
    allowLoopback?: boolean;
    connectTimeoutMs?: number;
    /** The app runs with a hosted configuration (loopback is then refused like on Vercel). */
    hosted?: boolean;
    /** Where an invalid Elric configuration is reported (default console.error). */
    log?: (line: string) => void;
  } = {},
): ElricModelWiring | null {
  // Elric's hosted-provider configuration never stops the app: a missing or malformed value
  // makes every Elric call model_unavailable and leaves one ops log line (no values in it).
  try {
    if (elricAnthropicSelected(env)) return elricAnthropicModels(env, options);
  } catch (error) {
    (options.log ?? ((line: string) => console.error(line)))(
      JSON.stringify({
        event: 'elric_config_invalid',
        reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      }),
    );
    return { adapters: {}, adapterFor: (tier) => unavailableAdapter(ELRIC_CONFIG.models[tier]) };
  }
  const endpoints = elricEndpoints(env, options.hosted);
  if (!endpoints[1] && !endpoints[2]) return null;
  const apiKey = modelKey(env);
  const adapters: Partial<Record<ElricTierNumber, OpenAICompatibleAdapter>> = {};
  for (const tier of [1, 2] as const) {
    const endpoint = endpoints[tier];
    if (!endpoint) continue;
    adapters[tier] = new OpenAICompatibleAdapter({
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      timeoutMs: endpoint.timeoutMs,
      allowLoopback: options.allowLoopback ?? loopbackAllowed(env, options.hosted),
      ...(apiKey ? { apiKey } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
    });
  }
  return {
    adapters,
    adapterFor: (tier) => adapters[tier] ?? unavailableAdapter(ELRIC_CONFIG.models[tier]),
  };
}

/**
 * Test-only: `CITY_ELRIC_MOCK=1` runs Elric on the deterministic MockAdapter (the end-to-end
 * suite's local server). Refused at startup on a hosted deployment (`VERCEL`, `CITY_HOSTED`, or a
 * hosted configuration) and with NODE_ENV=production: a real deployment never answers from it.
 */
export function elricMockModels(env: Env = process.env, hosted = false): ElricModelWiring | null {
  if (env.CITY_ELRIC_MOCK !== '1') return null;
  if (elricHosted(env, hosted))
    throw new Error('CITY_ELRIC_MOCK is for local tests only; it is refused on a deployment.');
  const mocks = {
    1: e2eMockAdapter(ELRIC_CONFIG.models[1]),
    2: e2eMockAdapter(ELRIC_CONFIG.models[2]),
  };
  return { adapters: {}, adapterFor: (tier) => mocks[tier] };
}

/**
 * The CITY_ELRIC_MOCK model, deterministic: when the owner's message (the trigger) says
 * "create a task: <title>" and room_task_create is offered, the first step asks for
 * room_task_create {room_id: <the invoking room>, title: <title>}; every other step, including
 * the one after the tool result, answers "Mock reply.". A conversation-title call (titles.ts)
 * answers the user's words in sentence case: only the first letter is raised, the rest stays as
 * written ("which phone is better, iPhone 12 or 16?" -> "Which phone is better, iPhone 12 or 16?").
 */
export function e2eMockAdapter(model: string): ModelAdapter {
  const inner = new MockAdapter(model);
  return {
    model,
    async complete(request) {
      if (request.system === TITLE_SYSTEM_PROMPT) {
        inner.push({ text: mockTitle(request.messages[0]?.content) });
        return inner.complete(request);
      }
      const offered = request.tools?.some((tool) => tool.name === 'room_task_create') ?? false;
      const answeredTool = request.messages.some((message) => message.role === 'tool');
      const prompt = request.messages.find((message) => message.role === 'user')?.content ?? '';
      const task = offered && !answeredTool ? taskRequest(prompt) : null;
      if (task)
        inner.push({ toolCalls: [{ name: 'room_task_create', args: task, id: 'call_task_0' }] });
      // "stream please": the answer arrives as a draft in three chunks, 400 ms apart (e2e).
      if (!task && request.onText && /stream please/i.test(triggerText(prompt) ?? '')) {
        let shown = '';
        for (const chunk of E2E_STREAM_CHUNKS) {
          shown += chunk;
          request.onText(shown);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        inner.push({ text: shown });
      }
      // "stream slowly": a model-like stream, a few words every 100 ms for about 4 s (e2e).
      if (!task && request.onText && /stream slowly/i.test(triggerText(prompt) ?? '')) {
        let shown = '';
        for (const chunk of E2E_SLOW_STREAM_CHUNKS) {
          shown += chunk;
          request.onText(shown);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        inner.push({ text: shown });
      }
      return inner.complete(request);
    },
  };
}

/** The CITY_ELRIC_MOCK title: the user's words of the title request, in sentence case. */
function mockTitle(content: unknown): string {
  try {
    const data = JSON.parse(String(content).split('\n')[1] ?? '') as { user?: unknown };
    return String(data.user ?? '').replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
  } catch {
    return '';
  }
}

/** The CITY_ELRIC_MOCK streamed answer, in its three chunks. */
export const E2E_STREAM_CHUNKS = ['Streaming reply, ', 'part two, ', 'part three.'];

/** The CITY_ELRIC_MOCK slow answer ("stream slowly"): paragraphs and a list, in 40 chunks. */
export const E2E_SLOW_STREAM_TEXT =
  'Here is a calm answer that arrives a few words at a time, the way a real model writes. ' +
  'It keeps going for a while so the reveal can be measured.\n\n' +
  'A second paragraph follows, with **some bold words** and a short list:\n\n' +
  '- the first point\n- the second point\n- the third point, which ends the answer.';
export const E2E_SLOW_STREAM_CHUNKS: readonly string[] = (() => {
  const size = Math.ceil(E2E_SLOW_STREAM_TEXT.length / 40);
  const chunks: string[] = [];
  for (let i = 0; i < E2E_SLOW_STREAM_TEXT.length; i += size)
    chunks.push(E2E_SLOW_STREAM_TEXT.slice(i, i + size));
  return chunks;
})();

/** The text of the trigger message (the one Elric answers), or null. */
function triggerText(prompt: string): string | null {
  const lines = prompt.split('\n');
  const trigger = /message seq (\d+) \(from/.exec(lines.at(-1) ?? '')?.[1];
  if (!trigger) return null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const message = JSON.parse(line) as { seq?: unknown; text?: unknown };
      if (String(message.seq) === trigger && typeof message.text === 'string') return message.text;
    } catch {
      continue;
    }
  }
  return null;
}

/** {room_id, title} when the trigger message asks "create a task: <title>", else null. */
function taskRequest(prompt: string): { room_id: string; title: string } | null {
  const lines = prompt.split('\n');
  let roomId: string | null = null;
  try {
    const header = lines
      .map((line) => /^(?:Room|Chat) \(untrusted labels\): (.*)$/.exec(line)?.[1])
      .find((rest) => rest !== undefined);
    const parsed = header ? (JSON.parse(header) as { room_id?: unknown }) : null;
    roomId = typeof parsed?.room_id === 'string' ? parsed.room_id : null;
  } catch {
    roomId = null;
  }
  const trigger = /message seq (\d+) \(from/.exec(lines.at(-1) ?? '')?.[1];
  if (!roomId || !trigger) return null;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const message = JSON.parse(line) as { seq?: unknown; text?: unknown };
      if (String(message.seq) !== trigger || typeof message.text !== 'string') continue;
      const title = /create a task:\s*(.+)$/im.exec(message.text)?.[1]?.trim().slice(0, 200);
      return title ? { room_id: roomId, title } : null;
    } catch {
      continue;
    }
  }
  return null;
}
