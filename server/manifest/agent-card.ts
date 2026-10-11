import { A2A_PIN } from '../../protocol/a2a.js';
import { A2A_AUTH_EXTENSION } from '../a2a.js';
import type { ResolvedAgentManifest } from '../../shared/manifest.js';
import { hashManifest } from './resolve.js';
import {
  signDetached,
  verifyDetached,
  type Jwks,
  type JwsSignature,
  type SigningKey,
  type VerifyResult,
} from './keys.js';

/**
 * A2A v1.0 Agent Card (JSON form of the pinned `AgentCard` protobuf message). Only fields the
 * platform can honour are emitted: JSON-RPC binding, no streaming or push notifications, and the
 * private native-auth profile as the only security requirement.
 */
export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: 'JSONRPC'; protocolVersion: string }>;
  provider: { organization: string; url: string };
  version: string;
  documentationUrl?: string;
  iconUrl?: string;
  capabilities: {
    streaming: false;
    pushNotifications: false;
    extensions: Array<{
      uri: string;
      description: string;
      required: boolean;
      params?: Record<string, unknown>;
    }>;
  };
  securitySchemes: Record<
    string,
    { httpAuthSecurityScheme: { scheme: string; description: string } }
  >;
  securityRequirements: Array<{ schemes: Record<string, { list: string[] }> }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
  }>;
  signatures?: JwsSignature[];
}

export interface CompileCardOptions {
  agentId: string;
  /** Public origin (https). http is accepted only for loopback development hosts. */
  baseUrl: string;
  provider: { organization: string; url: string };
  /** Card version; defaults to `m-<first 12 hex of manifestHash>` so it changes with content. */
  version?: string;
  documentationUrl?: string;
  iconUrl?: string;
  /** Optional extensions after the required auth extension (for example the passport). */
  extensions?: AgentCard['capabilities']['extensions'];
}

export const NATIVE_SECURITY_SCHEME = 'centralCityNative';
export const DEFAULT_INPUT_MODES = ['text/plain'];
export const DEFAULT_OUTPUT_MODES = ['application/json'];

const CAPABILITY_SKILLS: Record<string, { name: string; description: string }> = {
  research: {
    name: 'Research brief',
    description: 'Organizes supplied text into a short brief with its source URLs.',
  },
  extract: {
    name: 'Field extraction',
    description: 'Extracts key/value fields, URLs and numbers from supplied text.',
  },
  verify: {
    name: 'Structural check',
    description: 'Runs structural checks on supplied text; factual accuracy is not verified.',
  },
};

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Agent Card base URL must use https (http only for loopback development).');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Agent Card base URL must be a plain origin or path.');
  return url.href.replace(/\/+$/, '');
}

export function compileAgentCard(
  resolved: ResolvedAgentManifest,
  options: CompileCardOptions,
): AgentCard {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(options.agentId))
    throw new Error('Agent id must be a bounded opaque identifier.');
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const { metadata, spec } = resolved;
  const skills: AgentCard['skills'] = spec.skills.length
    ? spec.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: [...skill.tags],
        ...(skill.examples ? { examples: [...skill.examples] } : {}),
        ...(skill.inputModes ? { inputModes: [...skill.inputModes] } : {}),
        ...(skill.outputModes ? { outputModes: [...skill.outputModes] } : {}),
      }))
    : spec.capabilities.map((capability) => ({
        id: capability,
        name: CAPABILITY_SKILLS[capability]?.name ?? capability,
        description:
          CAPABILITY_SKILLS[capability]?.description ?? `Declared capability ${capability}.`,
        tags: [capability],
      }));
  const card: AgentCard = {
    name: metadata.displayName,
    description: metadata.description || metadata.displayName,
    supportedInterfaces: [
      {
        // The live A2A message endpoint. `/a2a/<agentId>` is reserved as a future alias; today it
        // serves only the Agent Card at /a2a/<agentId>/.well-known/agent-card.json.
        url: `${baseUrl}/api/runtime/a2a/${options.agentId}`,
        protocolBinding: A2A_PIN.binding as 'JSONRPC',
        protocolVersion: A2A_PIN.wireVersion,
      },
    ],
    provider: { organization: options.provider.organization, url: options.provider.url },
    version:
      options.version ??
      `m-${hashManifest(resolved).slice('sha256:'.length, 'sha256:'.length + 12)}`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: A2A_AUTH_EXTENSION,
          description:
            'Private Central City native authentication: bearer runtime credential plus HMAC request signature.',
          required: true,
        },
        ...(options.extensions ?? []),
      ],
    },
    securitySchemes: {
      [NATIVE_SECURITY_SCHEME]: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          description: `Native runtime credential; requests must also satisfy ${A2A_AUTH_EXTENSION}.`,
        },
      },
    },
    securityRequirements: [{ schemes: { [NATIVE_SECURITY_SCHEME]: { list: [] } } }],
    defaultInputModes: [...DEFAULT_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_OUTPUT_MODES],
    skills,
  };
  if (options.documentationUrl) card.documentationUrl = options.documentationUrl;
  if (options.iconUrl) card.iconUrl = options.iconUrl;
  return card;
}

const unsigned = (card: AgentCard) => {
  const { signatures: _signatures, ...rest } = card;
  return rest;
};

/**
 * Adds a signature over the JCS form of the card without `signatures`. Existing signatures are
 * kept, so a card can carry signatures from both the outgoing and incoming key during rotation.
 */
export function signAgentCard(
  card: AgentCard,
  key: SigningKey,
  header: { jku?: string } = {},
): AgentCard {
  const signature = signDetached(unsigned(card), key, header.jku ? { jku: header.jku } : {});
  return {
    ...card,
    signatures: [...(card.signatures ?? []).filter((s) => !sameKid(s, key.kid)), signature],
  };
}

function sameKid(signature: JwsSignature, kid: string): boolean {
  try {
    return JSON.parse(Buffer.from(signature.protected, 'base64url').toString('utf8')).kid === kid;
  } catch {
    return false;
  }
}

/** Valid when at least one signature verifies against a key in `jwks`; reports every result. */
export function verifyAgentCard(
  card: AgentCard,
  jwks: Jwks,
): { valid: boolean; results: VerifyResult[] } {
  const signatures = Array.isArray(card.signatures) ? card.signatures : [];
  const results = signatures.map((signature) => verifyDetached(unsigned(card), signature, jwks));
  return { valid: results.some((result) => result.valid), results };
}
