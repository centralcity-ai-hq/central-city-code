/**
 * Message body and page limits used by route registration and request handlers. A leaf module
 * with no imports: links/routes.ts, remote-mcp/index.ts and assistant-access.ts read these per
 * request or at registration, and in the single-file server bundle an import cycle through
 * messaging/contract.ts left MESSAGE_SEND_TOOLS undefined at request time, so every invite-guest
 * tool call failed (29 Oct). Keep it import-free.
 */

/**
 * Request body limit of the routes and tool calls that send a message: a whole message
 * (MESSAGE_LIMITS.totalBytes) plus the other fields. The app's default stays 64 KiB.
 */
export const MESSAGE_BODY_MAX_BYTES = 192 * 1024;

/** The tool calls that send one message, and so may use MESSAGE_BODY_MAX_BYTES. */
export const MESSAGE_SEND_TOOLS: readonly string[] = [
  'city_room_post',
  'city_send_message',
  'city_room_dm_send',
  // An edit replaces a whole message.
  'city_room_message_edit',
];

/**
 * Bytes of a parsed request body, for the per-tool body checks: the raw body when the route kept
 * it, otherwise Content-Length, otherwise the parsed body re-serialized. Never 0 for a big body,
 * so a route without a raw body cannot skip the 64 KiB rule.
 */
export function requestBodyBytes(request: {
  rawBody?: unknown;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}): number {
  const raw = request.rawBody;
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (Buffer.isBuffer(raw)) return raw.length;
  const header = Number(request.headers['content-length']);
  const serialized =
    request.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(request.body) ?? '', 'utf8');
  return Math.max(Number.isFinite(header) && header > 0 ? header : 0, serialized);
}

/**
 * Bytes of message parts one read page carries at most (1 MiB). MCP answers carry a result twice
 * (text content and structuredContent), so a page stays near 2 MiB on the wire, well under the
 * 4.5 MB function response cap. A page stops before the message that would pass it and says
 * has_more; it always holds at least one message, so a reader never gets stuck.
 */
export const PAGE_MESSAGE_BYTES = 1024 * 1024;

/** How many of `rows` (in page order) fit in PAGE_MESSAGE_BYTES; at least one when any exist. */
export function rowsWithinPageBytes(
  rows: readonly { parts: unknown }[],
  budget: number = PAGE_MESSAGE_BYTES,
): number {
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    const parts = rows[i]!.parts;
    used += Buffer.byteLength(typeof parts === 'string' ? parts : JSON.stringify(parts ?? null));
    if (used > budget) return Math.max(i, 1);
  }
  return rows.length;
}
