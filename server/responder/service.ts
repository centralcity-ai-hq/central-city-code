import { randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { event, PRESENCE_TTL, type Workspace } from '../model.js';
import { encryptApiKey } from './crypto.js';
import { setResponderTarget } from './targets.js';
import type { ResponderKeyring } from './keys.js';
import {
  DEFAULT_MODEL,
  RESPONDER_MODELS,
  estimatedCostPerReplyUsd,
  findModel,
  type Provider,
} from './models.js';
import {
  VALIDATION_TIMEOUT_MS,
  checkKeyFormat,
  fetchTransport,
  mapValidationStatus,
  validationRequest,
  type ProviderTransport,
} from './providers.js';

/**
 * Hosted responder owner settings and write-only provider keys (docs/RESPONDER.md).
 * Only the signed-in owner reaches this service (console
 * session routes; no MCP tool or grant). Replies themselves (queue, prompt, caps in use) are S2/S3:
 * in S1 a responder can be configured and switched on, but nothing replies yet.
 */
export class ResponderError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
const refuse = (status: number, code: string, message: string): never => {
  throw new ResponderError(status, code, message);
};

export const RESPONDER_LIMITS = {
  keySavesPerOwnerPerHour: 10,
  keySavesPerAddressPerHour: 20,
  settingsWritesPerOwnerPerHour: 120,
} as const;
const HOUR = 3_600_000;
/** Pause reasons that a new, validated key resolves. */
const KEY_REASONS = ['invalid_key', 'forbidden', 'key_removed'];

export interface ResponderDependencies {
  db: Pick<Database, 'query'>;
  clock: () => number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T>;
  keys: ResponderKeyring;
  transport?: ProviderTransport;
  /**
   * Whether this server posts replies (S2b delivery attached). Default: the root key is
   * available, which is exactly when the app attaches delivery.
   */
  repliesAvailable?: boolean;
}

export interface ResponderKeyView {
  provider: Provider;
  added_at: string;
  validated_at: string | null;
  status: 'active' | 'invalid';
}
export interface ResponderSettingsView {
  agent_id: string;
  enabled: boolean;
  status: 'off' | 'active' | 'paused';
  pause_reason: string | null;
  paused_until: string | null;
  provider: Provider | null;
  model: string | null;
  instructions: string;
  daily_reply_cap: number;
  daily_spend_cap_usd: number;
  key: ResponderKeyView | null;
  /** True when this server delivers replies (the root key is set and delivery is attached). */
  replies_available: boolean;
}

type SettingsRow = {
  agent_id: string;
  enabled: boolean;
  provider: Provider;
  model: string;
  instructions: string;
  daily_reply_cap: number;
  daily_spend_cap_microusd: string | number;
  status: 'active' | 'paused';
  pause_reason: string | null;
  paused_until: string | number | null;
};
type CredentialRow = {
  provider: Provider;
  status: 'active' | 'invalid';
  created_at: string | number;
  validated_at: string | number | null;
};

const iso = (value: string | number | null) =>
  value === null ? null : new Date(Number(value)).toISOString();

export interface SettingsUpdate {
  enabled?: boolean;
  model?: string;
  instructions?: string;
  daily_reply_cap?: number;
  daily_spend_cap_usd?: number;
}

/**
 * Whether an owner's agent can answer a message now, and how (GET /api/agents/:id/answering):
 * Auto-reply on with a working key (the rooms' own auto_responders rule), or its runtime connected
 * (seen within the presence window). The owner's console shows "<agent> can't answer yet" from it.
 *
 * A CC agent (hosted, `isDemo`: "Create a CC agent", the host New room makes) runs on the
 * platform's scripted runtime: its heartbeat is synthetic (server/app.ts refreshPresence) and it
 * only completes jobs with deterministic text processing (templates.ts). It never posts in a room
 * or a chat, so its heartbeat never makes it answer: `scripted` says so, `runtime_connected` still
 * reports the heartbeat as it is, and only Auto-reply makes such an agent answer.
 */
export interface AgentAnswering {
  agent_id: string;
  can: boolean;
  by: 'auto_reply' | 'runtime' | null;
  /** Auto-reply as it stands: on, paused (a key or cap problem), set up but off, or never set up. */
  auto_reply: 'on' | 'paused' | 'off' | 'none';
  runtime_connected: boolean;
  /** A CC agent's scripted runtime (no AI model): connected or not, it never answers messages. */
  scripted: boolean;
}

export interface Responder {
  readonly available: boolean;
  answering(operatorId: string, agentId: string): Promise<AgentAnswering>;
  models(provider?: Provider): {
    models: {
      provider: Provider;
      id: string;
      name: string;
      est_cost_per_reply_usd: number;
      default: boolean;
    }[];
  };
  get(operatorId: string, agentId: string): Promise<ResponderSettingsView>;
  update(
    operatorId: string,
    actor: string,
    agentId: string,
    body: SettingsUpdate,
  ): Promise<ResponderSettingsView>;
  /** Validates with the provider, then stores the key encrypted. `key` is zeroized before return. */
  setKey(
    operatorId: string,
    actor: string,
    agentId: string,
    body: { provider: Provider; model?: string; key: Buffer },
    address: string,
  ): Promise<{ key: ResponderKeyView }>;
  removeKey(
    operatorId: string,
    actor: string,
    agentId: string,
  ): Promise<{ agent_id: string; removed: boolean }>;
}

export function createResponder(d: ResponderDependencies): Responder {
  const transport = d.transport ?? fetchTransport;
  const unavailable = () =>
    refuse(503, 'responder_unavailable', 'Auto-reply is not available on this server right now.');

  function liveAgent(workspace: Workspace, agentId: string) {
    const agent = workspace.agents.find((item) => item.id === agentId);
    if (!agent) refuse(404, 'agent_not_found', 'Agent not found in this workspace.');
    if (agent!.revokedAt) refuse(403, 'agent_revoked', `${agent!.name} is revoked.`);
    return agent!;
  }
  async function readWorkspace(q: Pick<Tx, 'query'>, operatorId: string): Promise<Workspace> {
    const row = (
      await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0];
    return row?.data ?? refuse(401, 'unauthorized', 'Sign in to continue.');
  }
  async function view(
    q: Pick<Tx, 'query'>,
    operatorId: string,
    agentId: string,
  ): Promise<ResponderSettingsView> {
    const settings = (
      await q.query<SettingsRow>(
        `SELECT agent_id,enabled,provider,model,instructions,daily_reply_cap,daily_spend_cap_microusd,
                status,pause_reason,paused_until
           FROM responder_settings WHERE agent_id=$1 AND owner_id=$2`,
        [agentId, operatorId],
      )
    ).rows[0];
    const credential = (
      await q.query<CredentialRow>(
        `SELECT provider,status,created_at,validated_at FROM responder_credentials
          WHERE agent_id=$1 AND owner_id=$2 AND status <> 'revoked'`,
        [agentId, operatorId],
      )
    ).rows[0];
    return {
      agent_id: agentId,
      enabled: settings?.enabled ?? false,
      status: !settings?.enabled ? 'off' : settings.status,
      pause_reason: settings?.pause_reason ?? null,
      paused_until: iso(settings?.paused_until ?? null),
      provider: settings?.provider ?? null,
      model: settings?.model ?? null,
      instructions: settings?.instructions ?? '',
      daily_reply_cap: settings?.daily_reply_cap ?? 100,
      daily_spend_cap_usd: Number(settings?.daily_spend_cap_microusd ?? 2_000_000) / 1_000_000,
      key: credential
        ? {
            provider: credential.provider,
            added_at: iso(credential.created_at)!,
            validated_at: iso(credential.validated_at),
            status: credential.status,
          }
        : null,
      replies_available: d.repliesAvailable ?? d.keys.available,
    };
  }

  return {
    available: d.keys.available,
    async answering(operatorId, agentId) {
      const agent = liveAgent(await readWorkspace(d.db, operatorId), agentId);
      const time = d.clock();
      // Auto-reply counts only as the rooms count it (rooms/service.ts autoResponders): settings on
      // and active, a working key, and its wake target live.
      const reply = (
        await d.db.query<{ enabled: boolean; status: string; live: boolean }>(
          `SELECT s.enabled, s.status,
             (s.enabled AND s.status='active'
               AND EXISTS (SELECT 1 FROM responder_credentials c
                            WHERE c.agent_id=s.agent_id AND c.owner_id=s.owner_id AND c.status='active')
               AND EXISTS (SELECT 1 FROM wake_webhooks w
                            WHERE w.agent_id=s.agent_id AND w.kind='responder' AND w.disabled_at IS NULL)) AS live
           FROM responder_settings s WHERE s.agent_id=$1 AND s.owner_id=$2`,
          [agentId, operatorId],
        )
      ).rows[0];
      const autoReply: AgentAnswering['auto_reply'] = !reply
        ? 'none'
        : reply.live
          ? 'on'
          : reply.enabled
            ? 'paused'
            : 'off';
      // A connected runtime: an external agent's live presence row, else the workspace's own record.
      const seen = (
        await d.db.query<{ last_seen_at: string | number | null }>(
          'SELECT last_seen_at FROM agent_presence WHERE agent_id=$1 AND operator_id=$2',
          [agentId, operatorId],
        )
      ).rows[0]?.last_seen_at;
      const lastSeen =
        agent.mode === 'external' && seen !== undefined && seen !== null
          ? Number(seen)
          : agent.lastSeenAt
            ? Date.parse(agent.lastSeenAt)
            : null;
      const runtime = lastSeen !== null && time - lastSeen < PRESENCE_TTL;
      // Elric is hosted too, but not scripted (isDemo false): it answers through its own model.
      const scripted = agent.mode === 'hosted' && agent.isDemo === true;
      const answers = runtime && !scripted;
      return {
        agent_id: agentId,
        can: autoReply === 'on' || answers,
        by: autoReply === 'on' ? 'auto_reply' : answers ? 'runtime' : null,
        auto_reply: autoReply,
        runtime_connected: runtime,
        scripted,
      };
    },
    models(provider) {
      if (!d.keys.available) unavailable();
      return {
        models: RESPONDER_MODELS.filter((model) => !provider || model.provider === provider).map(
          (model) => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            est_cost_per_reply_usd: estimatedCostPerReplyUsd(model),
            default: DEFAULT_MODEL[model.provider] === model.id,
          }),
        ),
      };
    },

    async get(operatorId, agentId) {
      if (!d.keys.available) unavailable();
      liveAgent(await readWorkspace(d.db, operatorId), agentId);
      return view(d.db, operatorId, agentId);
    },

    async update(operatorId, actor, agentId, body) {
      if (!d.keys.available) unavailable();
      await d.limit(
        `responder-settings:${operatorId}`,
        RESPONDER_LIMITS.settingsWritesPerOwnerPerHour,
        HOUR,
      );
      return d.mutate(operatorId, async (workspace, tx, time) => {
        const agent = liveAgent(workspace, agentId);
        const current = (
          await tx.query<SettingsRow>(
            'SELECT * FROM responder_settings WHERE agent_id=$1 AND owner_id=$2 FOR UPDATE',
            [agentId, operatorId],
          )
        ).rows[0];
        if (!current) refuse(409, 'key_required', 'Add an OpenAI or Anthropic API key first.');
        const model = body.model ?? current!.model;
        if (!findModel(current!.provider, model))
          refuse(400, 'model_not_allowed', 'Choose one of the listed models for this provider.');
        const credential = (
          await tx.query<{ status: string }>(
            "SELECT status FROM responder_credentials WHERE agent_id=$1 AND owner_id=$2 AND status <> 'revoked'",
            [agentId, operatorId],
          )
        ).rows[0];
        const enabling = body.enabled === true;
        if (enabling && credential?.status !== 'active')
          refuse(409, 'key_required', 'Add a working API key before turning auto-reply on.');
        // Turning on is also "resume": a pause is cleared when the key is fine again.
        const resume = enabling && (current!.status === 'paused' || !current!.enabled);
        await tx.query(
          `UPDATE responder_settings SET
             enabled=$3, model=$4, instructions=$5, daily_reply_cap=$6, daily_spend_cap_microusd=$7,
             status=CASE WHEN $8 THEN 'active' ELSE status END,
             pause_reason=CASE WHEN $8 THEN NULL ELSE pause_reason END,
             paused_until=CASE WHEN $8 THEN NULL ELSE paused_until END,
             consecutive_failures=CASE WHEN $8 THEN 0 ELSE consecutive_failures END,
             enabled_at=CASE WHEN $8 THEN $9 ELSE enabled_at END,
             updated_at=$9, updated_by=$10
           WHERE agent_id=$1 AND owner_id=$2`,
          [
            agentId,
            operatorId,
            body.enabled ?? current!.enabled,
            model,
            body.instructions ?? current!.instructions,
            body.daily_reply_cap ?? current!.daily_reply_cap,
            body.daily_spend_cap_usd === undefined
              ? Number(current!.daily_spend_cap_microusd)
              : Math.round(body.daily_spend_cap_usd * 1_000_000),
            resume,
            time,
            actor,
          ],
        );
        // The wake target follows the switch: on when enabled (it resumes a pause too), off otherwise.
        const on = body.enabled ?? current!.enabled;
        if (body.enabled !== undefined || resume)
          await setResponderTarget(tx, { agentId, ownerId: operatorId, on, time, actor });
        if (body.enabled !== undefined && body.enabled !== current!.enabled)
          event(
            workspace,
            time,
            body.enabled ? 'responder.enabled' : 'responder.disabled',
            `Auto-reply ${body.enabled ? 'turned on' : 'turned off'} for ${agent.name}.`,
            agentId,
          );
        return view(tx, operatorId, agentId);
      });
    },

    async setKey(operatorId, actor, agentId, body, address) {
      try {
        if (!d.keys.available) return unavailable();
        const keys = d.keys;
        // Every attempt spends budget, including bad keys: the validation call must not become an
        // oracle for testing stolen keys.
        await d.limit(
          `responder-key:${operatorId}`,
          RESPONDER_LIMITS.keySavesPerOwnerPerHour,
          HOUR,
        );
        await d.limit(
          `responder-key-ip:${address}`,
          RESPONDER_LIMITS.keySavesPerAddressPerHour,
          HOUR,
        );
        liveAgent(await readWorkspace(d.db, operatorId), agentId);
        const format = checkKeyFormat(body.provider, body.key);
        if (format === 'unsupported_key')
          refuse(400, 'unsupported_key', 'Use a standard API key, not an admin key.');
        if (format !== 'ok')
          refuse(
            400,
            'invalid_key_format',
            body.provider === 'anthropic'
              ? 'That does not look like an Anthropic API key (it starts with sk-ant-api).'
              : 'That does not look like an OpenAI API key (it starts with sk-).',
          );
        const existing = (
          await d.db.query<{ provider: Provider; model: string }>(
            'SELECT provider,model FROM responder_settings WHERE agent_id=$1 AND owner_id=$2',
            [agentId, operatorId],
          )
        ).rows[0];
        const model =
          body.model ??
          (existing?.provider === body.provider ? existing.model : DEFAULT_MODEL[body.provider]);
        if (!findModel(body.provider, model))
          refuse(400, 'model_not_allowed', 'Choose one of the listed models for this provider.');

        // The provider call holds no database connection. Its answer is reduced to a status code.
        let status: number;
        try {
          status = (
            await transport(
              validationRequest(body.provider, model, body.key.toString('latin1')),
              VALIDATION_TIMEOUT_MS,
            )
          ).status;
        } catch {
          status = 0;
        }
        const result = mapValidationStatus(status);
        if (!result.ok) {
          const name = body.provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
          const messages = {
            invalid_key: `${name} didn't accept this key. Check that you copied all of it.`,
            forbidden_key: `${name} says this key isn't allowed to do that. Check the key's permissions.`,
            model_unavailable: `This key can't use ${model}. Pick another model.`,
            provider_unreachable: `We couldn't reach ${name}. Try again in a minute.`,
          } as const;
          refuse(
            result.code === 'provider_unreachable' ? 502 : 400,
            result.code,
            messages[result.code],
          );
        }

        return await d.mutate(operatorId, async (workspace, tx, time) => {
          const agent = liveAgent(workspace, agentId);
          const id = `rsk_${randomUUID()}`;
          const sealed = encryptApiKey(
            keys.current.key,
            { id, agentId, ownerId: operatorId, provider: body.provider },
            body.key,
          );
          await tx.query(
            `UPDATE responder_credentials SET status='revoked', ciphertext=NULL, wrapped_dek=NULL,
               kek_id=NULL, revoked_at=$3, revoked_by=$4
             WHERE agent_id=$1 AND owner_id=$2 AND status <> 'revoked'`,
            [agentId, operatorId, time, actor],
          );
          await tx.query(
            `INSERT INTO responder_credentials(id,agent_id,owner_id,provider,kek_id,wrapped_dek,ciphertext,
               status,created_at,created_by,validated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$8)`,
            [
              id,
              agentId,
              operatorId,
              body.provider,
              keys.current.kid,
              sealed.wrappedDek,
              sealed.ciphertext,
              time,
              actor,
            ],
          );
          await tx.query(
            `INSERT INTO responder_settings(agent_id,owner_id,provider,model,created_at,updated_at,updated_by)
             VALUES($1,$2,$3,$4,$5,$5,$6)
             ON CONFLICT (agent_id) DO UPDATE SET provider=EXCLUDED.provider, model=EXCLUDED.model,
               status=CASE WHEN responder_settings.pause_reason = ANY($7::text[]) THEN 'active'
                           ELSE responder_settings.status END,
               pause_reason=CASE WHEN responder_settings.pause_reason = ANY($7::text[]) THEN NULL
                                 ELSE responder_settings.pause_reason END,
               updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by
             WHERE responder_settings.owner_id = EXCLUDED.owner_id`,
            [agentId, operatorId, body.provider, model, time, actor, KEY_REASONS],
          );
          event(
            workspace,
            time,
            'responder.key_set',
            `An ${body.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key was added for ${agent.name}'s auto-reply.`,
            agentId,
          );
          const current = (await view(tx, operatorId, agentId)).key!;
          return { key: current };
        });
      } finally {
        body.key.fill(0);
      }
    },

    async removeKey(operatorId, actor, agentId) {
      if (!d.keys.available) unavailable();
      return d.mutate(operatorId, async (workspace, tx, time) => {
        const agent = liveAgent(workspace, agentId);
        const revoked = await tx.query(
          `UPDATE responder_credentials SET status='revoked', ciphertext=NULL, wrapped_dek=NULL,
             kek_id=NULL, revoked_at=$3, revoked_by=$4
           WHERE agent_id=$1 AND owner_id=$2 AND status <> 'revoked' RETURNING id`,
          [agentId, operatorId, time, actor],
        );
        await tx.query(
          `UPDATE responder_settings SET enabled=false, status='paused', pause_reason='key_removed',
             updated_at=$3, updated_by=$4 WHERE agent_id=$1 AND owner_id=$2`,
          [agentId, operatorId, time, actor],
        );
        await setResponderTarget(tx, { agentId, ownerId: operatorId, on: false, time, actor });
        const removed = revoked.rows.length > 0;
        if (removed)
          event(
            workspace,
            time,
            'responder.key_removed',
            `The API key for ${agent.name}'s auto-reply was removed; auto-reply is off.`,
            agentId,
          );
        return { agent_id: agentId, removed };
      });
    },
  };
}
