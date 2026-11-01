/*
 * The hosted responder's console API contract, mirrored from the server
 * (`server/responder/service.ts`, `routes.ts`, `models.ts`, `schema.ts`;
 * docs/RESPONDER.md). Copied, not imported, so the UI build does not import server code. Keep in
 * step with the server; tests/responder-ui.test.ts pins the values the UI depends on.
 */
export type Provider = 'openai' | 'anthropic';
export const PROVIDERS: readonly Provider[] = ['openai', 'anthropic'];
export const PROVIDER_NAMES: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** `GET /api/responder/models?provider=` */
export interface ModelOption {
  provider: Provider;
  id: string;
  name: string;
  est_cost_per_reply_usd: number;
  default: boolean;
}

export interface ResponderKeyView {
  provider: Provider;
  added_at: string;
  validated_at: string | null;
  status: 'active' | 'invalid';
}

export const PAUSE_REASONS = [
  'invalid_key',
  'quota',
  'rate_limited',
  'model_unavailable',
  'forbidden',
  'key_removed',
  'repeated_failures',
  /** The server can't open the stored key (its root key is missing); the key itself is fine. */
  'root_key_unavailable',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** `GET/PUT /api/agents/:id/responder` */
export interface ResponderSettingsView {
  agent_id: string;
  enabled: boolean;
  status: 'off' | 'active' | 'paused';
  pause_reason: PauseReason | null;
  paused_until: string | null;
  provider: Provider | null;
  model: string | null;
  instructions: string;
  daily_reply_cap: number;
  daily_spend_cap_usd: number;
  key: ResponderKeyView | null;
  /** S1: settings are stored, but replies are not sent until the execution slices ship. */
  replies_available: boolean;
}

/** `PUT /api/agents/:id/responder` body (strict on the server). */
export interface SettingsUpdate {
  enabled?: boolean;
  model?: string;
  instructions?: string;
  daily_reply_cap?: number;
  daily_spend_cap_usd?: number;
}

/** Bounds and defaults (server zod schema and migration 20 checks). */
export const LIMITS = {
  instructionsMax: 2000,
  replyCap: { min: 1, max: 1000, default: 100 },
  spendCapUsd: { min: 0.01, max: 50, default: 2 },
  keyLength: { min: 20, max: 256 },
} as const;
