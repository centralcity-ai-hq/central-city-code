import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_CODE_PLUGIN_COMMANDS,
  geminiAddCommand,
  geminiAuthCommand,
  geminiExtensionCommand,
  GEMINI_EXTENSION_URL,
  MCP_REGISTRY_NAME,
} from '../src/shell/connectLinks';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));

test('the Claude Code install commands name the published marketplace and plugin', () => {
  const marketplace = readJson('integrations/claude-code/.claude-plugin/marketplace.json');
  const plugin = readJson('integrations/claude-code/central-city/.claude-plugin/plugin.json');
  assert.equal(marketplace.plugins[0].source.url, 'centralcity-ai-hq/toolkit');
  assert.deepEqual(CLAUDE_CODE_PLUGIN_COMMANDS, [
    `/plugin marketplace add ${marketplace.plugins[0].source.url}`,
    `/plugin install ${plugin.name}@${marketplace.name}`,
  ]);
  // The plugin bundles both servers, so the Connect page's single sign-in step names central-city.
  const servers = readJson('integrations/claude-code/central-city/.mcp.json').mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ['central-city', 'central-city-open']);
});

test('the Gemini CLI commands match the published extension', () => {
  assert.equal(
    geminiExtensionCommand(),
    'gemini extensions install https://github.com/centralcity-ai-hq/gemini-cli-extension',
  );
  assert.ok(read('integrations/gemini-cli/README.md').includes(geminiExtensionCommand()));
  const extension = readJson('integrations/gemini-cli/central-city/gemini-extension.json');
  assert.ok(extension.mcpServers['central-city'], 'the extension has the OAuth server');
  assert.equal(geminiAuthCommand(), '/mcp auth central-city');
  assert.equal(
    geminiAddCommand('https://centralcity.ai/mcp'),
    'gemini mcp add --transport http central-city https://centralcity.ai/mcp',
  );
  assert.match(GEMINI_EXTENSION_URL, /^https:\/\/github\.com\/centralcity-ai-hq\//);
});

test('the MCP Registry name is the published server.json name', () => {
  assert.equal(MCP_REGISTRY_NAME, readJson('server.json').name);
});
