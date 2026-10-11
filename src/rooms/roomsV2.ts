/**
 * Smart Rooms v2 is the only rooms design. The legacy rooms UI is no longer reachable:
 * `?rooms=v1` and a stored opt-out (localStorage `cc-rooms-v2`) are ignored.
 * isRoomsV2() and useRoomsV2() always return true; the legacy branches they guard are dead code
 * until they are removed. The rooms app root still carries data-rooms="v2" (rooms.css scopes the
 * v2 tokens to it).
 * A leftover `?rooms=` parameter is still removed from the address, so old links stay clean.
 */

export const ROOMS_V2_PARAM = 'rooms';

/** The query string without the old flag parameter ("" when nothing else is left). */
export function withoutRoomsV2Param(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(ROOMS_V2_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

function dropParam() {
  if (typeof window === 'undefined') return;
  try {
    const { pathname, search, hash } = window.location;
    if (!new URLSearchParams(search).has(ROOMS_V2_PARAM)) return;
    const next = withoutRoomsV2Param(search);
    window.history.replaceState(window.history.state, '', `${pathname}${next}${hash}`);
  } catch {
    // History is unavailable: the parameter just stays in the address.
  }
}

/** Always true: Smart Rooms v2 is the only design. */
export function isRoomsV2(): boolean {
  dropParam();
  return true;
}

/** React hook kept for the call sites; always true. */
export function useRoomsV2(): boolean {
  return isRoomsV2();
}
