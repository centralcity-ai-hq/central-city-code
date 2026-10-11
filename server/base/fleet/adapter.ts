/*
 * Fleet adapter: connects the provisioning worker to the wallet service (wallet stage) and, once it
 * exists, the identity service (registration stage). Wallet creation is off-chain and idempotent on
 * (agent, chain), so a wallet stage is final as soon as the wallet row is stored.
 */
import type { Address, BaseChainId } from '../../../shared/base/chains.js';
import type { WalletService } from '../../../shared/base/types.js';
import type { FleetAdapter, FleetItem, FleetOutcome } from './worker.js';

/** The registration stage, implemented by the identity service. */
export interface FleetIdentityPort {
  reconcile(item: Readonly<FleetItem>): Promise<FleetOutcome>;
  submit(item: Readonly<FleetItem>): Promise<Exclude<FleetOutcome, 'absent'>>;
}

export interface FleetAdapterDeps {
  wallets: Pick<WalletService, 'ensureWallet' | 'getWallet'>;
  /** The owner EOA for the item's agent wallet, as configured for the job's workspace. */
  ownerOf(item: Readonly<FleetItem>): Promise<Address>;
  identity?: FleetIdentityPort;
}

export function createFleetAdapter(deps: FleetAdapterDeps): FleetAdapter {
  function identity(): FleetIdentityPort {
    // Without an identity service a registration item stays unresolved; it is never marked final.
    if (!deps.identity) throw new Error('Registration is not available.');
    return deps.identity;
  }

  return {
    async reconcile(item) {
      if (item.stage === 'registration') return identity().reconcile(item);
      const wallet = await deps.wallets.getWallet(item.agentId, item.chainId as BaseChainId);
      if (!wallet) return 'absent';
      // Another workspace's wallet for this agent is never adopted or replaced.
      if (wallet.workspaceId !== item.workspaceId) throw new Error('Wallet belongs elsewhere.');
      return 'final';
    },

    async submit(item) {
      if (item.stage === 'registration') return identity().submit(item);
      const wallet = await deps.wallets.ensureWallet({
        workspaceId: item.workspaceId,
        agentId: item.agentId,
        chainId: item.chainId as BaseChainId,
        ownerAddress: await deps.ownerOf(item),
      });
      if (wallet.workspaceId !== item.workspaceId) throw new Error('Wallet belongs elsewhere.');
      return 'final';
    },
  };
}
