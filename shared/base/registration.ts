/*
 * ERC-8004 agent registration file (registration-v1): what the on-chain agentURI resolves to.
 * Registry explorers and indexers read this shape; the A2A card stays the detailed description.
 */
export const REGISTRATION_V1 = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

export interface RegistrationFile {
  type: typeof REGISTRATION_V1;
  name: string;
  description: string;
  image?: string;
  services: Array<{ name: string; endpoint: string; version?: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: number | string; agentRegistry: string }>;
  supportedTrust: string[];
}

export interface RegistrationInput {
  name: string;
  description: string;
  image?: string;
  cardUrl: string;
  a2aVersion?: string;
  /** Confirmed on-chain identities of this agent. */
  identities: Array<{ chainId: number; registry: string; erc8004AgentId: string }>;
}

/** Explorers cut longer descriptions; the standard line always fits whole. */
export const DESCRIPTION_MAX = 300;

/**
 * The description every Central City Base agent's registration file carries (the product owner, 10
 * Oct 2026): the agent's own name and passport, what Central City is, and that it was registered
 * through Central City (never "verified by" or "owned by"). An owner's own description, when it
 * says more than the name, comes first, shortened so the standard line always stays whole.
 */
export function standardDescription(input: {
  name: string;
  /** The passport address without the scheme: `centralcity.ai/a/<short id>`. */
  passport: string;
  ownDescription?: string;
}): string {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const standard =
    `${name} is an AI agent on Central City, where people and AI agents work together in shared ` +
    `rooms. Registered on Base through Central City. Passport: ${input.passport}`;
  const own = (input.ownDescription ?? '').replace(/\s+/g, ' ').trim();
  if (!own || own.toLowerCase() === name.toLowerCase()) return standard;
  const room = DESCRIPTION_MAX - standard.length - 1;
  if (room < 12) return standard;
  const lead = own.length <= room ? own : `${own.slice(0, room - 1).replace(/\s+\S*$/, '')}…`;
  return `${/[.!?…]$/.test(lead) ? lead : `${lead}.`} ${standard}`;
}

/** A uint256 id as a JSON number when it is exact, otherwise as a decimal string. */
const agentIdJson = (id: string): number | string => {
  const n = Number(id);
  return Number.isSafeInteger(n) && String(n) === id ? n : id;
};

/**
 * ERC-8004 Endpoint Domain Verification: the file at https://<domain>/.well-known/
 * agent-registration.json. Its `registrations` must hold an entry with the on-chain agent's
 * agentRegistry and agentId, so one file for Central City's domain lists every agent whose
 * services point there.
 */
export function buildDomainRegistrations(
  identities: RegistrationInput['identities'],
): Pick<RegistrationFile, 'registrations'> {
  return {
    registrations: identities.map((identity) => ({
      agentId: agentIdJson(identity.erc8004AgentId),
      agentRegistry: `eip155:${identity.chainId}:${identity.registry}`,
    })),
  };
}

export function buildRegistrationFile(input: RegistrationInput): RegistrationFile {
  return {
    type: REGISTRATION_V1,
    name: input.name,
    description: input.description,
    ...(input.image ? { image: input.image } : {}),
    services: [
      {
        name: 'A2A',
        endpoint: input.cardUrl,
        ...(input.a2aVersion ? { version: input.a2aVersion } : {}),
      },
    ],
    x402Support: false,
    active: true,
    registrations: input.identities.map((identity) => ({
      agentId: agentIdJson(identity.erc8004AgentId),
      agentRegistry: `eip155:${identity.chainId}:${identity.registry}`,
    })),
    supportedTrust: ['reputation'],
  };
}
