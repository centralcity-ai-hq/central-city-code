import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import { publicDocGuides } from '../public-docs/guides';
import type { AgentCount, BaseAgents } from '../../src/agentCount';

export type RenderPublicPage = (path: string) => string | null;

/**
 * Loads src/prerender.tsx through Vite's SSR loader (it turns the pages' CSS imports into no-ops
 * and compiles TSX), so the build and the tests render the same components the browser does.
 * Call `close` when done.
 */
export async function loadPrerender(root: string): Promise<{
  render: RenderPublicPage;
  /** The agent count the landing renders with (scripts/prerender/agent-count.ts). */
  setAgentCount: (count: AgentCount | null) => void;
  /** The Base agents number the landing renders with (scripts/prerender/agent-count.ts). */
  setBaseAgents: (base: BaseAgents | null) => void;
  /** Whether the landing reserves the paid service calls line (never a number). */
  setPaidCallsLine: (reserved: boolean) => void;
  close: () => Promise<void>;
}> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    // The docs guides render the public Markdown pages (scripts/public-docs/guides.ts).
    plugins: [react(), publicDocGuides(root)],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const module = (await server.ssrLoadModule('/src/prerender.tsx')) as {
      renderPublicPage: RenderPublicPage;
      setPrerenderAgentCount: (count: AgentCount | null) => void;
      setPrerenderPaidCallsLine: (reserved: boolean) => void;
      setPrerenderBaseAgents: (base: BaseAgents | null) => void;
    };
    return {
      render: module.renderPublicPage,
      setAgentCount: module.setPrerenderAgentCount,
      setPaidCallsLine: module.setPrerenderPaidCallsLine,
      setBaseAgents: module.setPrerenderBaseAgents,
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
