import {
  claudeCodeCommand,
  claudeConnectLink,
  codexAddCommand,
  codexLoginCommand,
  cursorDeeplink,
  geminiAddCommand,
  geminiAuthCommand,
  geminiExtensionCommand,
  isLoopbackHost,
  PRODUCTION_ORIGIN,
} from '../shell/connectLinks';
import { MCP_PATH } from '../shell/roomInvite';

/*
 * "Add an AI" (docs/design/ROOM_WHO_JOINS.md §3): the AI apps a host can bring into a room and
 * the one short set of steps for each. The addresses, commands and install links come from
 * src/shell/connectLinks.ts, the same source as the Connect page and the Connect AI sheet.
 */

export type AiAppId =
  'claude' | 'chatgpt' | 'gemini-cli' | 'claude-code' | 'codex' | 'cursor' | 'other';

export type AiApp = {
  id: AiAppId;
  name: string;
  /** The letter on the app's tile. */
  glyph: string;
  /** The tile's colour (white glyph on it). */
  color: string;
};

/** The order of the grid (3 columns, 2 on phones). */
export const AI_APPS: readonly AiApp[] = [
  { id: 'claude', name: 'Claude', glyph: 'C', color: '#d97757' },
  { id: 'chatgpt', name: 'ChatGPT', glyph: 'G', color: '#10a37f' },
  { id: 'gemini-cli', name: 'Gemini CLI', glyph: '✦', color: '#4285f4' },
  { id: 'claude-code', name: 'Claude Code', glyph: 'C', color: '#b45309' },
  { id: 'codex', name: 'Codex', glyph: 'X', color: '#0f172a' },
  { id: 'cursor', name: 'Cursor', glyph: '▲', color: '#334155' },
  { id: 'other', name: 'Other', glyph: '+', color: '#64748b' },
];

/** The one action row: a deep link to open, or an address or command to copy. */
export type AiAppRow =
  | { action: 'open'; text: string; href: string }
  | { action: 'copy'; text: string; value: string; describedAs: string };

export type AiAppSteps = {
  /** Step 1, above the row. */
  lead: string;
  row: AiAppRow;
  /** Step 2: one short line. */
  note: string;
  /** Step 3: where the room invite goes. */
  then: string;
};

/** A local server (localhost): coding apps on this computer can reach it, chat apps cannot. */
export function isLocalConnect(hostname?: string) {
  return isLoopbackHost(hostname);
}

/** The signed-in address an app connects to: production, unless this is a local server. */
export function connectEndpoint(
  origin = typeof window === 'undefined' ? PRODUCTION_ORIGIN : window.location.origin,
  hostname?: string,
) {
  return `${isLocalConnect(hostname) ? origin : PRODUCTION_ORIGIN}${MCP_PATH}`;
}

/** What the "Add an AI" sheet shows for one app. Every app has the same four parts. */
export function aiAppSteps(id: AiAppId, endpoint: string, local = false): AiAppSteps {
  const app = AI_APPS.find((item) => item.id === id) ?? AI_APPS[0];
  const then = `Then paste the room invite into ${id === 'other' ? 'your AI' : app.name}.`;
  // Chat apps reach Central City over the internet, so a local server cannot connect them.
  if (local && (id === 'claude' || id === 'chatgpt'))
    return {
      lead: `${app.name} needs a public address. Open the live site:`,
      row: { action: 'open', text: 'Central City · centralcity.ai', href: PRODUCTION_ORIGIN },
      note: `Connect ${app.name} from there, then sign in.`,
      then,
    };
  switch (id) {
    case 'claude':
      return {
        lead: 'Open Claude with Central City ready:',
        row: {
          action: 'open',
          text: 'Claude · Central City connector',
          href: claudeConnectLink(endpoint),
        },
        note: 'In Claude, choose Add and sign in.',
        then,
      };
    case 'chatgpt':
      return {
        lead: 'Add this address to ChatGPT:',
        row: { action: 'copy', text: endpoint, value: endpoint, describedAs: 'ChatGPT address' },
        note: 'In Plugins, choose Build MCP Apps, paste it, OAuth.',
        then,
      };
    case 'gemini-cli': {
      // The published extension on the live site; by hand on a local server (like ConnectAiSheet).
      const command = local ? geminiAddCommand(endpoint) : geminiExtensionCommand();
      return {
        lead: 'Run this in your terminal:',
        row: {
          action: 'copy',
          text: command,
          value: command,
          describedAs: local ? 'Gemini CLI command' : 'Gemini CLI extension command',
        },
        note: `Then open Gemini CLI and run: ${geminiAuthCommand()}`,
        then,
      };
    }
    case 'claude-code': {
      const command = claudeCodeCommand(endpoint);
      return {
        lead: 'Run this in your terminal:',
        row: { action: 'copy', text: command, value: command, describedAs: 'Claude Code command' },
        note: 'Then run /mcp and choose Authenticate.',
        then,
      };
    }
    case 'codex': {
      const command = codexAddCommand(endpoint);
      return {
        lead: 'Run this in your terminal:',
        row: { action: 'copy', text: command, value: command, describedAs: 'Codex command' },
        note: `Then run: ${codexLoginCommand()}`,
        then,
      };
    }
    case 'cursor':
      return {
        lead: 'Open Cursor with Central City ready:',
        row: {
          action: 'open',
          text: 'Cursor · Central City connector',
          href: cursorDeeplink(endpoint),
        },
        note: 'In Cursor, confirm and sign in.',
        then,
      };
    case 'other':
      return {
        lead: 'Add this address to your AI app or agent:',
        row: {
          action: 'copy',
          text: endpoint,
          value: endpoint,
          describedAs: 'Central City address',
        },
        note: 'Add it as an MCP connector or server, then sign in.',
        then,
      };
  }
}

/** The next app in the grid for an arrow key (radio group: wraps around), or null. */
export function nextAiApp(id: AiAppId, key: string): AiAppId | null {
  const index = AI_APPS.findIndex((item) => item.id === id);
  const count = AI_APPS.length;
  if (key === 'ArrowRight' || key === 'ArrowDown') return AI_APPS[(index + 1) % count].id;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return AI_APPS[(index - 1 + count) % count].id;
  if (key === 'Home') return AI_APPS[0].id;
  if (key === 'End') return AI_APPS[count - 1].id;
  return null;
}

/** An AI that is in the room now but was not when the sheet opened, if any. */
export function joinedAi<T extends { id: string; kind?: 'agent' | 'person' }>(
  baseline: ReadonlySet<string>,
  members: readonly T[],
): T | undefined {
  return members.find((member) => member.kind !== 'person' && !baseline.has(member.id));
}

/**
 * "Who should join?" (§2): shown to the host of an open room until hidden, while nobody but the
 * host is in it. Waits for the member list, so it never flashes in a room that has members.
 */
export function showWhoJoins({
  host,
  closed,
  denied,
  hidden,
  membersLoaded,
  members,
}: {
  host: boolean;
  closed: boolean;
  denied: boolean;
  hidden: boolean;
  membersLoaded: boolean;
  members: readonly { role: string; own?: boolean; kind?: string }[];
}) {
  // You in your own room as a person (Agency A1: a new room has its creator in it) aren't
  // "someone else": the card stays until another person or an AI joins.
  return (
    host &&
    !closed &&
    !denied &&
    !hidden &&
    membersLoaded &&
    members.every(
      (member) => member.role === 'host' || (member.own === true && member.kind === 'person'),
    )
  );
}
