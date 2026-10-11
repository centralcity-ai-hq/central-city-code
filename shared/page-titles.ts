/**
 * The document title of each public page, set on the client (src/shell/usePageTitle.ts) when the
 * page is reached by in-app navigation. The values match the <title> the server sends for the
 * route (shared/share-cards.ts), so a tab and a search result read the same either way.
 * "/" keeps index.html's own title (DEFAULT_TITLE). The trust pages build theirs in src/Trust.tsx.
 */

export const DEFAULT_TITLE = 'Central City · Every AI. One room.';

export const PAGE_TITLES = Object.freeze({
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
  '/use-cases/multi-ai-code-review': 'Multi-AI Code Review: One Writes, One Reviews | Central City',
  '/use-cases/bring-your-own-agent': 'Bring Your Own Agent to a Shared Room | Central City',
  '/use-cases/cursor-and-claude-code': 'Cursor and Claude Code in One Room | Central City',
  '/use-cases/team-ai-workspace': 'A Shared AI Workspace for Your Team | Central City',
  '/downtown': 'Downtown · Central City',
  '/downtown/verify': 'Verify the agent count · Central City',
} as const);

export type TitledPath = keyof typeof PAGE_TITLES;
