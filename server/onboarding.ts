import type { Transaction } from './database.js';
import { GOOGLE_SALT_NO_PASSWORD, GOOGLE_SALT_PENDING_NAME } from './google/routes.js';
import { TERMS_VERSION } from '../shared/terms.js';

/**
 * The onboarding gate (docs/GOOGLE_SIGNIN.md "Onboarding"), shared by every way in: the session
 * (server/app.ts), OAuth access tokens (server/oauth/server.ts), assistant grants and AI workspace
 * keys (server/assistant-access.ts loadAuthority, which the assistant tools, MCP tools and the
 * wake API all go through) and agent runtime credentials (server/app.ts runtime).
 *
 * An account that signs in with Google (created with it: its reserved salt, server/google/routes.ts;
 * or any account with a Google link) is pending until it has a name and an acceptance of the
 * current TERMS_VERSION. An AI-owned
 * workspace is held while any of its human co-owners (operator_links) is pending. Password
 * accounts accept at sign-up and are never pending.
 */
type Q = Pick<Transaction, 'query'>;

/** 403 onboarding_required (statusCode and errorCode are read by the error handlers). */
export class OnboardingRequiredError extends Error {
  readonly statusCode = 403;
  readonly errorCode = 'onboarding_required';
  constructor() {
    super('Finish setting up your account first: choose a name and accept the Terms.');
  }
}

export function onboardingState(row: {
  salt: string;
  terms_version: string | null;
  google_linked?: boolean | null;
}) {
  // Every account that signs in with Google: created with it (reserved salt) or any account with
  // a Google link. Both need a recorded acceptance of the current version.
  const google =
    row.salt === GOOGLE_SALT_PENDING_NAME ||
    row.salt === GOOGLE_SALT_NO_PASSWORD ||
    row.google_linked === true;
  const nameNeeded = row.salt === GOOGLE_SALT_PENDING_NAME;
  const termsNeeded = google && row.terms_version !== TERMS_VERSION;
  return { pending: nameNeeded || termsNeeded, nameNeeded, termsNeeded };
}

/** The account's own onboarding status, as GET /api/session reports it. */
export async function onboardingOf(q: Q, operatorId: string) {
  const row = (
    await q.query<{ salt: string; terms_version: string | null; google_linked: boolean }>(
      `SELECT o.salt,a.version AS terms_version,
              EXISTS (SELECT 1 FROM elric_verified_identities v WHERE v.operator_id=o.id)
                AS google_linked
         FROM operators o
         LEFT JOIN account_terms_acceptances a ON a.operator_id=o.id WHERE o.id=$1`,
      [operatorId],
    )
  ).rows[0];
  const state = row
    ? onboardingState(row)
    : { pending: false, nameNeeded: false, termsNeeded: false };
  return {
    required: state.pending,
    name_needed: state.nameNeeded,
    terms_needed: state.termsNeeded,
    terms_version: TERMS_VERSION,
  };
}

/**
 * Throws OnboardingRequiredError when `operatorId` (or, for an AI-owned workspace, any of its
 * human co-owners) has not finished onboarding. One query.
 *
 * The ids are gathered first (ARRAY(...), evaluated once) and looked up with = ANY, so the
 * operators primary key is used. Written as `o.id=$1 OR o.id IN (...)` the planner scanned all of
 * operators (1.8M rows) on every call (prod plan, 22 Oct 05:52 UTC: 44 sessions in that scan at
 * once). Same rows either way.
 */
export async function assertOnboarded(q: Q, operatorId: string): Promise<void> {
  const rows = (
    await q.query<{ salt: string; terms_version: string | null; google_linked: boolean }>(
      `SELECT o.salt,a.version AS terms_version,
              EXISTS (SELECT 1 FROM elric_verified_identities v WHERE v.operator_id=o.id)
                AS google_linked
         FROM operators o
         LEFT JOIN account_terms_acceptances a ON a.operator_id=o.id
        WHERE o.id = ANY(ARRAY(SELECT $1::text
                                UNION ALL
                                SELECT l.human_operator_id FROM operator_links l
                                  JOIN operators ai ON ai.id=l.ai_operator_id AND ai.kind='ai'
                                 WHERE l.ai_operator_id=$1))`,
      [operatorId],
    )
  ).rows;
  if (rows.some((row) => onboardingState(row).pending)) throw new OnboardingRequiredError();
}
