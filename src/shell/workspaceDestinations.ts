/** Console sections are local UI state, not URL routes. Keep that state per history entry. */
export const workspaceViews = [
  'network',
  'connect',
  'agents',
  'jobs',
  'connections',
  'activity',
  'data',
  'collaborations',
  'messages',
  'assistants',
  'elric',
] as const;
export type WorkspaceView = (typeof workspaceViews)[number];

export function workspaceView(state: unknown, workspaceId: string): WorkspaceView | null {
  if (!state || typeof state !== 'object') return null;
  const entry = state as { workspaceId?: unknown; workspaceView?: unknown };
  return entry.workspaceId === workspaceId &&
    workspaceViews.includes(entry.workspaceView as WorkspaceView)
    ? (entry.workspaceView as WorkspaceView)
    : null;
}

export function openWorkspaceView(view: WorkspaceView, workspaceId: string) {
  window.history.pushState({ workspaceView: view, workspaceId }, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
}
