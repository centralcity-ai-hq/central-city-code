import { safeNext } from '../rooms/pendingJoin';
import { INVITE_ROOMS_PATH } from './navigation';

/** Preview-only default landing. Explicit routes and fragments keep their existing handlers. */
export function workspaceLanding(input: {
  enabled: boolean;
  consoleEntry?: boolean;
  signedIn: boolean;
  onboarding: boolean;
  pathname: string;
  search: string;
  hash: string;
  pendingJoin: string | null;
}): string | null {
  if (
    !input.enabled ||
    input.consoleEntry ||
    !input.signedIn ||
    input.onboarding ||
    !['/', '/index.html'].includes(input.pathname) ||
    input.hash
  )
    return null;
  const next = new URLSearchParams(input.search).get('next');
  if (next === '/invite') return INVITE_ROOMS_PATH;
  if (next && safeNext(next) === next) return next;
  return input.pendingJoin ?? '/rooms';
}
