/*
 * Client for the responder console routes (docs/RESPONDER.md). The key is sent once, in the body of
 * POST …/responder/key, and never stored, logged or read back: the caller clears its field.
 */
import type {
  ModelOption,
  Provider,
  ResponderKeyView,
  ResponderSettingsView,
  SettingsUpdate,
} from './contract';

export class ResponderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

/** Client-side limit for the key check (the server's provider call has its own 5 s timeout). */
export const KEY_CHECK_TIMEOUT_MS = 15_000;

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      signal: controller.signal,
      headers:
        init.body === undefined && (init.method ?? 'GET') === 'GET'
          ? {}
          : { 'Content-Type': 'application/json', 'X-City-Request': '1' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    throw new ResponderError(
      controller.signal.aborted ? 'timeout' : navigator.onLine === false ? 'offline' : 'network',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  const value = (await response.json().catch(() => null)) as
    (T & { code?: unknown; error?: unknown }) | null;
  if (!response.ok)
    throw new ResponderError(
      typeof value?.code === 'string' ? value.code : response.status === 429 ? 'rate_limited' : '',
      response.status,
    );
  return value as T;
}

/**
 * Whether this server offers auto-reply: the routes exist only with CITY_RESPONDER=1 (404
 * otherwise), and answer 503 responder_unavailable when the root key is missing. Anything but a
 * successful model list hides the feature.
 */
export async function loadModels(): Promise<ModelOption[] | null> {
  try {
    return (await call<{ models: ModelOption[] }>('/api/responder/models')).models;
  } catch {
    return null;
  }
}

export const getSettings = (agentId: string) =>
  call<ResponderSettingsView>(`/api/agents/${encodeURIComponent(agentId)}/responder`);

export const updateSettings = (agentId: string, body: SettingsUpdate) =>
  call<ResponderSettingsView>(`/api/agents/${encodeURIComponent(agentId)}/responder`, {
    method: 'PUT',
    body,
  });

export const saveKey = (
  agentId: string,
  body: { provider: Provider; model: string; key: string },
) =>
  call<{ key: ResponderKeyView }>(`/api/agents/${encodeURIComponent(agentId)}/responder/key`, {
    body,
    timeoutMs: KEY_CHECK_TIMEOUT_MS,
  });

export const removeKey = (agentId: string) =>
  call<{ agent_id: string; removed: boolean }>(
    `/api/agents/${encodeURIComponent(agentId)}/responder/key`,
    { method: 'DELETE' },
  );

/**
 * The requests the setup sheet sends (AutoReplySheet). A failure is a ResponderError, so the sheet
 * reads only its code. This client sends them as they are; the v4 Auto-reply screen has its own,
 * bound to the agent and workspace it shows (src/agents/v4/settingsRequests.ts).
 */
export interface ResponderClient {
  saveKey: typeof saveKey;
  updateSettings: typeof updateSettings;
}
export const responderClient: ResponderClient = { saveKey, updateSettings };
