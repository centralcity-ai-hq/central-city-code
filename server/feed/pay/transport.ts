/*
 * The Feed pay engine's outbound HTTP (docs/FEED_PAY.md section 5): the only way it reaches a
 * listed service, for the unpaid request that reads the live 402 and for the one paid request.
 *
 *   - https on port 443 only, no credentials in the URL, a public host name (no IP literal that is
 *     private, loopback or special; no single-label or .local/.internal names)
 *   - DNS checked at connection time (oauth/clients.ts publicLookup): every answer must be a public
 *     address, so DNS rebinding cannot reach a private range
 *   - no redirects (a 3xx is answered as it is and never followed), no cookies, no keep-alive
 *     agent, nothing about the person: only the headers the caller passes
 *   - one deadline for the whole exchange and a byte cap on the answer (the rest is never read)
 *
 * Errors say whether our request may have reached the service (`delivered`): false only when it
 * provably never left (bad URL, DNS, a non-public address, the connection refused before TLS).
 */
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress, publicLookup } from '../../oauth/clients.js';
import type { FeedHttpMethod } from '../../../shared/feed.js';
import { FEED_PAY_LIMITS } from '../../../shared/feed-pay.js';

export interface FeedPayHttpRequest {
  url: string;
  method: FeedHttpMethod;
  headers: Record<string, string>;
  /** Sent as is (JSON text); null sends no body. */
  body: string | null;
  timeoutMs: number;
  /** The most of the answer read; more is cut and `truncated` is true. */
  maxBytes: number;
}

export interface FeedPayHttpResponse {
  status: number;
  /** Lowercased names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

export type FeedPayHttpErrorKind = 'bad_url' | 'not_public' | 'unreachable' | 'timeout';

export class FeedPayHttpError extends Error {
  constructor(
    readonly kind: FeedPayHttpErrorKind,
    /** False only when the request provably never reached the service. */
    readonly delivered: boolean,
  ) {
    super(`Feed pay request failed (${kind}).`);
  }
}

export type FeedPayHttp = (request: FeedPayHttpRequest) => Promise<FeedPayHttpResponse>;

/** A header value budget: the 402's PAYMENT-REQUIRED header may be up to 64 KiB of base64. */
const MAX_HEADER_BYTES = FEED_PAY_LIMITS.paymentRequiredMaxBytes + 16_384;

/** Why a URL is never called, or null: https, default port, no credentials, a public host. */
export function feedPayUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.port && url.port !== '443') return 'not the default port';
  if (url.username || url.password) return 'credentials in the URL';
  // A trailing dot names the same host ("localhost." is localhost): checked without it.
  const host = (url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname).replace(
    /\.+$/,
    '',
  );
  if (isIP(host)) return isPublicAddress(host) ? null : 'not a public address';
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home|arpa|test|invalid)$/i.test(host))
    return 'not a public host';
  return null;
}

const flatten = (headers: Record<string, string | string[] | undefined>) => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
};

/** The production transport over node:https with the rules above. */
export const feedPayHttps: FeedPayHttp = (input) =>
  new Promise((resolve, reject) => {
    if (feedPayUrlProblem(input.url) !== null)
      return reject(
        new FeedPayHttpError(
          feedPayUrlProblem(input.url) === 'not a public address' ? 'not_public' : 'bad_url',
          false,
        ),
      );
    const target = new URL(input.url);
    target.hash = '';
    let settled = false;
    let connected = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const headers: Record<string, string> = { ...input.headers };
    if (input.body !== null) headers['content-length'] = String(Buffer.byteLength(input.body));
    const req = httpsRequest(
      target,
      {
        method: input.method,
        headers,
        lookup: publicLookup as never,
        agent: false,
        maxHeaderSize: MAX_HEADER_BYTES,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        let truncated = false;
        const done = () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: flatten(res.headers),
              body: Buffer.concat(chunks),
              truncated,
            }),
          );
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = input.maxBytes - length;
          if (chunk.length > room) {
            if (room > 0) chunks.push(chunk.subarray(0, room));
            length = input.maxBytes;
            truncated = true;
            // The rest of the answer is never read.
            done();
            req.destroy();
            return;
          }
          chunks.push(chunk);
          length += chunk.length;
        });
        res.on('end', done);
        // Closed before the end of the body: what arrived is only part of the answer.
        res.on('close', () => {
          if (!res.complete) truncated = true;
          done();
        });
        res.on('error', () => finish(() => reject(new FeedPayHttpError('unreachable', true))));
      },
    );
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        connected = true;
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new FeedPayHttpError('timeout', connected)));
    }, input.timeoutMs);
    req.on('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new FeedPayHttpError(
            error.code === 'ENOTPUBLIC' ? 'not_public' : 'unreachable',
            connected,
          ),
        ),
      ),
    );
    req.end(input.body ?? undefined);
  });
