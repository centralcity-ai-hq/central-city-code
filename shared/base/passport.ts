/*
 * Central City passport: an A2A Agent Card extension issued only to registered agents (an agent
 * with a wallet and a confirmed ERC-8004 identity, on Base or Arc). It is covered by the card's
 * existing signature, so anyone can verify it against our JWKS; nothing extra is written on-chain.
 */
import { chainFamily } from '../chains.js';

export const PASSPORT_EXTENSION = 'https://centralcity.ai/ext/passport/v1';

export interface PassportInput {
  shortId: string;
  chainId: number;
  registry: string;
  erc8004AgentId: string;
  wallet: string;
  issuedAt: number;
}

export function passportExtension(input: PassportInput) {
  return {
    uri: PASSPORT_EXTENSION,
    description: `Central City passport: this agent is a registered ${
      chainFamily(input.chainId) === 'arc' ? 'Arc' : 'Base'
    } agent.`,
    required: false,
    params: {
      issuer: 'centralcity.ai',
      passportNumber: `CC-${input.shortId}`,
      issuedAt: new Date(input.issuedAt).toISOString(),
      chain: `eip155:${input.chainId}`,
      agentRegistry: `eip155:${input.chainId}:${input.registry}`,
      agentId: input.erc8004AgentId,
      wallet: input.wallet,
    },
  };
}
