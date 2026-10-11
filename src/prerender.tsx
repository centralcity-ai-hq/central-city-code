import { renderToString } from 'react-dom/server';
import { setBuildAgentCount, type AgentCount } from './agentCount';
import { ConnectPage } from './Connect';
import { DocsPage, type DocsPageId } from './docs/DocsPages';
import { Downtown } from './Downtown';
import { ElricSignedOut } from './elric/ElricSignedOut';
import { InvitePage } from './Invite';
import { Landing } from './Landing';
import { TrustPage, TRUST_PAGE_IDS, type TrustPageId } from './Trust';
import { LiveLog } from './verify/LiveLog';
import { VerifyPage } from './verify/VerifyPage';
import { UseCasePage, UseCasesIndex } from './use-cases/UseCasePage';
import { WorkflowsPage } from './WorkflowsPage';
import { USE_CASES, USE_CASES_INDEX, useCasePath } from '../shared/use-cases';

/*
 * Build-time only (vite.config.ts `shareCards`): the markup of the public pages, so a crawler
 * that does not run JavaScript reads the page's text in its first HTML. The client still mounts
 * with createRoot and replaces this markup with the same tree. Not part of the app bundle.
 *
 * Live values (the explorer's entries, the verification result) render in their loading state.
 * The one exception is the landing's agent count: the build reads it once
 * (scripts/prerender/agent-count.ts) and passes it in through setPrerenderAgentCount, so the HTML
 * carries a real number as of the build; without one the ticker keeps its empty, reserved line.
 * The home, Elric, Connect and Invite pages are the signed-out view (SESSION_GATED_PATHS); a
 * signed-in visitor gets the app instead.
 */

/** The agent count the landing's ticker renders with (null: none, the reserved empty line). */
export function setPrerenderAgentCount(count: AgentCount | null): void {
  setBuildAgentCount(count);
}

const DOCS =
  /^\/docs(?:\/(start|rooms|room-management|coding|api|microsoft-copilot|mistral-le-chat))?$/;

/** The page's markup for `#root`, or null when the route is not prerendered. Throws on a render error. */
export function renderPublicPage(path: string): string | null {
  const trust = path.slice(1) as TrustPageId;
  if (TRUST_PAGE_IDS.includes(trust)) return renderToString(<TrustPage page={trust} />);
  if (path === '/') return renderToString(<Landing setupRequired={false} />);
  if (path === '/elric') return renderToString(<ElricSignedOut onAuth={() => undefined} />);
  if (path === '/connect') return renderToString(<ConnectPage />);
  if (path === '/invite') return renderToString(<InvitePage />);
  if (path === '/downtown') return renderToString(<Downtown />);
  if (path === '/downtown/verify') return renderToString(<VerifyPage />);
  if (path === '/explorer' || path === '/downtown/log') return renderToString(<LiveLog />);
  if (path === '/workflows') return renderToString(<WorkflowsPage />);
  if (path === USE_CASES_INDEX.path) return renderToString(<UseCasesIndex />);
  const useCase = USE_CASES.find((entry) => useCasePath(entry.slug) === path);
  if (useCase) return renderToString(<UseCasePage slug={useCase.slug} />);
  const docs = DOCS.exec(path);
  if (docs) return renderToString(<DocsPage page={(docs[1] ?? 'index') as DocsPageId} />);
  return null;
}
