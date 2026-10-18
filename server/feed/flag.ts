import { FEED_FLAG } from '../../shared/feed.js';
import { liveUnlessOff } from '../../shared/protocol.js';

/**
 * The Feed's emergency off (shared/feed.ts FEED_FLAG, docs/protocol/LIVE.md): the Feed is live
 * unless CITY_FEED is exactly '0'. Read per request or call, never cached, by every Feed surface:
 * the public routes (routes.ts), the sweep's cron route (cron.ts), the MCP tools and the signed-in
 * MCP instructions (tools.ts, request-tools.ts, server/remote-mcp/tools.ts,
 * server/assistant-access.ts) and the /mcp guide page (server/remote-mcp/index.ts).
 */
export function feedEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return liveUnlessOff(env, FEED_FLAG);
}
