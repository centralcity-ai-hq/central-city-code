/*
 * Feed pay ops alerts (docs/FEED_PAY.md section 13): a structured log line always, and a POST of
 * {text, ...FeedPayAlert} to CITY_OPS_ALERT_WEBHOOK when it is set, through the wake webhook
 * transport (https on the default port, a public host, no redirects, 5 s), as the Elric ceiling
 * alert does. Every alert is logged; the webhook gets at most one per kind and service (or wallet)
 * per hour on an instance. Ids and amounts only: never inputs, results, keys, signatures or a
 * person's name. Never throws.
 */
import { httpsWebhookTransport, type WebhookTransport } from '../../wake/webhooks.js';
import {
  FEED_PAY_ALERT_WEBHOOK_FLAG,
  type FeedPayAlert,
  type FeedPayAlertKind,
} from '../../../shared/feed-pay.js';

export const FEED_PAY_ALERT_EVERY_MS = 3_600_000;
const TIMEOUT_MS = 5_000;

const TEXT: Record<FeedPayAlertKind, string> = {
  payee_mismatch:
    'Feed pay: a service asked to be paid at another address than its listing. Nothing was paid.',
  paid_no_result: 'Feed pay: a payment settled on Base but the service sent no result.',
  sweep_failed: "Feed pay: moving an agent's unused USDC back to its wallet failed.",
  protocol_fee_failed:
    'Feed pay: the protocol fee of a paid call could not be charged. The seller was paid; review the fee.',
  payment_rejected: 'Feed pay: a service or its facilitator refused our payment.',
  protocol_fee_screening_hold:
    'Feed pay: the protocol fee of a paid call is on hold because payment screening did not clear it. Nothing was charged; it is screened again later.',
  payment_anomaly:
    'Feed pay: a fee-included payment on Base did not match its call, or Base dropped it after the answer was delivered. Review the payment.',
};

/** The alert as sent: machine words only, `detail` cut to 120 characters. */
function clean(alert: FeedPayAlert): FeedPayAlert {
  const out: FeedPayAlert = { kind: alert.kind, at: alert.at };
  for (const key of ['callId', 'serviceId', 'host', 'agentId', 'walletId', 'amountRaw'] as const)
    if (typeof alert[key] === 'string') out[key] = alert[key];
  if (typeof alert.detail === 'string')
    out.detail = alert.detail.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
  return out;
}

export function createFeedPayAlerts(deps: {
  env: Record<string, string | undefined>;
  transport?: WebhookTransport;
  log?: (line: string) => void;
  now?: () => number;
}) {
  const transport = deps.transport ?? httpsWebhookTransport;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const now = deps.now ?? Date.now;
  const last = new Map<string, number>();
  return async function alert(input: FeedPayAlert): Promise<void> {
    try {
      const value = clean(input);
      // Every alert is a log line (the record ops count from); only the webhook is rate-limited.
      log(JSON.stringify({ event: 'feed_pay_alert', ...value }));
      const key = `${value.kind}:${value.serviceId ?? value.walletId ?? ''}`;
      const at = now();
      const previous = last.get(key);
      if (previous !== undefined && at - previous < FEED_PAY_ALERT_EVERY_MS) return;
      last.set(key, at);
      if (last.size > 10_000) last.clear();
      const url = deps.env[FEED_PAY_ALERT_WEBHOOK_FLAG];
      if (!url) return;
      const { status } = await transport(
        url,
        JSON.stringify({ text: TEXT[value.kind], ...value }),
        { 'content-type': 'application/json' },
        TIMEOUT_MS,
      );
      if (status < 200 || status >= 300)
        log(JSON.stringify({ event: 'feed_pay_alert_failed', kind: value.kind, status }));
    } catch (error) {
      log(
        JSON.stringify({
          event: 'feed_pay_alert_failed',
          kind: input.kind,
          error: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
        }),
      );
    }
  };
}

export type FeedPayAlerter = ReturnType<typeof createFeedPayAlerts>;
