/*
 * The one source for how an AI app connects to Central City: the production origin, the
 * one-click install links (Claude, Cursor, VS Code), the published packages (the Claude Code
 * plugin, the Gemini CLI extension) and the terminal commands (Claude Code, Codex, Gemini CLI).
 * Used by the Connect page and the rooms' Connect AI and Add an AI sheets. No React and
 * no styles, so it also loads in unit tests.
 */

/** The server name a signed-in connection uses. */
export const CONNECT_SERVER = 'central-city';

/** Where ChatGPT adds a custom app (Build MCP Apps). */
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins';

/** The production site: one-click installs always point here, never at a short-lived preview. */
export const PRODUCTION_ORIGIN = 'https://centralcity.ai';

/** False when there is no window (the build's prerender, src/prerender.tsx): the production view. */
export function isLoopbackHost(
  hostname = typeof window === 'undefined' ? '' : window.location.hostname,
) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/**
 * Cursor's MCP install link, as an HTTPS page on cursor.com that opens Cursor (a bare cursor://
 * link does nothing when Cursor is missing or the browser blocks the protocol). config is the
 * base64 of the server's mcp.json entry without the name wrapper; a remote server's entry is
 * `{ "url": … }` (https://cursor.com/docs/context/mcp/install-links).
 */
export function cursorDeeplink(mcpUrl: string, name = 'central-city') {
  const config = btoa(JSON.stringify({ url: mcpUrl }));
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

/**
 * VS Code's MCP install link, as the HTTPS redirect on vscode.dev that opens VS Code (a bare
 * vscode: link does nothing when VS Code is missing or the protocol is blocked). config is the
 * server entry `{ type: 'http', url }` (https://code.visualstudio.com/api/extension-guides/ai/mcp).
 */
export function vscodeDeeplink(mcpUrl: string, name = 'central-city') {
  return `https://vscode.dev/redirect/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: mcpUrl }))}`;
}

export function claudeConnectLink(url: string) {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: 'Central City',
    connectorUrl: url,
  });
  return `https://claude.ai/customize/connectors?${params}`;
}

export function claudeCodeCommand(endpoint: string, name = CONNECT_SERVER) {
  return `claude mcp add --transport http ${name} ${endpoint}`;
}

export function codexAddCommand(endpoint: string, name = CONNECT_SERVER) {
  return `codex mcp add ${name} --url ${endpoint}`;
}

export function codexLoginCommand(name = CONNECT_SERVER) {
  return `codex mcp login ${name}`;
}

/**
 * The published Claude Code plugin: a marketplace in the public toolkit repository, then the
 * plugin from it. It bundles both servers (central-city-open, central-city) and a skill, always at
 * the production address, so a local server still uses claudeCodeCommand.
 */
export const CLAUDE_CODE_PLUGIN_COMMANDS = [
  '/plugin marketplace add centralcity-ai-hq/toolkit',
  '/plugin install central-city@centralcity-ai',
] as const;

/** The published Gemini CLI extension (both servers and GEMINI.md, production address). */
export const GEMINI_EXTENSION_URL = 'https://github.com/centralcity-ai-hq/gemini-cli-extension';

export function geminiExtensionCommand() {
  return `gemini extensions install ${GEMINI_EXTENSION_URL}`;
}

/** Signs Gemini CLI in to your own workspace (the central-city server). */
export function geminiAuthCommand(name = CONNECT_SERVER) {
  return `/mcp auth ${name}`;
}

/** Gemini CLI by hand: one server at any address (also a local server). */
export function geminiAddCommand(endpoint: string, name = CONNECT_SERVER) {
  return `gemini mcp add --transport http ${name} ${endpoint}`;
}

/** Central City's name in the MCP Registry, which VS Code's MCP server list reads. */
export const MCP_REGISTRY_NAME = 'ai.centralcity/central-city';
