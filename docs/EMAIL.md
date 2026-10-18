# Email: welcome email and newsletter

Central City sends two kinds of email: a one-time welcome email (transactional) and the
newsletter, which is opt-in with double opt-in. Code: `server/email/`; texts:
`server/email/templates.ts`.

## Configuration

| Variable                       | Meaning                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| `CITY_EMAIL_API_KEY`           | The provider's API key (Resend). Secret; only sent to the provider.       |
| `CITY_EMAIL_FROM`              | The sender, e.g. `Central City <newsletter@centralcity.ai>`.              |
| `CITY_EMAIL_LINK_KEY`          | Signs the confirm and unsubscribe links (32+ characters, its own secret). |
| `CITY_EMAIL_LINK_KEY_PREVIOUS` | Optional: the previous link key, still accepted after a rotation.         |
| `CITY_OPS_SECRET`              | Bearer for the ops-only subscriber export (32+ characters).               |
| `CRON_SECRET`                  | Bearer that Vercel Cron sends to `/api/cron/email-drain`.                 |

Without `CITY_EMAIL_API_KEY`, `CITY_EMAIL_FROM` and a `CITY_EMAIL_LINK_KEY` of 32+ characters,
sending is **off**: nothing is sent and no welcome email is queued. The newsletter opt-in is still
offered and recorded as pending, and its confirmation email stays queued until sending is
configured (its link is signed when it is sent). There is no per-instance fallback for the link
key.

**Rotating `CITY_EMAIL_LINK_KEY`:** set the new key and move the old one to
`CITY_EMAIL_LINK_KEY_PREVIOUS`. Links are signed with the new key and accepted under either.
Removing the previous key **breaks every unsubscribe link already sent** (they never expire), so
keep it as long as those emails may be used; remove it only if it was exposed.

Password accounts have no email address of their own: the sign-up form asks for one only when the
newsletter box is ticked, and it is used only for the newsletter. Accounts with a verified Google
link use that address.

## Sending

- Emails are queued in `email_outbox`, one row per `dedupe_key` (`welcome:<account>`,
  `newsletter_confirm:<account>:<time>`), so each is queued at most once. A new sign-up, an
  unsubscribe or the 30-day purge drops an unsent confirmation.
- The drain sends due emails: right after the request that queued them (in the background,
  never blocking it), every minute from `GET /api/cron/email-drain` (Vercel Cron), and every
  minute locally. A failed send is retried with exponential backoff (up to 8 attempts). A 4xx
  other than 408 or 429 is permanent. The provider's idempotency key is the dedupe key, so a
  retry never sends twice. Only the status is kept on error, never the provider's response body.
- Plain text only; no tracking pixels and no click tracking.
- Sent and failed queue rows (address and body) are deleted 30 days after sending or failing
  (the drain's purge).

## Welcome email

Queued once, when an account created with Google finishes onboarding (name and Terms accepted;
`docs/GOOGLE_SIGNIN.md`). It names Elric only when Elric is on, and has no unsubscribe link: it
is transactional and sent once.

## Newsletter (double opt-in)

- **Opt-in:** an unticked, optional checkbox (`shared/newsletter.ts`):
  - password sign-up (`src/Auth.tsx`): ticking it shows a required Email field; unticked, no
    address is sent or stored (the server refuses an address without the tick);
  - Google sign-up (the onboarding screen): the Google account's verified address;
  - Settings > Account > Newsletter: status, Subscribe (asks for an address when the account has
    none) and Unsubscribe.

  The opt-in stores the address, the exact text version (`NEWSLETTER_TEXT_VERSION`), the source
  (`signup`, `onboarding` or `settings`) and the time (`opted_in_at`) in `newsletter_consents`,
  and queues a confirmation email. Settings subscribe attempts are rate limited (5 per account and
  20 per address per hour); a ticked password sign-up counts against the same per-address budget.
  Every path is capped at 3 confirmation emails per recipient address per day, keyed by a keyed
  hash of the normalized address (`NEWSLETTER_RECIPIENT_RATE`). Sign-up and onboarding take these
  budgets only after the account is saved, and a spent one skips the opt-in (no consent, no email)
  instead of refusing the account; only Settings answers a spent budget with a 429.

- **Confirmation:** a signed link (HMAC under a key derived from `CITY_EMAIL_LINK_KEY`) to
  `/newsletter/confirm?t=`, valid for 7 days from sending, for that one sign-up (`confirmed_at`).
  Opening the link only shows a page with a button; the button POSTs the link to the API, so mail
  scanners and link previews change nothing. Only confirmed, not withdrawn addresses are
  subscribers. Unconfirmed sign-ups are deleted after 30 days.
- **Unsubscribe:** no login. The footer link opens `/newsletter/unsubscribe?t=`, a page with one
  button, and mail clients unsubscribe in one click with the RFC 8058 POST to
  `/api/newsletter/unsubscribe?t=` from the `List-Unsubscribe` and `List-Unsubscribe-Post`
  headers (`newsletterFooter` in `templates.ts` gives both). Settings > Account does the same
  (`unsubscribed_at`).
- **Record:** every change (`opt_in`, `confirm`, `unsubscribe`, `expired`) is appended to
  `newsletter_consent_events`. A trigger refuses changes, except the retention purge. Records are
  kept 2 years at most after the last change once the subscription is gone (unsubscribed and
  purged, expired, or the account deleted), as proof of consent (Privacy Policy, retention).
- **Export (ops only):** `GET /api/ops/newsletter/subscribers` with
  `Authorization: Bearer <CITY_OPS_SECRET>`. It lists confirmed subscribers with their
  unsubscribe link, and answers 404 otherwise.
- **Data export:** `GET /api/workspace/export` includes `newsletter` (address, status, source,
  text version, and when it was opted in, confirmed and unsubscribed), or `null`.
- **Deletion:** the subscription and the email queue cascade with the account; the consent events
  are kept as above, then purged.
- Email addresses are never written to logs; provider errors keep only the status code.

## Routes

| Route                                                                      | Who                   |
| -------------------------------------------------------------------------- | --------------------- |
| `POST /api/auth/onboarding` `{..., newsletter?: boolean}`                  | the signed-in account |
| `POST /api/auth/register` `{..., newsletter?, email?}`                     | anyone (sign-up)      |
| `GET`/`POST /api/account/newsletter` `{subscribe, email?}`                 | the signed-in account |
| `/newsletter/confirm?t=` (page), `POST /api/newsletter/confirm?t=`         | anyone with the link  |
| `/newsletter/unsubscribe?t=` (page), `POST /api/newsletter/unsubscribe?t=` | anyone with the link  |
| `GET /api/ops/newsletter/subscribers`                                      | `CITY_OPS_SECRET`     |
| `GET /api/cron/email-drain`                                                | `CRON_SECRET`         |

Tests: `tests/email-newsletter.test.ts` (fake provider and fake Google).
