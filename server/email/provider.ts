/**
 * The email provider adapter (docs/EMAIL.md). Default: Resend over its HTTP API. Off (no-op:
 * nothing is queued or sent) unless both CITY_EMAIL_API_KEY and CITY_EMAIL_FROM are set. The key
 * is only ever sent to the provider; it is never logged or returned.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** The HTML part, sent next to the text part (multipart). */
  html?: string;
  headers?: Record<string, string>;
  /** The provider's idempotency key: a retry never sends twice. */
  idempotencyKey: string;
}
export interface EmailTransportResponse {
  status: number;
  body: string;
}
/** HTTP transport (injected in tests; fetch in production). */
export type EmailTransport = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<EmailTransportResponse>;

export const RESEND_URL = 'https://api.resend.com/emails';

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** False for errors a retry cannot fix (a 4xx other than 408/429). */
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export const fetchTransport: EmailTransport = async ({ url, headers, body }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: (await res.text()).slice(0, 2000) };
};

export interface EmailConfig {
  apiKey: string;
  from: string;
  /** Signs confirm and unsubscribe links (CITY_EMAIL_LINK_KEY, 32+ characters). */
  linkKey: string;
  /** Still accepted for links sent before a rotation (CITY_EMAIL_LINK_KEY_PREVIOUS). */
  previousLinkKey?: string;
}

export const EMAIL_LINK_KEY_MIN_CHARS = 32;

/**
 * The configuration, or null when email is off: it needs the provider key, the sender and a
 * dedicated link-signing key of 32+ characters (never a per-instance fallback, which would break
 * links across instances and restarts).
 */
export function emailConfig(env: Record<string, string | undefined>): EmailConfig | null {
  const apiKey = env.CITY_EMAIL_API_KEY?.trim();
  const from = env.CITY_EMAIL_FROM?.trim();
  const linkKey = env.CITY_EMAIL_LINK_KEY?.trim();
  const previous = env.CITY_EMAIL_LINK_KEY_PREVIOUS?.trim();
  if (!apiKey || !from || !from.includes('@')) return null;
  if (!linkKey || linkKey.length < EMAIL_LINK_KEY_MIN_CHARS) return null;
  return {
    apiKey,
    from,
    linkKey,
    ...(previous && previous.length >= EMAIL_LINK_KEY_MIN_CHARS
      ? { previousLinkKey: previous }
      : {}),
  };
}

export function resendProvider(config: EmailConfig, transport: EmailTransport): EmailProvider {
  return {
    async send(message) {
      let res: EmailTransportResponse;
      try {
        res = await transport({
          url: RESEND_URL,
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': message.idempotencyKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
            ...(message.headers ? { headers: message.headers } : {}),
          }),
        });
      } catch {
        throw new EmailSendError('provider unreachable', true);
      }
      if (res.status >= 200 && res.status < 300) return;
      // Only the status is kept: a provider body may echo the address.
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new EmailSendError(`provider status ${res.status}`, retryable);
    },
  };
}
