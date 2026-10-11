import { BASE_NETWORKS } from '../../shared/base/chains';
import { WALLET_CHAIN_ID } from '../../shared/base/wallet-network';

/*
 * A page loaded before a deploy that moved the wallets to another Base network still signs for the
 * network it was built for, and the server (built from the new commit) refuses that. The screens
 * then say plainly that the page is out of date and a reload fixes it, never a signature or network
 * error. Nothing is signed or sent for the other network either way.
 */

export const STALE_PAGE = 'This page is out of date. Reload it and try again.';
export const UNSUPPORTED_NETWORK = 'This wallet’s network isn’t supported here.';

export class StalePageError extends Error {
  constructor() {
    super(STALE_PAGE);
  }
}

/** The server answered for the other Base network than this page's: a reload fixes it. */
export const pageOutOfDate = (serverChainId: unknown): boolean =>
  typeof serverChainId === 'number' &&
  serverChainId !== WALLET_CHAIN_ID &&
  Object.hasOwn(BASE_NETWORKS, serverChainId);

/**
 * Before this page signs what a server answer names a network for: only this page's wallet network.
 * Absent (an older server that doesn't name it; JSON can't carry undefined): as before. The other
 * Base network: this page is out of date. Any other value, or one that isn't a number (null, a
 * string): unsupported. Nothing is signed or sent after a refusal.
 */
export function checkServerNetwork(chainId: unknown) {
  if (chainId === undefined) return;
  if (pageOutOfDate(chainId)) throw new StalePageError();
  if (chainId !== WALLET_CHAIN_ID) throw new Error(UNSUPPORTED_NETWORK);
}
