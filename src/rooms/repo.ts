/*
 * The room's repository over the console REST routes (docs/ROOM_REPOS.md "Binding (console
 * only)"). The routes answer 404 when the server runs without CITY_ROOM_REPOS=1; the room then
 * shows no Code button. Repository names and the notice come from GitHub: untrusted text.
 */
import { selectedWorkspaceId } from '../api';

export type RepoBinding = {
  repo: string;
  default_branch: string;
  private: boolean;
  bound_at: string;
};
export type RepoState = { binding: RepoBinding | null; head_sha: string | null };
export type RepoPreview = {
  repo: string;
  default_branch: string;
  private: boolean;
  notice: string;
  confirm_repo: string;
};

/** A refused call, with the server's code kept for plain copy (never shown as is). */
export class RepoError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/repo`;

async function call<T>(url: string, body?: unknown): Promise<T> {
  let response: Response;
  // The workspace the person acts in, as api() sends it (a co-owned AI workspace's room).
  const selected = selectedWorkspaceId();
  const workspace: Record<string, string> = selected ? { 'X-City-Workspace': selected } : {};
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers:
        body === undefined
          ? workspace
          : { 'Content-Type': 'application/json', 'X-City-Request': '1', ...workspace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RepoError(0, 'unreachable');
  }
  const value = (await response.json().catch(() => null)) as
    (T & { error?: unknown; code?: unknown }) | null;
  if (!response.ok) {
    const code =
      typeof value?.code === 'string'
        ? value.code
        : typeof value?.error === 'string' && /^[a-z_]+$/.test(value.error)
          ? value.error
          : '';
    throw new RepoError(response.status, code);
  }
  return value as T;
}

/** The room's repository, or null when this server has no room repositories (404). */
export async function getRepo(roomId: string): Promise<RepoState | null> {
  try {
    const value = await call<RepoState | { available: false }>(base(roomId));
    // Room repositories are off on this server.
    return 'available' in value && value.available === false ? null : (value as RepoState);
  } catch (error) {
    if (error instanceof RepoError && error.status === 404 && error.code !== 'room_not_found')
      return null;
    throw error;
  }
}

export const previewRepo = (roomId: string, repo: string) =>
  call<RepoPreview>(`${base(roomId)}/preview`, { repo });

export const connectRepo = (roomId: string, repo: string, confirm: string) =>
  call<{ binding: RepoBinding }>(base(roomId), {
    repo,
    acknowledge_member_read: true,
    confirm_repo: confirm,
  });

export const disconnectRepo = (roomId: string) =>
  call<{ unbound: boolean }>(`${base(roomId)}/disconnect`, {});

/** Plain copy for every refusal (docs/COPY_GLOSSARY.md: no codes on screen). */
export function repoErrorText(error: unknown): string {
  if (!(error instanceof RepoError)) return 'Something went wrong. Try again.';
  if (error.status === 0) return "We couldn't reach Central City. Try again.";
  if (error.code === 'confirmation_mismatch')
    return 'Type the repository name exactly as shown to confirm.';
  if (error.code === 'repo_already_bound')
    return 'This room already has a repository. Disconnect it first.';
  if (error.code === 'room_closed') return 'This room is closed.';
  if (error.status === 404)
    return "This repository isn't available. Check the name, and that the Central City GitHub app is installed on it for your account.";
  if (error.status === 403) return 'Only the room host can connect or disconnect a repository.';
  if (error.status === 429) return 'Too many tries. Wait a few minutes and try again.';
  if (error.status === 400) return 'Enter the repository as owner/name, for example acme/website.';
  return "We couldn't reach GitHub. Try again in a moment.";
}
