import type { Database } from '../../database.js';
import { intentFor, PaymentError, type PaymentAuthority } from './service.js';

/**
 * A recipient a wallet never pays: the wallet itself, or its own spender account (a payment there
 * only moves funds within the agent's own accounts). Payments and owner withdrawals share it.
 */
export function walletRecipientRefusal(
  wallet: { address: string; spenderAddress: string | null },
  to: string,
): 'SELF_TRANSFER' | 'SPENDER_RECIPIENT' | null {
  const recipient = to.toLowerCase();
  if (wallet.address.toLowerCase() === recipient) return 'SELF_TRANSFER';
  if (wallet.spenderAddress?.toLowerCase() === recipient) return 'SPENDER_RECIPIENT';
  return null;
}

export type PaymentPrincipal =
  { kind: 'owner'; operatorId: string } | { kind: 'agent'; operatorId: string; agentId: string };

/** Request-scoped only. Authentication is supplied by the server, never by request JSON. */
export function createPaymentAuthority(deps: {
  db: Database;
  principal: PaymentPrincipal;
  /** Revalidate the original session/credential, including rotation and agent revocation. */
  revalidate: () => Promise<void>;
  env?: Record<string, string | undefined>;
}): PaymentAuthority {
  const principal = Object.freeze({ ...deps.principal });
  return {
    async assertCanTransfer(input) {
      const intent = intentFor(input, { ...input, amount: BigInt(input.amount) }, deps.env);
      if (intent.intentHash !== input.intentHash || intent.operationKey !== input.operationKey)
        throw new PaymentError('IDEMPOTENCY_CONFLICT');
      if (!('agentId' in intent.source)) throw new PaymentError('FLEET_ALLOCATION_REQUIRED');
      const actorId = principal.kind === 'owner' ? principal.operatorId : principal.agentId;
      if (
        intent.workspaceId !== principal.operatorId ||
        intent.actorId !== actorId ||
        (principal.kind === 'agent' && intent.source.agentId !== principal.agentId)
      )
        throw new PaymentError('NOT_AUTHORIZED');
      await deps.revalidate();
      // One statement gives a consistent wallet/grant snapshot; chain rechecks at broadcast.
      const { rows } = await deps.db.query<{
        address: string;
        spender_address: string;
        permitted: boolean;
      }>(
        `SELECT w.address, w.spender_address, EXISTS (
           SELECT 1 FROM base_spend_permissions p
           WHERE p.wallet_id = w.wallet_id AND p.chain_id = w.chain_id
             AND p.state IN ('signed','onchain')
             AND lower(p.permission->>'account') = lower(w.address)
             AND lower(p.permission->>'spender') = lower(w.spender_address)
             AND lower(p.permission->>'token') = $4
             AND octet_length(p.signature) > 0
         ) AS permitted
         FROM base_wallets w WHERE w.agent_id = $1 AND w.operator_id = $2
           AND w.chain_id = $3 AND w.state IN ('derived','deployed')`,
        [intent.source.agentId, principal.operatorId, intent.chainId, intent.token],
      );
      if (!rows[0]) throw new PaymentError('SOURCE_UNAVAILABLE');
      const refused = walletRecipientRefusal(
        { address: rows[0].address, spenderAddress: rows[0].spender_address },
        intent.to,
      );
      if (refused) throw new PaymentError(refused);
      if (!rows[0].permitted) throw new PaymentError('NO_PERMISSION');
      // Amount, expiry, signature validity and remaining on-chain allowance stay chain-owned.
    },
  };
}
