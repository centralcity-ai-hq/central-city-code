/*
 * The server's clock as this browser can estimate it: each API answer's Date header (whole seconds)
 * against the device clock at the request's midpoint. Deadlines the server sets (a signing window's
 * expiresAt) are shown on this clock, so a device clock that runs fast or slow doesn't shorten or
 * stretch them. Only for display; every decision stays with the server.
 */
const MAX_OFFSET_MS = 6 * 3600 * 1000;
let offset = 0;

/** The device-clock offset implied by one answer, or null when the header can't be used. */
export function offsetFrom(
  dateHeader: string | null | undefined,
  sentAt: number,
  receivedAt: number,
) {
  if (!dateHeader) return null;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server) || receivedAt < sentAt) return null;
  // The header is truncated to the second: its middle is the best estimate.
  const estimate = server + 500 - (sentAt + receivedAt) / 2;
  return Math.abs(estimate) <= MAX_OFFSET_MS ? Math.round(estimate) : null;
}

export function noteServerDate(
  dateHeader: string | null | undefined,
  sentAt: number,
  receivedAt: number,
) {
  const next = offsetFrom(dateHeader, sentAt, receivedAt);
  if (next !== null) offset = next;
}

/** Now on the server's clock (milliseconds), as well as this browser can tell. */
export function serverNow() {
  return Date.now() + offset;
}

/** How far the device clock is from the server's (ms; positive when the server is ahead). */
export function clockOffset() {
  return offset;
}
