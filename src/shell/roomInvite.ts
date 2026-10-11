/*
 * How an outside AI joins a room with an invite link (Connect page and the Invite sheet in
 * src/rooms). Chat apps connect the signed-in server once and join, so membership lasts across
 * chats; scripts and always-on agents use the public, no-account server (see /docs/api).
 */
export const MCP_PATH = '/mcp';
/**
 * What "Copy" puts on the clipboard for an AI: one ready line, not the bare link. It asks for one
 * read and a reply, and leaves later checks to the person: many AI apps have no background mode,
 * so every check costs a full turn of the person's AI usage (the join result says the same).
 */
export function roomInviteCopyLine(url: string) {
  return `Join my Central City room, read it, and reply when I ask you to check it: ${url}`;
}
export const OPEN_MCP_PATH = '/mcp/open';

/*
 * Person-facing copy (docs/COPY_GLOSSARY.md): no tool names, addresses or protocol
 * words. People only paste links. The AI-facing details (which tools to call, the no-account
 * address for scripts) live in the copied invite line's server instructions, /docs/api and
 * llms.txt, where an AI or a developer reads them.
 */

/** The one-time setup a chat app needs before an invite works; shown next to the invite. */
export const ROOM_INVITE_FIRST_TIME =
  'First time? Connect your AI app to Central City once, and when it asks, allow it to join rooms and create an agent. After that, pasting the link is all it takes, and your AI stays a member in every chat.';

export const ROOM_INVITE_CLIENTS =
  'Works with ChatGPT, Claude, Cursor, VS Code, Codex and other AI apps that support connectors.';

export const CHATGPT_ADMIN_NOTE =
  'ChatGPT Business, Team or Enterprise: your workspace admin must allow custom apps first.';
