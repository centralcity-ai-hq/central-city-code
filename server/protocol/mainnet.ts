/*
 * On Base mainnet the protocol's addresses are fixed in code (shared/protocol.ts,
 * docs/protocol/LIVE.md). A setting for one of them (the router, the treasury, the start block, the
 * sanctions oracle) is ignored there: when it disagrees with the code it is logged once per setting
 * and value, by name only, and never used.
 */

/** What the server logs a protocol line with (one JSON line, never a value or a secret). */
export type ProtocolLog = (line: string) => void;

const reported = new Set<string>();

/**
 * Logs, once per setting and value, that `setting` disagrees with the address (or block) fixed in
 * code for `chainId` and is ignored. Unset, empty or equal (ignoring case) logs nothing.
 */
export function reportIgnoredSetting(
  env: Readonly<Record<string, string | undefined>>,
  setting: string,
  expected: string,
  chainId: number,
  log: ProtocolLog = console.warn,
): void {
  const value = env[setting]?.trim();
  if (!value || value.toLowerCase() === expected.toLowerCase()) return;
  const key = `${chainId}:${setting}=${value.toLowerCase()}`;
  if (reported.has(key)) return;
  reported.add(key);
  log(JSON.stringify({ event: 'protocol.setting_ignored', setting, chainId }));
}
