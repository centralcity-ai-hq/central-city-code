/**
 * Paged owner agent lists (Phase 0 of moving agents out of the workspace document, no migration).
 *
 * A workspace with at most `threshold` agents answers every owner list exactly as before: the
 * whole array, in stored order. A larger workspace answers its owner with one page of agents,
 * newest first (createdAt, then id, both descending), with the total and an opaque cursor for the
 * next page, so 20,000 agents are never serialized to a browser or an MCP client at once.
 *
 * No zod here: the console bundle imports this file.
 */
export const AGENT_PAGES = {
  /** Up to this many agents, owner lists answer in full and unchanged. */
  threshold: 500,
  /** Agents per page when the caller names no limit. */
  size: 100,
  /** The largest page a caller may ask for. */
  max: 200,
  /** Agent ids the snapshot's include= may name (the agents of one screen). */
  include: 50,
  /**
   * Agent ids one GET /api/agents ids= may name. Each call reads the whole workspace document, so
   * a reader by id asks for many at once, one request at a time (src/agents/ownAgents.ts).
   */
  ids: 200,
  /**
   * Agents a paged snapshot carries besides its page, so the names of jobs, workflows, events,
   * connections and the agents asked for with include= resolve: at most a page plus this many.
   */
  related: 400,
  /** The longest search text (q=). */
  query: 200,
  /** The longest cursor a caller may send back. */
  cursor: 300,
} as const;

/** The owner's agents list, one page (GET /api/agents). */
export const AGENTS_PATH = '/api/agents';
