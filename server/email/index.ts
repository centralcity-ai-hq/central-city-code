import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Transaction } from '../database.js';
import { opsAuthorized } from '../elric/ops.js';
import { cronAuthorized } from '../wake/cron.js';
import { NEWSLETTER_TEXT_VERSION, type NewsletterStatus } from '../../shared/newsletter.js';
import { newsletterEmailSchema } from '../../shared/newsletter-schema.js';
import {
  EmailSendError,
  emailConfig,
  fetchTransport,
  resendProvider,
  type EmailProvider,
  type EmailTransport,
} from './provider.js';
import { CONFIRM_TOKEN_SLOT, newsletterConfirmEmail, welcomeEmail } from './templates.js';

export { registerEmailMigration, EMAIL_TABLES } from './schema.js';

/**
 * Transactional email and the newsletter consent (docs/EMAIL.md).
 *
 * - Sending is off unless CITY_EMAIL_API_KEY, CITY_EMAIL_FROM and CITY_EMAIL_LINK_KEY are set.
 *   While it is off, newsletter opt-ins are still recorded and their confirmation emails stay
 *   queued; the welcome email is not queued at all.
 * - Emails are queued in `email_outbox` (one row per dedupe key) and sent by the drain: right
 *   after the request that queued them (never blocking it) and every minute from
 *   `GET /api/cron/email-drain` (CRON_SECRET), with retries and backoff. A confirmation link is
 *   signed when the email is sent, so a queued email never carries an expired link.
 * - Newsletter: double opt-in. The opt-in stores the address, the exact text version, the source
 *   and the time; a signed link (7 days) confirms it. Only confirmed, not withdrawn addresses are
 *   subscribers. Every issue carries a one-click unsubscribe link and List-Unsubscribe headers.
 *   Unconfirmed sign-ups are deleted after 30 days. Addresses are never logged.
 */

type Q = Pick<Transaction, 'query'>;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const EMAIL_LIMITS = {
  /** Confirmation links expire after 7 days (EMAIL_COPY.md). */
  confirmTtlMs: 7 * DAY,
  /** Sent and failed queue rows (address and body) are deleted after 30 days. */
  outboxRetentionMs: 30 * DAY,
  /** Unconfirmed sign-ups are deleted after 30 days (EMAIL_COPY.md). */
  unconfirmedTtlMs: 30 * DAY,
  /** Consent records are kept 2 years after unsubscribing, as proof (pending the lawyer). */
  retentionAfterUnsubscribeMs: 730 * DAY,
  maxAttempts: 8,
  batch: 20,
  leaseMs: 5 * MINUTE,
} as const;

export type NewsletterSource = 'signup' | 'onboarding' | 'settings';
/** Subscribe attempts from account settings: per account and per address (docs/EMAIL.md). */
export const NEWSLETTER_RATE = { perAccount: 5, perAddress: 20, windowMs: 60 * MINUTE } as const;

export interface EmailOptions {
  /** The environment (CITY_EMAIL_*); defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** The provider's HTTP transport (tests inject a fake). */
  transport?: EmailTransport;
  /** Drain right after a request queues an email (default true; tests drain explicitly). */
  autoDrain?: boolean;
}

export interface EmailDeps {
  db: Database;
  clock(): number;
  options?: EmailOptions;
  /** The public origin for links in emails (the request's origin when not hosted). */
  originOf(request: FastifyRequest): string;
  /** Whether Elric is on (the welcome email names it only then). */
  elricEnabled(): boolean;
  /** The signed-in person (session), or a 401. */
  owner(request: FastifyRequest): Promise<{ id: string }>;
  cronSecret?: string;
  /** The shared rate limiter (a 429 when the budget is spent). */
  limit(key: string, max: number, windowMs: number, message?: string): Promise<void>;
  /** The request's client address key (for per-address limits). */
  clientKey(request: FastifyRequest): string;
}

export interface NewsletterRecord {
  email: string;
  status: NewsletterStatus;
  source: string;
  text_version: string;
  opted_in_at: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
}

export interface EmailService {
  enabled(): boolean;
  /** The account's email address (its Google link), or null. */
  emailOf(q: Q, operatorId: string): Promise<string | null>;
  /** Queues the welcome email once per account (no-op when off or without an address). */
  queueWelcome(tx: Q, operatorId: string, name: string, origin: string): Promise<void>;
  /**
   * Records a newsletter opt-in (pending) and queues its confirmation email, to `email` or else
   * the account's Google address. False when there is no address. Works while sending is off:
   * the email stays queued until the provider is configured.
   */
  optIn(
    tx: Q,
    operatorId: string,
    source: NewsletterSource,
    origin: string,
    email?: string,
  ): Promise<boolean>;
  /** Withdraws the consent (no-op unless pending or subscribed); drops an unsent confirmation. */
  unsubscribe(tx: Q, operatorId: string): Promise<void>;
  /** The account's newsletter record for its data export, or null. */
  record(q: Q, operatorId: string): Promise<NewsletterRecord | null>;
  status(q: Q, operatorId: string): Promise<NewsletterStatus>;
  /** Sends due emails; returns counts. */
  drain(): Promise<{ sent: number; failed: number; retried: number }>;
  /** Starts a drain without waiting for it (after a request that queued an email). */
  kick(): void;
  /** Deletes expired unconfirmed sign-ups and consent records past retention. */
  purge(): Promise<void>;
  unsubscribeUrl(origin: string, operatorId: string): string;
}

export function registerEmail(app: FastifyInstance, d: EmailDeps): EmailService {
  const env = () => d.options?.env ?? process.env;
  const config = () => emailConfig(env());
  const transport = d.options?.transport ?? fetchTransport;
  const provider = (): EmailProvider | null => {
    const value = config();
    return value ? resendProvider(value, transport) : null;
  };

  // Link signing: CITY_EMAIL_LINK_KEY (required for email to be on; provider.ts emailConfig).
  // Links are signed with it and accepted under it or CITY_EMAIL_LINK_KEY_PREVIOUS, so a rotation
  // keeps the links already sent working while the previous key is kept (docs/EMAIL.md).
  const derive = (secret: string) =>
    Buffer.from(hkdfSync('sha256', secret, '', 'central-city/newsletter-links/v1', 32));
  const linkKeys = () => {
    const value = config();
    return value
      ? [value.linkKey, ...(value.previousLinkKey ? [value.previousLinkKey] : [])].map(derive)
      : [];
  };
  const mac = (key: Buffer, payload: string) =>
    createHmac('sha256', key).update(payload).digest('base64url');
  // `stamp` names the one sign-up (its opted_in_at); `issued` starts the confirm link's 7 days.
  function sign(
    purpose: 'confirm' | 'unsubscribe',
    operatorId: string,
    stamp: number,
    issued = 0,
  ): string {
    const key = linkKeys()[0];
    if (!key) throw new Error('Email links need CITY_EMAIL_LINK_KEY.');
    const payload = Buffer.from(JSON.stringify([purpose, operatorId, stamp, issued])).toString(
      'base64url',
    );
    return `${payload}.${mac(key, payload)}`;
  }
  function verify(token: unknown, purpose: 'confirm' | 'unsubscribe') {
    if (typeof token !== 'string' || token.length > 400) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const given = Buffer.from(signature);
    const valid = linkKeys().some((key) => {
      const expected = Buffer.from(mac(key, payload));
      return expected.length === given.length && timingSafeEqual(expected, given);
    });
    if (!valid) return null;
    try {
      const [kind, operatorId, stamp, issued] = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
      );
      if (
        kind !== purpose ||
        typeof operatorId !== 'string' ||
        typeof stamp !== 'number' ||
        typeof issued !== 'number'
      )
        return null;
      return { operatorId, stamp, issued };
    } catch {
      return null;
    }
  }

  async function event(q: Q, operatorId: string, kind: string, time: number) {
    await q.query(
      `INSERT INTO newsletter_consent_events(operator_id,event,email,text_version,source,at)
       SELECT operator_id,$2,email,text_version,source,$3 FROM newsletter_consents WHERE operator_id=$1`,
      [operatorId, kind, time],
    );
  }

  async function enqueue(
    q: Q,
    row: {
      operatorId: string;
      key: string;
      kind: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    },
  ) {
    const time = d.clock();
    await q.query(
      `INSERT INTO email_outbox(operator_id,dedupe_key,kind,to_email,subject,body,html,next_attempt_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
      [row.operatorId, row.key, row.kind, row.to, row.subject, row.text, row.html, time],
    );
  }

  let draining: Promise<unknown> | null = null;

  const service: EmailService = {
    enabled: () => config() !== null,
    async emailOf(q, operatorId) {
      return (
        (
          await q.query<{ email: string }>(
            "SELECT email FROM elric_verified_identities WHERE operator_id=$1 AND provider='google' AND email_verified",
            [operatorId],
          )
        ).rows[0]?.email ?? null
      );
    },
    async queueWelcome(tx, operatorId, name, origin) {
      if (!service.enabled()) return;
      const to = await service.emailOf(tx, operatorId);
      if (!to) return;
      const text = welcomeEmail({ name, origin, elric: d.elricEnabled() });
      await enqueue(tx, { operatorId, key: `welcome:${operatorId}`, kind: 'welcome', to, ...text });
    },
    async optIn(tx, operatorId, source, origin, email) {
      const to = email ?? (await service.emailOf(tx, operatorId));
      if (!to) return false;
      const time = d.clock();
      const current = await service.status(tx, operatorId);
      if (current === 'subscribed') return true;
      // A new sign-up replaces an unsent confirmation of an earlier one.
      await tx.query(
        `DELETE FROM email_outbox WHERE operator_id=$1 AND kind='newsletter_confirm' AND sent_at IS NULL AND failed_at IS NULL`,
        [operatorId],
      );
      await tx.query(
        `INSERT INTO newsletter_consents(operator_id,email,text_version,source,opted_in_at)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (operator_id) DO UPDATE SET email=EXCLUDED.email, text_version=EXCLUDED.text_version,
           source=EXCLUDED.source, opted_in_at=EXCLUDED.opted_in_at, confirmed_at=NULL, unsubscribed_at=NULL`,
        [operatorId, to, NEWSLETTER_TEXT_VERSION, source, time],
      );
      await event(tx, operatorId, 'opt_in', time);
      // The link is signed when the email is sent (drain), so its 7 days start then.
      const text = newsletterConfirmEmail({
        confirmUrl: `${origin}/newsletter/confirm?t=${CONFIRM_TOKEN_SLOT}`,
        origin,
      });
      await enqueue(tx, {
        operatorId,
        key: `newsletter_confirm:${operatorId}:${time}`,
        kind: 'newsletter_confirm',
        to,
        ...text,
      });
      return true;
    },
    async unsubscribe(tx, operatorId) {
      const time = d.clock();
      const updated = await tx.query(
        'UPDATE newsletter_consents SET unsubscribed_at=$2 WHERE operator_id=$1 AND unsubscribed_at IS NULL RETURNING operator_id',
        [operatorId, time],
      );
      if (updated.rows.length) await event(tx, operatorId, 'unsubscribe', time);
      await tx.query(
        `DELETE FROM email_outbox WHERE operator_id=$1 AND kind='newsletter_confirm' AND sent_at IS NULL AND failed_at IS NULL`,
        [operatorId],
      );
    },
    async record(q, operatorId) {
      const row = (
        await q.query<{
          email: string;
          source: string;
          text_version: string;
          opted_in_at: string;
          confirmed_at: string | null;
          unsubscribed_at: string | null;
        }>(
          'SELECT email,source,text_version,opted_in_at,confirmed_at,unsubscribed_at FROM newsletter_consents WHERE operator_id=$1',
          [operatorId],
        )
      ).rows[0];
      if (!row) return null;
      const iso = (value: string | null) =>
        value == null ? null : new Date(Number(value)).toISOString();
      return {
        email: row.email,
        status: await service.status(q, operatorId),
        source: row.source,
        text_version: row.text_version,
        opted_in_at: iso(row.opted_in_at)!,
        confirmed_at: iso(row.confirmed_at),
        unsubscribed_at: iso(row.unsubscribed_at),
      };
    },
    async status(q, operatorId) {
      const row = (
        await q.query<{ confirmed_at: unknown; unsubscribed_at: unknown }>(
          'SELECT confirmed_at,unsubscribed_at FROM newsletter_consents WHERE operator_id=$1',
          [operatorId],
        )
      ).rows[0];
      if (!row) return 'none';
      if (row.unsubscribed_at != null) return 'unsubscribed';
      return row.confirmed_at != null ? 'subscribed' : 'pending';
    },
    async drain() {
      const send = provider();
      const counts = { sent: 0, failed: 0, retried: 0 };
      if (!send) return counts;
      const time = d.clock();
      // Lease a batch (a concurrent drain skips these rows until the lease ends).
      const due = (
        await d.db.query<{
          id: string;
          dedupe_key: string;
          to_email: string;
          subject: string;
          body: string;
          html: string | null;
          attempts: number;
        }>(
          `UPDATE email_outbox SET next_attempt_at=$2
            WHERE id IN (SELECT id FROM email_outbox
                          WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at<=$1
                          ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
          RETURNING id,dedupe_key,to_email,subject,body,html,attempts`,
          [time, time + EMAIL_LIMITS.leaseMs, EMAIL_LIMITS.batch],
        )
      ).rows;
      for (const row of due) {
        let text = row.body;
        let html = row.html;
        if (row.dedupe_key.startsWith('newsletter_confirm:')) {
          // Sign the confirmation link now; drop the email if its sign-up is no longer pending.
          const [, operatorId = '', stamp = ''] = row.dedupe_key.split(':');
          const pending = (
            await d.db.query(
              'SELECT 1 FROM newsletter_consents WHERE operator_id=$1 AND opted_in_at=$2 AND confirmed_at IS NULL AND unsubscribed_at IS NULL',
              [operatorId, stamp],
            )
          ).rows.length;
          if (!pending) {
            await d.db.query('DELETE FROM email_outbox WHERE id=$1', [row.id]);
            continue;
          }
          const token = sign('confirm', operatorId, Number(stamp), d.clock());
          text = text.replace(CONFIRM_TOKEN_SLOT, token);
          html = html?.replaceAll(CONFIRM_TOKEN_SLOT, token) ?? null;
        }
        try {
          await send.send({
            to: row.to_email,
            subject: row.subject,
            text,
            ...(html ? { html } : {}),
            idempotencyKey: row.dedupe_key,
          });
          await d.db.query('UPDATE email_outbox SET sent_at=$2, attempts=attempts+1 WHERE id=$1', [
            row.id,
            d.clock(),
          ]);
          counts.sent += 1;
        } catch (error) {
          const attempts = Number(row.attempts) + 1;
          const retryable = !(error instanceof EmailSendError) || error.retryable;
          const message = error instanceof EmailSendError ? error.message : 'send failed';
          if (retryable && attempts < EMAIL_LIMITS.maxAttempts) {
            const backoff = Math.min(6 * 60 * MINUTE, MINUTE * 2 ** attempts);
            await d.db.query(
              'UPDATE email_outbox SET attempts=$2, next_attempt_at=$3, last_error=$4 WHERE id=$1',
              [row.id, attempts, d.clock() + backoff, message],
            );
            counts.retried += 1;
          } else {
            await d.db.query(
              'UPDATE email_outbox SET attempts=$2, failed_at=$3, last_error=$4 WHERE id=$1',
              [row.id, attempts, d.clock(), message],
            );
            counts.failed += 1;
          }
        }
      }
      return counts;
    },
    kick() {
      if (d.options?.autoDrain === false || !service.enabled() || draining) return;
      draining = service
        .drain()
        .catch(() => undefined)
        .finally(() => {
          draining = null;
        });
    },
    async purge() {
      const time = d.clock();
      await d.db.transaction(async (tx) => {
        const expired = (
          await tx.query<{ operator_id: string }>(
            'SELECT operator_id FROM newsletter_consents WHERE confirmed_at IS NULL AND unsubscribed_at IS NULL AND opted_in_at<$1',
            [time - EMAIL_LIMITS.unconfirmedTtlMs],
          )
        ).rows;
        for (const row of expired) {
          await event(tx, row.operator_id, 'expired', time);
          await tx.query('DELETE FROM newsletter_consents WHERE operator_id=$1', [row.operator_id]);
          await tx.query(
            `DELETE FROM email_outbox WHERE operator_id=$1 AND kind='newsletter_confirm' AND sent_at IS NULL`,
            [row.operator_id],
          );
        }
        // Sent and failed emails (address and body) are kept 30 days, then deleted.
        await tx.query(
          'DELETE FROM email_outbox WHERE (sent_at IS NOT NULL AND sent_at<$1) OR (failed_at IS NOT NULL AND failed_at<$1)',
          [time - EMAIL_LIMITS.outboxRetentionMs],
        );
        const cutoff = time - EMAIL_LIMITS.retentionAfterUnsubscribeMs;
        await tx.query(
          'DELETE FROM newsletter_consents WHERE unsubscribed_at IS NOT NULL AND unsubscribed_at<$1',
          [cutoff],
        );
        // The events of a consent that no longer exists (withdrawn and purged, expired, or the
        // account deleted), once the latest is past retention: the only delete the append-only
        // trigger allows.
        await tx.query("SELECT set_config('newsletter.purge','on',true)");
        await tx.query(
          `DELETE FROM newsletter_consent_events e
            WHERE NOT EXISTS (SELECT 1 FROM newsletter_consents c WHERE c.operator_id=e.operator_id)
              AND NOT EXISTS (SELECT 1 FROM newsletter_consent_events l
                               WHERE l.operator_id=e.operator_id AND l.at>=$1)`,
          [cutoff],
        );
      });
    },
    unsubscribeUrl(origin, operatorId) {
      return `${origin}/newsletter/unsubscribe?t=${sign('unsubscribe', operatorId, 0)}`;
    },
  };

  const tokenQuery = z.object({ t: z.string().max(400) }).passthrough();

  async function confirm(token: unknown): Promise<boolean> {
    const parsed = verify(token, 'confirm');
    if (!parsed || d.clock() - parsed.issued > EMAIL_LIMITS.confirmTtlMs) return false;
    return d.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE newsletter_consents SET confirmed_at=$3
          WHERE operator_id=$1 AND opted_in_at=$2 AND unsubscribed_at IS NULL
            AND confirmed_at IS NULL RETURNING operator_id`,
        [parsed.operatorId, parsed.stamp, d.clock()],
      );
      if (updated.rows.length) await event(tx, parsed.operatorId, 'confirm', d.clock());
      // Confirming twice is fine: the link still says "subscribed".
      return (
        updated.rows.length > 0 || (await service.status(tx, parsed.operatorId)) === 'subscribed'
      );
    });
  }

  // The links in emails open pages of the app (/newsletter/confirm, /newsletter/unsubscribe),
  // which only show a button: link scanners and previews that open a link change nothing. The
  // button POSTs the signed link here, as does a mail client's RFC 8058 one-click unsubscribe
  // ("List-Unsubscribe=One-Click", form-encoded). Only the signed link counts; these carry no
  // cookie authority (server/app.ts exempts them from the request-protection header).
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_request, body, done) => done(null, body),
    );
    scope.post('/api/newsletter/confirm', async (request, reply) => {
      await d.limit(`newsletter-link:${d.clientKey(request)}`, 30, 15 * MINUTE);
      const parsed = tokenQuery.safeParse(request.query);
      reply.header('Cache-Control', 'no-store');
      if (parsed.success && (await confirm(parsed.data.t))) return { status: 'subscribed' };
      return reply.code(400).send({
        error: 'This confirmation link is invalid or has expired.',
        code: 'newsletter_link_invalid',
      });
    });
    scope.post('/api/newsletter/unsubscribe', async (request, reply) => {
      await d.limit(`newsletter-link:${d.clientKey(request)}`, 30, 15 * MINUTE);
      const parsed = tokenQuery.safeParse(request.query);
      const token = parsed.success ? verify(parsed.data.t, 'unsubscribe') : null;
      reply.header('Cache-Control', 'no-store');
      if (!token)
        return reply
          .code(400)
          .send({ error: 'This unsubscribe link is invalid.', code: 'newsletter_link_invalid' });
      await d.db.transaction((tx) => service.unsubscribe(tx, token.operatorId));
      return { status: 'unsubscribed' };
    });
  });

  // Account settings: status, subscribe (double opt-in again) and unsubscribe.
  async function view(operatorId: string) {
    const record = await service.record(d.db, operatorId);
    return {
      status: record?.status ?? 'none',
      // The address the newsletter goes to (pending or subscribed), else the Google address.
      email:
        record && record.status !== 'unsubscribed'
          ? record.email
          : await service.emailOf(d.db, operatorId),
      has_account_email: (await service.emailOf(d.db, operatorId)) !== null,
    };
  }
  app.get('/api/account/newsletter', async (request, reply) => {
    const owner = await d.owner(request);
    reply.header('Cache-Control', 'no-store');
    return view(owner.id);
  });
  const toggleInput = z
    .object({ subscribe: z.boolean(), email: newsletterEmailSchema.optional() })
    .strict();
  app.post('/api/account/newsletter', async (request: FastifyRequest, reply: FastifyReply) => {
    const owner = await d.owner(request);
    const input = toggleInput.parse(request.body ?? {});
    if (input.subscribe) {
      await d.limit(
        `newsletter:account:${owner.id}`,
        NEWSLETTER_RATE.perAccount,
        NEWSLETTER_RATE.windowMs,
      );
      await d.limit(
        `newsletter:address:${d.clientKey(request)}`,
        NEWSLETTER_RATE.perAddress,
        NEWSLETTER_RATE.windowMs,
      );
      const queued = await d.db.transaction((tx) =>
        service.optIn(tx, owner.id, 'settings', d.originOf(request), input.email),
      );
      if (!queued)
        return reply.code(400).send({
          error: 'Enter the email address for the newsletter.',
          code: 'newsletter_email_required',
        });
      service.kick();
    } else {
      await d.db.transaction((tx) => service.unsubscribe(tx, owner.id));
    }
    return view(owner.id);
  });

  // Ops only (CITY_OPS_SECRET; 404 otherwise): confirmed subscribers, with their unsubscribe link.
  app.get('/api/ops/newsletter/subscribers', async (request, reply) => {
    if (!opsAuthorized(request.headers.authorization, env().CITY_OPS_SECRET))
      return reply.code(404).send({ error: 'Not found.' });
    const origin = d.originOf(request);
    const rows = (
      await d.db.query<{
        operator_id: string;
        email: string;
        text_version: string;
        source: string;
        opted_in_at: string;
        confirmed_at: string;
      }>(
        `SELECT operator_id,email,text_version,source,opted_in_at,confirmed_at FROM newsletter_consents
          WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL ORDER BY confirmed_at`,
      )
    ).rows;
    reply.header('Cache-Control', 'no-store');
    return {
      subscribers: rows.map((row) => ({
        email: row.email,
        text_version: row.text_version,
        source: row.source,
        opted_in_at: new Date(Number(row.opted_in_at)).toISOString(),
        confirmed_at: new Date(Number(row.confirmed_at)).toISOString(),
        unsubscribe_url: service.unsubscribeUrl(origin, row.operator_id),
      })),
    };
  });

  // Vercel Cron (GET with Authorization: Bearer CRON_SECRET; the same check as /api/cron/wake-drain:
  // 404 without a 16+ character secret or with any other header), every minute: send, then purge.
  app.get('/api/cron/email-drain', async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const counts = await service.drain();
    await service.purge();
    return counts;
  });

  return service;
}
export type { NewsletterStatus } from '../../shared/newsletter.js';
