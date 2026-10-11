import { plainApiMessage } from './ui/plainText';
import { parseRetryAfter } from './ui/errors';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The server's machine code (for call sites to branch on; never shown). */
    public code?: string,
    /** Machine-readable facts the server attached (for example a removal's reason). */
    public details?: unknown,
    /** The server's Retry-After (ms), when it sent one (for example a 429). */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * The AI-owned workspace the signed-in person is acting in (docs/AI_WORKSPACES.md), or null for
 * their own. Sent as X-City-Workspace; the server honors it only for workspaces they co-own.
 */
let selectedWorkspace: string | null = null;
export function selectWorkspace(id: string | null): void {
  selectedWorkspace = id;
}
export function selectedWorkspaceId(): string | null {
  return selectedWorkspace;
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<T> {
  return send<T>(selectedWorkspace, path, body, method, signal);
}

/**
 * api() in the workspace the caller names (null: the person's own), not whichever one is selected
 * when the request goes out. For reads whose answer must belong to the workspace they were asked
 * in: the caller captures the workspace when the read starts. `fetcher` stands in for fetch in tests.
 */
export function apiInWorkspace<T>(
  workspace: string | null,
  path: string,
  options: { body?: unknown; method?: string; signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<T> {
  const { body, method = 'POST', signal, fetcher } = options;
  return send<T>(workspace, path, body, method, signal, fetcher);
}

async function send<T>(
  workspaceId: string | null,
  path: string,
  body: unknown,
  method: string,
  signal: AbortSignal | undefined,
  fetcher?: typeof fetch,
): Promise<T> {
  const workspace: Record<string, string> = workspaceId ? { 'X-City-Workspace': workspaceId } : {};
  const init: RequestInit = {
    method: body === undefined && method === 'POST' ? 'GET' : method,
    credentials: 'same-origin',
    headers:
      body === undefined
        ? workspace
        : { 'Content-Type': 'application/json', 'X-City-Request': '1', ...workspace },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  };
  const response = await (fetcher ? fetcher(path, init) : fetch(path, init));
  const value = (await response.json().catch(() => null)) as {
    error?: string;
    code?: unknown;
    details?: unknown;
  } | null;
  // People see plain sentences, never codes or developer wording (src/ui/plainText.ts).
  if (!response.ok)
    throw new ApiError(
      plainApiMessage(response.status, value),
      response.status,
      typeof value?.code === 'string' ? value.code : undefined,
      value?.details,
      parseRetryAfter(response.headers?.get?.('Retry-After') ?? undefined),
    );
  return value as T;
}
