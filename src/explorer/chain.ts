import { createContext, useContext } from 'react';
import { onChainPaths, type ExplorerChainSlug } from '../../shared/base/on-base';
import { BASE_MAINNET } from '../../shared/base/chains';
import { ARC_MAINNET, ARC_NETWORKS, chainView } from '../../shared/chains';

/*
 * The chain an Explorer view lists: Base (the default, every existing page) or Arc (/explorer/arc,
 * only while the server has it on). One place for its name, public paths and block-explorer links,
 * so a page never hard-codes Base's.
 */

export type ExplorerChain = {
  slug: ExplorerChainSlug;
  /** "Base", "Arc": as in "on Base", "Base ID". */
  name: string;
  chainId: number;
  /** The public read routes (/api/public/<slug>/...). */
  paths: ReturnType<typeof onChainPaths>;
  /** The block explorer's name and origin ("Basescan", https://basescan.org). */
  explorerName: string;
  explorerUrl: string;
  /** The Identity Registry, when the list has not named it yet. */
  registry: string;
  /** The view's home and an agent's page on it. */
  home: string;
  agentPath: (id: string) => string;
  txUrl: (hash: string) => string;
  addressUrl: (address: string) => string;
};

function explorerChain(
  slug: ExplorerChainSlug,
  chainId: number,
  explorerName: string,
): ExplorerChain {
  const view = chainView(chainId)!;
  const home = slug === 'base' ? '/explorer/base' : `/explorer/${slug}`;
  // Base's agent pages keep their address (/explorer/agents/<id>); other chains sit under theirs.
  const agents = slug === 'base' ? '/explorer/agents' : `/explorer/${slug}/agents`;
  return {
    slug,
    name: slug === 'base' ? 'Base' : view.name,
    chainId,
    paths: onChainPaths(slug),
    explorerName,
    explorerUrl: view.explorerUrl,
    registry: '',
    home,
    agentPath: (id) => `${agents}/${encodeURIComponent(id)}`,
    txUrl: (hash) => `${view.explorerUrl}/tx/${hash}`,
    addressUrl: (address) => `${view.explorerUrl}/address/${address}`,
  };
}

export const BASE_EXPLORER_CHAIN: ExplorerChain = explorerChain('base', BASE_MAINNET, 'Basescan');
export const ARC_EXPLORER_CHAIN: ExplorerChain = {
  ...explorerChain('arc', ARC_MAINNET, 'the Arc explorer'),
  registry: ARC_NETWORKS[ARC_MAINNET].contracts.identityRegistry,
};

export const explorerChainOf = (slug: ExplorerChainSlug) =>
  slug === 'arc' ? ARC_EXPLORER_CHAIN : BASE_EXPLORER_CHAIN;

const ExplorerChainContext = createContext<ExplorerChain>(BASE_EXPLORER_CHAIN);
export const ExplorerChainProvider = ExplorerChainContext.Provider;
/** The chain of the Explorer view this component is in (Base outside any provider). */
export const useExplorerChain = () => useContext(ExplorerChainContext);

/**
 * Whether the server has Arc on: GET /api/public/arc/rated once per session, 200 is on and
 * anything else (404 while CITY_ARC is off, an error, no answer) is off.
 */
let arcProbe: Promise<boolean> | null = null;
export function arcEnabled(fetcher: typeof fetch = fetch): Promise<boolean> {
  arcProbe ??= fetcher(ARC_EXPLORER_CHAIN.paths.rated, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  }).then(
    (response) => response.status === 200,
    () => false,
  );
  return arcProbe;
}
/** For tests: forget the probe's answer. */
export function resetArcProbe() {
  arcProbe = null;
}
