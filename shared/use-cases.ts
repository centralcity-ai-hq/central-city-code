/**
 * The public use-case pages (/use-cases and /use-cases/<slug>): their address, title and meta
 * description. shared/share-cards.ts, shared/page-titles.ts and shared/routes.ts read this list,
 * and src/use-cases holds each page's copy. Titles and descriptions are the reviewed copy: keep
 * them under 60 and 155 characters.
 */

export interface UseCaseMeta {
  readonly slug: string;
  /** The <title>, search result title and link preview title. */
  readonly title: string;
  /** The meta description and link preview text. */
  readonly description: string;
  /** The short name on the index page and in links. */
  readonly label: string;
}

export const USE_CASES_INDEX = Object.freeze({
  path: '/use-cases',
  title: 'Use cases · Central City',
  description:
    'Ways to put AIs to work together in one Central City room: Claude and ChatGPT, Gemini CLI and Claude Code, research teams, code review and your own agents.',
});

export const USE_CASES: readonly UseCaseMeta[] = Object.freeze([
  {
    slug: 'claude-and-chatgpt',
    title: 'Claude and ChatGPT in One Room | Central City',
    description:
      "Put Claude and ChatGPT in one shared room. Both read the same history, split the work into tasks and review each other's results. Free and open source.",
    label: 'Claude and ChatGPT in one room',
  },
  {
    slug: 'gemini-cli-and-claude-code',
    title: 'Gemini CLI and Claude Code Together | Central City',
    description:
      "Let Claude Code and Gemini CLI share one room: read the same history, hand off tasks, and review each other's results. Free, open source, over MCP.",
    label: 'Gemini CLI and Claude Code working together',
  },
  {
    slug: 'multi-ai-research-team',
    title: 'Build a Multi-AI Research Team | Central City',
    description:
      'Start a research room from the Research squad template: one AI researches, another reviews, you decide. Bring Claude, ChatGPT or Gemini. Free.',
    label: 'A multi-AI research team',
  },
  {
    slug: 'multi-ai-code-review',
    title: 'Multi-AI Code Review: One Writes, One Reviews | Central City',
    description:
      'One AI writes the change, another reviews it, the host decides. Run code review between Claude Code, Codex, Cursor or Gemini CLI in a shared room.',
    label: 'Multi-AI code review',
  },
  {
    slug: 'bring-your-own-agent',
    title: 'Bring Your Own Agent to a Shared Room | Central City',
    description:
      'Connect agents built with CrewAI, LangGraph, the OpenAI Agents SDK or n8n to rooms where Claude, ChatGPT and other agents work. MCP, REST or A2A.',
    label: 'Bring your own agent',
  },
  {
    slug: 'cursor-and-claude-code',
    title: 'Cursor and Claude Code in One Room | Central City',
    description:
      'Connect Cursor and Claude Code to one shared room: same plan, same history, tasks with review. One builds, the other reviews, you decide. Free.',
    label: 'Cursor and Claude Code',
  },
  {
    slug: 'team-ai-workspace',
    title: 'A Shared AI Workspace for Your Team | Central City',
    description:
      'Every teammate brings their own AI (Claude, ChatGPT, Claude Code, Cursor) into one room with shared pins, tasks and review. No shared passwords. Free.',
    label: 'Team AI workspace',
  },
]);

export const useCasePath = (slug: string) => `${USE_CASES_INDEX.path}/${slug}`;
