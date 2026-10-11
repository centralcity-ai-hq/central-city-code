import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TITLE, PAGE_TITLES } from '../shared/page-titles.js';

test('each public page has its own client title, matching the server-sent <title>', () => {
  assert.deepEqual(
    { ...PAGE_TITLES },
    {
      '/elric': 'Elric, your AI assistant in Central City',
      '/explorer': 'Every AI agent on Central City, live',
      '/explorer/base': 'Central City agents on Base',
      '/downtown/log': 'Every AI agent on Central City, live',
      '/connect': 'Connect your AI · Central City',
      '/invite': 'Invite your AI · Central City',
      '/workflows': 'Workflows · Central City',
      '/docs': 'Docs · Central City',
      '/docs/start': 'Docs · Central City',
      '/docs/rooms': 'Rooms · Central City Docs',
      '/docs/room-management': 'Room management · Central City Docs',
      '/docs/coding': 'Coding in rooms · Central City Docs',
      '/docs/microsoft-copilot': 'Use Central City in Microsoft Copilot · Central City Docs',
      '/docs/mistral-le-chat': 'Use Central City in Mistral Le Chat · Central City Docs',
      '/docs/api': 'API and SDK · Central City Docs',
      '/use-cases': 'Use cases · Central City',
      '/use-cases/claude-and-chatgpt': 'Claude and ChatGPT in One Room | Central City',
      '/use-cases/gemini-cli-and-claude-code': 'Gemini CLI and Claude Code Together | Central City',
      '/use-cases/multi-ai-research-team': 'Build a Multi-AI Research Team | Central City',
      '/use-cases/multi-ai-code-review':
        'Multi-AI Code Review: One Writes, One Reviews | Central City',
      '/use-cases/bring-your-own-agent': 'Bring Your Own Agent to a Shared Room | Central City',
      '/use-cases/cursor-and-claude-code': 'Cursor and Claude Code in One Room | Central City',
      '/use-cases/team-ai-workspace': 'A Shared AI Workspace for Your Team | Central City',
      '/downtown': 'Downtown · Central City',
      '/downtown/verify': 'Verify the agent count · Central City',
    },
  );
  for (const title of Object.values(PAGE_TITLES)) assert.notEqual(title, DEFAULT_TITLE);
});

test('the landing page keeps the default title', () => {
  assert.equal(DEFAULT_TITLE, 'Central City · Every AI. One room.');
  assert.equal('/' in PAGE_TITLES, false);
});

test('DEFAULT_TITLE is index.html’s own <title>', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.equal(/<title>([^<]*)<\/title>/.exec(html)?.[1], DEFAULT_TITLE);
});
