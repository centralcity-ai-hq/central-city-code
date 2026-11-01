import { getAddress, type Address, type Hex } from 'viem';

/*
 * CCA-113: the owner's consent that an agent may pay on its own (server/base/wallet/
 * agent-pay-consent.ts) is signed by the wallet's owner key, not given by the console session
 * alone. Both sides build the typed data here: the browser signs it with the unlocked vault key
 * (src/base/wallet/agentPay.ts), the server recovers the signer, compares it with the wallet's
 * owner_address and stores the signature with the consent (migration 300).
 *
 * What it binds: the network (domain chainId), the agent's wallet, the token, the spending limit
 * the owner saw (its hash), who the agent may pay (`recipients`, as shown), a one-time nonce
 * (stored, unique: a signature is never accepted twice) and when it was signed (accepted only for
 * AGENT_PAY_CONSENT_TTL_MS).
 */
export const AGENT_PAY_CONSENT_TTL_MS = 10 * 60_000;
/** Clock skew tolerated for a signature dated in the future. */
export const AGENT_PAY_CONSENT_SKEW_MS = 2 * 60_000;

export const AGENT_PAY_CONSENT_TYPES = {
  AgentPayConsent: [
    { name: 'wallet', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'permissionHash', type: 'bytes32' },
    { name: 'recipients', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const;

export interface AgentPayConsentMessage {
  chainId: number;
  wallet: string;
  token: string;
  permissionHash: string;
  recipients: string;
  nonce: string;
  issuedAt: number;
}

export function agentPayConsentTypedData(input: AgentPayConsentMessage) {
  return {
    domain: { name: 'Central City Agent Pay', version: '1', chainId: input.chainId },
    types: AGENT_PAY_CONSENT_TYPES,
    primaryType: 'AgentPayConsent' as const,
    message: {
      wallet: getAddress(input.wallet) as Address,
      token: getAddress(input.token) as Address,
      permissionHash: input.permissionHash.toLowerCase() as Hex,
      recipients: input.recipients,
      nonce: input.nonce.toLowerCase() as Hex,
      issuedAt: BigInt(input.issuedAt),
    },
  };
}
