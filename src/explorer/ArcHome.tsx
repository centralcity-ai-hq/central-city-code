import { OnBase } from '../verify/OnBase';
import { usePageTitle } from '../shell/usePageTitle';
import { ARC_EXPLORER_CHAIN as ARC, ExplorerChainProvider } from './chain';
import { ExplorerAgent } from './ExplorerAgent';

/*
 * /explorer/arc, the Agent Explorer's "On Arc" view: the very same view as On Base (header, the one
 * Explorer switch, stats, table), read from Arc's Identity Registry (/api/public/arc/..., only while
 * the server has Arc on). Arc's agent icons are black, Arc's own colour (on-base.css).
 */
export function ArcHome() {
  usePageTitle('Agents on Arc · Central City Explorer');
  return (
    <ExplorerChainProvider value={ARC}>
      <OnBase chain={ARC} />
    </ExplorerChainProvider>
  );
}

/** /explorer/arc/agents/:id: the Explorer agent page, read from Arc. */
export function ArcAgent({ arcId }: { arcId: string }) {
  return (
    <ExplorerChainProvider value={ARC}>
      <ExplorerAgent key={arcId} baseId={arcId} />
    </ExplorerChainProvider>
  );
}
