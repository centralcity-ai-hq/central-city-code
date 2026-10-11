/**
 * Workspace v2 is the only workspace design. The classic workspace is no longer reachable:
 * `?workspace=v1` and a stored opt-out (localStorage `cc-workspace-v2`) are ignored.
 * isWorkspaceV2() and useWorkspaceV2() always return true; the classic branches they guard are
 * dead code until they are removed.
 * A leftover `?workspace=` parameter is still removed from the address, so old links stay clean.
 */

export const WORKSPACE_V2_PARAM = 'workspace';

/** The query string without the old flag parameter ("" when nothing else is left). */
export function withoutWorkspaceV2Param(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(WORKSPACE_V2_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

function dropParam() {
  if (typeof window === 'undefined') return;
  try {
    const { pathname, search, hash } = window.location;
    if (!new URLSearchParams(search).has(WORKSPACE_V2_PARAM)) return;
    const next = withoutWorkspaceV2Param(search);
    window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`);
  } catch {
    // History is unavailable: the parameter just stays in the address.
  }
}

/** Always true: Workspace v2 is the only design. */
export function isWorkspaceV2(): boolean {
  dropParam();
  return true;
}

/** React hook kept for the call sites; always true. */
export function useWorkspaceV2(): boolean {
  return isWorkspaceV2();
}
