import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Transaction } from '../database.js';
import type { HostedConfig } from '../hosted.js';
import { requestOrigin } from '../oauth/server.js';
import { clientAddressKey, type RateLimiter } from '../rate-limit.js';
import {
  GOOGLE_ENDPOINTS,
  GOOGLE_LIMITS,
  fetchTransport,
  googleBirthdayScopeEnabled,
  googleClient,
  googleSignInEnabled,
  type GoogleSignInOptions,
} from './config.js';
import { BIRTHDAY_SCOPE, readGoogleBirthday, type AgeCheck } from './age.js';
import {
  ageLocked,
  defaultPiiKeyring,
  deleteDob,
  isAdult,
  lockAge,
  ownDateOfBirth,
  storeDob,
} from './pii.js';
import {
  cooldownBlocks,
  inCooldown,
  lockSubject,
  startCooldown,
  subjectLocked,
} from './cooldown.js';
import { GoogleTokenError, createJwksCache, verifyGoogleIdToken } from './verify.js';
import { safeReturnPath } from '../../shared/return-path.js';

/**
 * Sign in with Google and the verified identity link (docs/GOOGLE_SIGNIN.md), behind
 * CITY_GOOGLE_SIGNIN=1.
 *
 * - `GET /api/auth/google` → `{enabled, linked}`: whether the feature is on and configured, and
 *   the signed-in person's link (`{email, hd, linked_at}` or null).
 * - `POST /api/auth/google/start {intent: 'signin'|'link'}` → `{url}`: starts an authorization
 *   code flow with PKCE (S256), a random state and a random nonce, stored server-side for 10
 *   minutes. `link` needs a signed-in person. A random binding value goes into a short-lived
 *   cookie (SameSite=Lax, so it comes back on Google's top-level redirect) and its hash into the
 *   flow, so a callback only completes in the browser that started it (no login CSRF).
 * - `GET /api/auth/google/callback?state&code`: consumes the flow (single use), exchanges the code
 *   with the PKCE verifier, verifies the ID token (verify.ts) and then:
 *   - link: stores sub, email and hd for the account that started the flow (one Google subject per
 *     account and one account per subject; no token is stored);
 *   - sign-in (also sign-up: one "Continue with Google" button): signs in the account linked to
 *     that subject. An unknown subject (its email is always verified, verify.ts) gets a new
 *     account with no password, the Google link and a session, under the same account cap and
 *     per-address registration budget as the password sign-up. Refused instead: an email address
 *     already linked to another account (never merged: sign in with the password, then link
 *     Google in Account), and a Google account in its 30-day relink cooldown. An under-18 lock on
 *     the Google account carries over to the new account. The new account picks its account name
 *     next (`POST /api/auth/google/handle`); the date of birth is asked only for Elric.
 *   It always redirects to a fixed path chosen by the server (`/rooms`, `/signin?google=<code>`
 *   or `/settings/account?google=<code>`), never to a caller-supplied location.
 * - `POST /api/auth/google/unlink`: deletes the signed-in person's link and starts the 30-day
 *   relink cooldown for that Google account (cooldown.ts).
 *
 * Elric eligibility (server/elric/access.ts) reads the stored link on every invocation, so
 * unlinking stops Elric at once. The session cookie is SameSite=Strict, so the callback (a
 * cross-site navigation from Google) identifies the account from the flow, not the session.
 */

export interface GoogleSignInDeps {
  db: Database;
  clock(): number;
  limiter: RateLimiter;
  /** Creates a session for the operator and sets its cookie (app.ts session()). */
  session(tx: Transaction, reply: FastifyReply, operatorId: string): Promise<void>;
  /** The signed-in person from the session cookie, or null. */
  currentPerson(request: FastifyRequest): Promise<{ id: string } | null>;
  /**
   * Account creation for an unknown Google account (app.ts createOwner, under the account cap).
   * Without it, an unknown Google account is refused (`not_linked`).
   */
  signup?: {
    registrationsPerWindow: number;
    create(
      tx: Transaction,
      id: string,
      name: string,
      passwordHash: string,
      salt: string,
    ): Promise<'created' | 'limit' | 'name_taken'>;
  };
  hosted?: HostedConfig;
  secureCookies?: boolean;
  options?: GoogleSignInOptions;
}

export const GOOGLE_FLOW_COOKIE = 'cc_google_flow';
/** The allowlisted return path after sign-in (shared/return-path.ts), beside the flow cookie. */
export const GOOGLE_NEXT_COOKIE = 'cc_google_next';
const CALLBACK_PATH = '/api/auth/google/callback';

/** Outcome codes in the redirect (`?google=`); the UI maps each to a sentence. */
export type GoogleOutcome =
  | 'linked'
  | 'cancelled'
  | 'expired'
  | 'not_linked'
  | 'linked_elsewhere'
  | 'already_linked'
  | 'ineligible'
  | 'unverified'
  | 'failed'
  /** The Google account was unlinked from another account within 30 days (cooldown.ts). */
  | 'relink_cooldown'
  /** Linked, but Elric stays unavailable: under 18, or the age is unknown (age.ts). */
  | 'elric_age_under_18'
  | 'elric_age_unknown'
  /** A new account was created with Google; it chooses its account name next. */
  | 'welcome'
  /** The Google email address is already linked to another account (no automatic merge). */
  | 'email_exists'
  /** Sign-up refused: the per-address registration budget, or the account cap. */
  | 'signup_limited'
  | 'signup_closed';

/**
 * A Google-created account has no password: its password_hash is 64 random bytes (hex) that no
 * password hashes to, and its salt is one of two reserved values (a password account's salt is
 * 16 random bytes, so it never collides). Both keep the offline backup format
 * (server/recovery.ts) valid and survive a backup round-trip.
 */
export const GOOGLE_SALT_PENDING_NAME = `${'0'.repeat(31)}1`;
export const GOOGLE_SALT_NO_PASSWORD = '0'.repeat(32);
const googleOnlyPasswordHash = () => randomBytes(64).toString('hex');
const REGISTRATION_WINDOW_MS = 15 * 60_000;
class Rollback extends Error {
  constructor(public outcome: GoogleOutcome) {
    super(outcome);
  }
}

class GoogleSignInError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
    /** Sent as Retry-After by the app's error handler (rate limits). */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
const refuse = (status: number, code: string, message: string): never => {
  throw new GoogleSignInError(status, code, message);
};

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const sameHex = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const startInput = z
  .object({ intent: z.enum(['signin', 'link']), next: z.string().max(200).optional() })
  .strict();
const ageInput = z.object({ date_of_birth: z.string().max(10) }).strict();
// The same account-name rules as the password sign-up (app.ts authSchema).
const handleInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-zA-Z0-9 _.-]+$/),
  })
  .strict();
const callbackQuery = z
  .object({
    state: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().max(256).optional(),
  })
  .passthrough();

interface FlowRow {
  binder_hash: string;
  nonce: string;
  verifier: string;
  redirect_uri: string;
  intent: 'signin' | 'link';
  operator_id: string | null;
  expires_at: string | number;
}

/** The stored 18+ result as the API shows it (no birth date is ever stored). */
function ageCheckOf(adult: boolean | null): AgeCheck {
  return adult === true ? 'over_18' : adult === false ? 'under_18' : 'unknown';
}

export function registerGoogleSignInRoutes(app: FastifyInstance, d: GoogleSignInDeps): void {
  const transport = d.options?.transport ?? fetchTransport;
  const jwks = createJwksCache(transport, d.clock);
  const enabled = () => googleSignInEnabled(d.options);
  const client = () => googleClient(d.options);
  const secure = d.hosted ? true : (d.secureCookies ?? false);

  async function limit(key: string, max: number) {
    const result = await d.limiter.hit(key, max, GOOGLE_LIMITS.windowMs);
    if (!result.allowed)
      throw new GoogleSignInError(
        429,
        'rate_limited',
        'Too many requests. Try again later.',
        result.retryAfterMs,
      );
  }
  /** Off, or on without a configured client: the routes do not exist. */
  function available() {
    return client() ?? refuse(404, 'not_found', 'Not found.');
  }
  /** The exact redirect URI: the public origin when hosted, else the local origin. */
  function redirectUri(request: FastifyRequest) {
    const origin = requestOrigin(request, d.hosted);
    if (d.hosted && origin !== d.hosted.publicOrigin)
      refuse(409, 'use_public_origin', `Continue with Google from ${d.hosted.publicOrigin}.`);
    return `${origin}${CALLBACK_PATH}`;
  }
  async function person(request: FastifyRequest) {
    const found = await d.currentPerson(request);
    if (!found) return null;
    const kind = (
      await d.db.query<{ kind: string }>('SELECT kind FROM operators WHERE id=$1', [found.id])
    ).rows[0]?.kind;
    return kind === 'owner' ? found : null;
  }

  /** Why linking `subject` to `operatorId` would be refused, or null (read-only). */
  async function linkRefusal(
    subject: string,
    operatorId: string,
    time: number,
  ): Promise<GoogleOutcome | null> {
    const kind = (
      await d.db.query<{ kind: string }>('SELECT kind FROM operators WHERE id=$1', [operatorId])
    ).rows[0]?.kind;
    if (kind !== 'owner') return 'failed';
    const rows = (
      await d.db.query<{ operator_id: string; subject: string }>(
        "SELECT operator_id,subject FROM elric_verified_identities WHERE provider='google' AND (subject=$1 OR operator_id=$2)",
        [subject, operatorId],
      )
    ).rows;
    if (rows.some((row) => row.subject === subject && row.operator_id !== operatorId))
      return 'linked_elsewhere';
    if (await cooldownBlocks(d.db, subject, operatorId, time)) return 'relink_cooldown';
    if (rows.some((row) => row.operator_id === operatorId && row.subject !== subject))
      return 'already_linked';
    return null;
  }

  app.get('/api/auth/google', async (request) => {
    const on = enabled() && client() !== null;
    const signedIn = on ? await person(request) : null;
    const linked = signedIn
      ? (
          await d.db.query<{
            email: string;
            hd: string | null;
            verified_at: string | number;
          }>(
            "SELECT email,hd,verified_at FROM elric_verified_identities WHERE operator_id=$1 AND provider='google'",
            [signedIn.id],
          )
        ).rows[0]
      : undefined;
    const handleNeeded = signedIn
      ? (
          await d.db.query<{ salt: string }>('SELECT salt FROM operators WHERE id=$1', [
            signedIn.id,
          ])
        ).rows[0]?.salt === GOOGLE_SALT_PENDING_NAME
      : false;
    return {
      enabled: on,
      handle_needed: handleNeeded,
      linked: linked
        ? {
            email: linked.email,
            hd: linked.hd,
            linked_at: new Date(Number(linked.verified_at)).toISOString(),
            // The result of the 18+ age confirmation only; never the birth date.
            age_check: ageCheckOf(
              await isAdult(d.db, defaultPiiKeyring(), signedIn!.id, d.clock()),
            ),
          }
        : null,
    };
  });

  app.post('/api/auth/google/start', async (request, reply) => {
    const oauth = available();
    await limit(
      `google-start:${clientAddressKey(request.ip)}`,
      d.options?.addressLimits?.startsPerAddress ?? GOOGLE_LIMITS.startsPerAddress,
    );
    const { intent, next: requestedNext } = startInput.parse(request.body ?? {});
    // Only an allowlisted relative path; anything else is dropped (never an open redirect).
    const next = intent === 'signin' ? safeReturnPath(requestedNext) : null;
    let operatorId: string | null = null;
    if (intent === 'link') {
      const signedIn = await person(request);
      if (!signedIn) refuse(401, 'sign_in_required', 'Sign in to continue.');
      operatorId = signedIn!.id;
    }
    const redirect = redirectUri(request);
    const birthday = intent === 'link' && googleBirthdayScopeEnabled(d.options);
    const state = random();
    const nonce = random();
    const verifier = random();
    const binder = random();
    const now = d.clock();
    await d.db.transaction(async (tx) => {
      await tx.query('DELETE FROM google_signin_flows WHERE expires_at<=$1', [now]);
      await tx.query(
        `INSERT INTO google_signin_flows(state_hash,binder_hash,nonce,verifier,redirect_uri,intent,operator_id,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          sha(state),
          sha(binder),
          nonce,
          verifier,
          redirect,
          intent,
          operatorId,
          now,
          now + GOOGLE_LIMITS.flowTtlMs,
        ],
      );
    });
    reply.setCookie(GOOGLE_FLOW_COOKIE, binder, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: CALLBACK_PATH,
      maxAge: GOOGLE_LIMITS.flowTtlMs / 1000,
    });
    const nextCookie = {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: CALLBACK_PATH,
    };
    if (next)
      reply.setCookie(GOOGLE_NEXT_COOKIE, next, {
        ...nextCookie,
        maxAge: GOOGLE_LIMITS.flowTtlMs / 1000,
      });
    else reply.clearCookie(GOOGLE_NEXT_COOKIE, nextCookie);
    const url = new URL(GOOGLE_ENDPOINTS.authorization);
    url.search = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      // With CITY_GOOGLE_BIRTHDAY_SCOPE=1, the link also reads the birthday once (age confirmation).
      scope: birthday ? `openid email profile ${BIRTHDAY_SCOPE}` : 'openid email profile',
      ...(birthday ? { include_granted_scopes: 'true' } : {}),
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.toString() };
  });

  app.get(CALLBACK_PATH, async (request, reply) => {
    const oauth = available();
    await limit(
      `google-callback:${clientAddressKey(request.ip)}`,
      d.options?.addressLimits?.callbacksPerAddress ?? GOOGLE_LIMITS.callbacksPerAddress,
    );
    const binder = request.cookies[GOOGLE_FLOW_COOKIE];
    // Checked again here: a changed cookie can only pick another allowlisted path.
    const next = safeReturnPath(request.cookies[GOOGLE_NEXT_COOKIE]);
    reply.clearCookie(GOOGLE_NEXT_COOKIE, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: CALLBACK_PATH,
    });
    reply.clearCookie(GOOGLE_FLOW_COOKIE, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: CALLBACK_PATH,
    });
    const parsed = callbackQuery.safeParse(request.query ?? {});
    const query = parsed.success ? parsed.data : {};
    const now = d.clock();
    // Single use: the flow is deleted whatever happens next.
    const flow = query.state
      ? (
          await d.db.query<FlowRow>(
            'DELETE FROM google_signin_flows WHERE state_hash=$1 RETURNING binder_hash,nonce,verifier,redirect_uri,intent,operator_id,expires_at',
            [sha(query.state)],
          )
        ).rows[0]
      : undefined;
    const done = (intent: 'signin' | 'link', outcome: GoogleOutcome | 'signed_in') =>
      reply.redirect(
        outcome === 'signed_in'
          ? (next ?? '/rooms')
          : outcome === 'welcome' && next
            ? `/settings/account?${new URLSearchParams({ google: outcome, next })}`
            : intent === 'link' || outcome === 'welcome'
              ? `/settings/account?google=${outcome}`
              : `/signin?google=${outcome}`,
        303,
      );
    if (
      !flow ||
      !binder ||
      binder.length > 64 ||
      !sameHex(sha(binder), flow.binder_hash) ||
      Number(flow.expires_at) <= now
    )
      return done(flow?.intent ?? 'signin', 'expired');
    if (query.error || !query.code) return done(flow.intent, 'cancelled');

    const exchanged = await transport({
      method: 'POST',
      url: GOOGLE_ENDPOINTS.token,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        redirect_uri: flow.redirect_uri,
        code_verifier: flow.verifier,
      }).toString(),
    }).catch(() => null);
    // The access token stays in this request: used once for the birthday, never stored or logged.
    let tokens: { id_token?: unknown; access_token?: unknown } = {};
    try {
      tokens =
        exchanged && exchanged.status === 200 ? (JSON.parse(exchanged.body) as typeof tokens) : {};
    } catch {
      tokens = {};
    }
    const idToken = tokens.id_token;
    if (typeof idToken !== 'string') return done(flow.intent, 'failed');
    let identity;
    try {
      identity = await verifyGoogleIdToken(
        idToken,
        { clientId: oauth.clientId, nonce: flow.nonce, now },
        jwks,
      );
    } catch (error) {
      if (!(error instanceof GoogleTokenError)) throw error;
      return done(
        flow.intent,
        error.code === 'ineligible_domain'
          ? 'ineligible'
          : error.code === 'email_unverified'
            ? 'unverified'
            : 'failed',
      );
    }

    if (flow.intent === 'link') {
      // A link that will be refused never reads the birthday (re-checked in the transaction).
      const refused = await linkRefusal(identity.sub, flow.operator_id!, now);
      if (refused) return done('link', refused);
      const birthday = googleBirthdayScopeEnabled(d.options)
        ? await readGoogleBirthday(transport, tokens.access_token, now)
        : null;
      tokens = {};
      const link = () =>
        d.db.transaction(async (tx): Promise<GoogleOutcome> => {
          const owner = (
            await tx.query<{ kind: string }>('SELECT kind FROM operators WHERE id=$1 FOR UPDATE', [
              flow.operator_id,
            ])
          ).rows[0];
          if (owner?.kind !== 'owner') return 'failed';
          const bySubject = (
            await tx.query<{ operator_id: string }>(
              "SELECT operator_id FROM elric_verified_identities WHERE provider='google' AND subject=$1",
              [identity.sub],
            )
          ).rows[0];
          if (bySubject && bySubject.operator_id !== flow.operator_id) return 'linked_elsewhere';
          if (await inCooldown(tx, identity.sub, flow.operator_id!, d.clock()))
            return 'relink_cooldown';
          const current = (
            await tx.query<{ subject: string }>(
              'SELECT subject FROM elric_verified_identities WHERE operator_id=$1',
              [flow.operator_id],
            )
          ).rows[0];
          if (current && current.subject !== identity.sub) return 'already_linked';
          const time = d.clock();
          // The unique (provider, subject) index backs the check above under concurrency.
          const written = await tx.query(
            `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,hd,verified_at,created_at)
           VALUES($1,'google',$2,$3,true,$4,$5,$5)
           ON CONFLICT (operator_id) DO UPDATE SET email=EXCLUDED.email, hd=EXCLUDED.hd,
             email_verified=true, verified_at=EXCLUDED.verified_at
             WHERE elric_verified_identities.subject=EXCLUDED.subject
           RETURNING operator_id`,
            [flow.operator_id, identity.sub, identity.email, identity.hd, time],
          );
          if (!written.rows.length) return 'already_linked';
          // The under-18 lock follows the Google account both ways.
          if (await subjectLocked(tx, identity.sub)) await lockAge(tx, flow.operator_id!, time);
          if (await ageLocked(tx, flow.operator_id!)) {
            await lockSubject(tx, identity.sub, time);
            return 'elric_age_under_18';
          }
          if (!googleBirthdayScopeEnabled(d.options)) return 'linked';
          // The Google birthday, when read, goes only to the encrypted store (pii.ts).
          if (!birthday) return 'elric_age_unknown';
          const stored = await storeDob(
            tx,
            defaultPiiKeyring(),
            flow.operator_id!,
            birthday,
            'google',
            time,
          );
          if (stored === 'under_18' || stored === 'locked') {
            await lockSubject(tx, identity.sub, time);
            return 'elric_age_under_18';
          }
          return stored === 'over_18' ? 'linked' : 'elric_age_unknown';
        });
      let outcome: GoogleOutcome;
      try {
        outcome = await link();
      } catch (error) {
        // A concurrent link of the same subject to another account hit the unique index.
        if ((error as { code?: string }).code !== '23505') throw error;
        outcome = 'linked_elsewhere';
      }
      return done('link', outcome);
    }

    const linked = (
      await d.db.query<{ operator_id: string }>(
        `SELECT v.operator_id FROM elric_verified_identities v JOIN operators o ON o.id=v.operator_id
          WHERE v.provider='google' AND v.subject=$1 AND o.kind='owner'`,
        [identity.sub],
      )
    ).rows[0];
    if (linked) {
      await d.db.transaction((tx) => d.session(tx, reply, linked.operator_id));
      return done('signin', 'signed_in');
    }
    return done('signin', await signUp(request, reply, identity));
  });

  /** Sign-up with Google: a new account, its Google link and a session (one transaction). */
  async function signUp(
    request: FastifyRequest,
    reply: FastifyReply,
    identity: { sub: string; email: string; hd: string | null },
  ): Promise<GoogleOutcome> {
    if (!d.signup) return 'not_linked';
    const signup = d.signup;
    // No automatic merge: an email address linked to another account must sign in there first.
    const emailTaken = async (q: Pick<Transaction, 'query'>) =>
      (
        await q.query(
          "SELECT 1 FROM elric_verified_identities WHERE provider='google' AND lower(email)=lower($1) AND subject<>$2",
          [identity.email, identity.sub],
        )
      ).rows.length > 0;
    if (await emailTaken(d.db)) return 'email_exists';
    // A Google account unlinked within 30 days cannot start a new account either.
    if (await cooldownBlocks(d.db, identity.sub, '', d.clock())) return 'relink_cooldown';
    // The password sign-up's per-address budget (the same bucket).
    const budget = await d.limiter.hit(
      `register:${clientAddressKey(request.ip)}`,
      signup.registrationsPerWindow,
      REGISTRATION_WINDOW_MS,
    );
    if (!budget.allowed) return 'signup_limited';
    const id = randomUUID();
    try {
      return await d.db.transaction(async (tx): Promise<GoogleOutcome> => {
        // A placeholder name until the person chooses one (POST /api/auth/google/handle).
        const name = `Google user ${randomBytes(5).toString('hex')}`;
        const created = await signup.create(
          tx,
          id,
          name,
          googleOnlyPasswordHash(),
          GOOGLE_SALT_PENDING_NAME,
        );
        if (created === 'limit') throw new Rollback('signup_closed');
        if (created === 'name_taken') throw new Rollback('failed');
        if (await emailTaken(tx)) throw new Rollback('email_exists');
        if (await inCooldown(tx, identity.sub, id, d.clock()))
          throw new Rollback('relink_cooldown');
        const time = d.clock();
        // The unique (provider, subject) index refuses a concurrent second account.
        await tx.query(
          `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,hd,verified_at,created_at)
           VALUES($1,'google',$2,$3,true,$4,$5,$5)`,
          [id, identity.sub, identity.email, identity.hd, time],
        );
        // The under-18 lock follows the Google account to the new account.
        if (await subjectLocked(tx, identity.sub)) await lockAge(tx, id, time);
        await d.session(tx, reply, id);
        return 'welcome';
      });
    } catch (error) {
      if (error instanceof Rollback) return error.outcome;
      if ((error as { code?: string }).code === '23505') return 'failed';
      throw error;
    }
  }

  // A Google-created account chooses its account name (once, right after the first sign-in).
  app.post('/api/auth/google/handle', async (request) => {
    available();
    const signedIn =
      (await person(request)) ?? refuse(401, 'sign_in_required', 'Sign in to continue.');
    await limit(`register:handle:${signedIn.id}`, GOOGLE_LIMITS.ageWritesPerAccount);
    const { name } = handleInput.parse(request.body ?? {});
    const outcome = await d.db.transaction(async (tx) => {
      const row = (
        await tx.query<{ salt: string }>('SELECT salt FROM operators WHERE id=$1 FOR UPDATE', [
          signedIn.id,
        ])
      ).rows[0];
      if (row?.salt !== GOOGLE_SALT_PENDING_NAME) return 'chosen';
      const taken = (
        await tx.query('SELECT 1 FROM operators WHERE name_key=$1 AND id<>$2', [
          name.toLowerCase(),
          signedIn.id,
        ])
      ).rows.length;
      if (taken) return 'taken';
      try {
        await tx.query('UPDATE operators SET name=$2, name_key=$3, salt=$4 WHERE id=$1', [
          signedIn.id,
          name,
          name.toLowerCase(),
          GOOGLE_SALT_NO_PASSWORD,
        ]);
      } catch (error) {
        // A concurrent claim of the same name passed the check above: the unique name_key
        // refuses ours. Throwing rolls the (now aborted) transaction back.
        if ((error as { code?: string }).code === '23505')
          refuse(409, 'name_unavailable', 'That account name is unavailable.');
        throw error;
      }
      return 'saved';
    });
    if (outcome === 'chosen') refuse(409, 'handle_chosen', 'This account already has a name.');
    if (outcome === 'taken') refuse(409, 'name_unavailable', 'That account name is unavailable.');
    return { operator: { id: signedIn.id, name } };
  });

  app.post('/api/auth/google/unlink', async (request) => {
    available();
    const signedIn =
      (await person(request)) ?? refuse(401, 'sign_in_required', 'Sign in to continue.');
    await limit(`google-unlink:${signedIn.id}`, GOOGLE_LIMITS.unlinksPerAccount);
    // An account created with Google has no password: unlinking would lock its owner out.
    const signInMethod = (
      await d.db.query<{ salt: string }>('SELECT salt FROM operators WHERE id=$1', [signedIn.id])
    ).rows[0]?.salt;
    if (signInMethod === GOOGLE_SALT_PENDING_NAME || signInMethod === GOOGLE_SALT_NO_PASSWORD)
      refuse(409, 'google_only', 'This account signs in with Google only, so it stays linked.');
    await d.db.transaction(async (tx) => {
      const removed = (
        await tx.query<{ subject: string }>(
          "DELETE FROM elric_verified_identities WHERE operator_id=$1 AND provider='google' RETURNING subject",
          [signedIn.id],
        )
      ).rows[0];
      // The Google account cannot move to another Central City account for 30 days.
      if (removed) await startCooldown(tx, removed.subject, signedIn.id, d.clock());
      // Unlinking crypto-shreds the date of birth; an under-18 lock stays.
      await deleteDob(tx, signedIn.id);
    });
    return { linked: null };
  });

  /** The signed-in person with a verified Google link, for the date of birth routes. */
  async function linkedPerson(request: FastifyRequest) {
    available();
    const signedIn =
      (await person(request)) ?? refuse(401, 'sign_in_required', 'Sign in to continue.');
    const linked = (
      await d.db.query(
        "SELECT 1 FROM elric_verified_identities WHERE operator_id=$1 AND provider='google'",
        [signedIn.id],
      )
    ).rows.length;
    if (!linked)
      refuse(409, 'google_link_required', 'Link your Google account first (Account settings).');
    return signedIn;
  }

  // The owner's own date of birth (account settings): view it. Session only; never cached.
  app.get('/api/elric/age', async (request, reply) => {
    const signedIn = await linkedPerson(request);
    await limit(`elric-age-view:${signedIn.id}`, GOOGLE_LIMITS.ageWritesPerAccount * 3);
    reply.header('Cache-Control', 'no-store');
    const own = await ownDateOfBirth(d.db, defaultPiiKeyring(), signedIn.id);
    return {
      date_of_birth: own?.date_of_birth ?? null,
      age_check: ageCheckOf(await isAdult(d.db, defaultPiiKeyring(), signedIn.id, d.clock())),
      locked: own?.locked ?? false,
    };
  });

  // Enter or correct the date of birth for Elric's 18+ age confirmation (decision: under 18
  // locks the account for Elric; a correction never lifts the lock).
  app.post('/api/elric/age', async (request) => {
    const signedIn = await linkedPerson(request);
    await limit(`elric-age:${signedIn.id}`, GOOGLE_LIMITS.ageWritesPerAccount);
    const { date_of_birth: value } = ageInput.parse(request.body ?? {});
    const result = await d.db.transaction(async (tx) => {
      const stored = await storeDob(
        tx,
        defaultPiiKeyring(),
        signedIn.id,
        value,
        'owner',
        d.clock(),
      );
      if (stored === 'under_18' || stored === 'locked') {
        // Lock the linked Google account too, so the lock follows it to other accounts.
        const linked = (
          await tx.query<{ subject: string }>(
            "SELECT subject FROM elric_verified_identities WHERE operator_id=$1 AND provider='google'",
            [signedIn.id],
          )
        ).rows[0];
        if (linked) await lockSubject(tx, linked.subject, d.clock());
      }
      return stored;
    });
    if (result === 'invalid')
      refuse(400, 'invalid_date_of_birth', 'Enter a full date of birth (year, month and day).');
    if (result === 'unavailable')
      refuse(409, 'age_check_unavailable', "The age check isn't available right now.");
    if (result === 'under_18' || result === 'locked')
      refuse(403, 'elric_age_under_18', 'Elric is only for people aged 18 or over.');
    return { age_check: 'over_18' as const };
  });
}
