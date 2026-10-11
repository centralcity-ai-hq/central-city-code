# Sign in with Google

Status: **In development** (1 Oct 2026; behind `CITY_GOOGLE_SIGNIN=1`, off by default). Code: `server/google/`.

A person can link one Google account to their Central City account, and then sign in with it.
The link is the verified identity that Elric eligibility reads (docs/ELRIC.md, production
blocker §9).

## What it does

- **Link** (Account, `/settings/account`): "Continue with Google" links the Google account to the
  signed-in account. **Unlink** removes it.
- **Sign in and sign up** (`/signin`, both tabs): one "Continue with Google" button. It signs in
  the account linked to that Google account. A Google account that is not linked yet (its email
  is always verified) gets a new account with no password, the link and a session, under the
  same per-address sign-up budget (and optional `CITY_LIMIT_OPERATORS` emergency ceiling) as the password sign-up. The new account then
  chooses its account name on `/settings/account` (`POST /api/auth/google/handle`, once). The
  date of birth is asked only for Elric. An account created this way cannot unlink Google (it
  has no other way to sign in).
- **Onboarding (server-enforced):** an account created with Google stays in onboarding until it
  has a name and has accepted the Terms of Service and Privacy Policy. The same applies to any
  account with a Google link that has no recorded acceptance of the current version (for example
  a password account from before acceptances were recorded); password sign-up now records its
  acceptance (the form states that creating the account accepts the Terms). While it is pending, its
  session can only call `GET /api/session` (which reports `onboarding`), `GET /api/auth/google`,
  `POST /api/auth/google/handle`, `POST /api/auth/onboarding` and sign out. Every other route
  answers `403 onboarding_required`, and the app shows the onboarding screen on every route
  (Back included). `POST /api/auth/onboarding {name?, terms_version, accept_terms: true}` records
  the accepted version and time (`account_terms_acceptances`, migration 48). When
  `shared/terms.ts` TERMS_VERSION changes, these accounts are asked again; an account with no
  recorded acceptance is gated on its next request. The gate also holds for credentials issued
  before: OAuth/MCP access tokens, assistant grants and agent runtime credentials of such an
  account answer `403 onboarding_required` until it accepts, on every path that takes them
  (MCP, assistant tools, the wake API). An AI workspace key is held while any human co-owner of
  that AI workspace is pending. One shared check (`server/onboarding.ts`) does this for all of
  them. Every acceptance is also appended to `account_terms_acceptance_history` (migration 49);
  a trigger (migration 50) refuses UPDATE, DELETE and TRUNCATE on it, except the cascade when
  the account itself is deleted.
- **Return path:** signing in from `/elric` (or `/rooms`, `/rooms/<id>`, `/settings/account`)
  comes back there instead of `/rooms`. Only these relative paths are accepted
  (`shared/return-path.ts`); the server checks it at the start and again at the callback (it is
  kept in a short-lived cookie beside the flow cookie), so it is never an open redirect. A new
  account chooses its name first and then goes back.
- If the Google email address is already linked to another account, no account is created and
  nothing is merged: "An account with this email exists. Sign in with your password, then link
  Google in Account." A Google account in its 30-day relink cooldown cannot start a new account,
  and an under-18 lock on the Google account carries over to the new account.
- One Google account per Central City account, and one Central City account per Google account.
  Linking a second Google account needs an unlink first.
- After an unlink, that Google account cannot be linked to a different Central City account for
  30 days (linking it back to the same account is fine). For this, the server keeps a keyed hash
  of the Google subject (HMAC with a key derived from `CITY_RATE_LIMIT_KEY`), the account and the
  time, and deletes it after 30 days. Rotating `CITY_RATE_LIMIT_KEY` changes that key, so it ends every
  open cooldown at once.
- Eligible accounts: a gmail.com address, or a Google Workspace account (the ID token carries
  `hd`). The email address must be verified by Google (`email_verified = true`).
- Stored from Google: the subject (`sub`), the email address and the Workspace domain (`hd`) in
  `elric_verified_identities`. No Google password, access token, refresh token or ID token.
- Scopes: `openid email profile`. The birthday scope is off (see below).

## Age confirmation (18+): date of birth

Elric is only for people aged 18 or over. This is an age confirmation from a self-declared date,
not an identity or age verification.

- **Entering it:** `POST /api/elric/age {date_of_birth: "YYYY-MM-DD"}`, from the account page
  (signed-in session only; a verified Google link first, else `409 google_link_required`). Only
  a full, real date, not in the future and at most 120 years ago (`400 invalid_date_of_birth`).
  The age is computed in UTC; the 18th birthday counts from its first moment, 29 February from
  1 March in common years.
- **18 or over:** `{age_check: "over_18"}`; Elric becomes available.
- **Under 18:** `403 elric_age_under_18`, and the account is **locked** for Elric. No date is
  kept for a minor, only the lock. The lock stays through corrections, unlinks and relinks: a
  later date, adult or not, is refused with the same code and counted (`refused_corrections`).
  The response never repeats the date.
- **The lock follows the Google account:** a locked account's Google account is recorded in
  `google_age_locks` (only a keyed hash of its subject and the time, never deleted; the hash
  key is derived from `CITY_PII_KEK` with its own label, so rotating `CITY_PII_KEK` needs a plan
  for these locks: the subjects are not stored, so they cannot be re-hashed). Linking that
  Google account to any account locks that account too, and a locked account that links another
  Google account locks it as well. A person who uses a different Google account cannot be
  prevented: this is a self-declared age confirmation.
- **Viewing and correcting:** `GET /api/elric/age` shows the owner their own date, the result and
  whether the account is locked (`Cache-Control: no-store`). An unlocked owner can correct the
  date.
- **Eligibility:** Elric checks it on every invocation and pending-action approval: a verified
  Google link and an 18+ date (`elric_age_under_18` when locked or under 18, `elric_age_unknown`
  without a date). Add Elric returns the same codes.

### How the date is stored

- In `elric_age_checks`, envelope-encrypted: a random data key per date (AES-256-GCM), wrapped by
  a key derived (HKDF, `central-city/pii-kek/v1`) from `CITY_PII_KEK`. The authenticated data
  binds both layers to the account and the purpose, so a value copied elsewhere does not open.
- `CITY_PII_KEK` is 32 bytes (base64), distinct from every other secret. Hosted without a valid key
  the age check is unavailable (`409 age_check_unavailable`; Elric stays unavailable). Locally
  without it, a random per-process key is used.
- Only `server/google/pii.ts` reads it: the age check, the owner's own view, and aggregate age
  bands for operators (groups of at least 10, no per-person output; no route exposes them yet).
  It is never logged, returned in errors, exported (backups and workspace exports leave it out),
  given to MCP tools or shown to staff.
- Unlinking Google crypto-shreds the date (an under-18 lock stays). The row is deleted with the
  account.
- **Rotation:** set the new key as `CITY_PII_KEK` and the old one as `CITY_PII_KEK_PREVIOUS`, then
  run `node --import tsx scripts/rewrap-pii-keys.ts` (dry run) and `--confirm` until it reports
  `"pending":0`; then remove the previous key. It prints counts only.

### The Google birthday (off)

With `CITY_GOOGLE_BIRTHDAY_SCOPE=1`, the link also asks for
`https://www.googleapis.com/auth/user.birthday.read` (with `include_granted_scopes`) and reads the
birthday once (People API `people/me?personFields=birthdays`, preferring the account birthday,
source `ACCOUNT`), only for a link that will be written. The access token is then dropped, and a
full date goes to the same encrypted store and the same rules. A missing or hidden birthday, or
any People API error, is unknown. **Before enabling it:** the scope is sensitive, so Google must
verify the OAuth app first.

## Elric (§9 status)

- **In this change, behind the flag:** server-side ID token verification, the link that writes
  `elric_verified_identities` (unlinking deletes it), and the 18+ age confirmation.
- Elric eligibility (`server/elric/access.ts`) needs both, on every invocation and every
  pending-action approval, so unlinking stops Elric at once.
- **Still needed before real users:** a production Google Cloud OAuth client (below), then
  `CITY_GOOGLE_SIGNIN=1` in production.

## How it works

- `POST /api/auth/google/start {intent: "signin" | "link"}` returns Google's authorization URL
  (authorization code flow, `scope=openid email profile`, PKCE S256, a random `state` and `nonce`).
  `link` needs a signed-in person. The state is stored hashed with the nonce and the PKCE
  verifier for 10 minutes, and a binding cookie (`cc_google_flow`, HttpOnly, SameSite=Lax, path
  `/api/auth/google/callback`) ties the flow to the browser that started it.
- `GET /api/auth/google/callback` consumes the flow once (a replay finds nothing), requires the
  binding cookie, exchanges the code with the verifier, and verifies the ID token:
  - RS256 signature with a key from Google's JWKS (cached per `Cache-Control: max-age`, refetched
    at most once a minute for an unknown key id, so key rotation is picked up);
  - `iss` is `accounts.google.com` or `https://accounts.google.com`;
  - `aud` (and `azp`, when present) is our client id;
  - `exp` and `iat` hold within 60 seconds of skew;
  - `nonce` matches the flow's;
  - `email_verified` is true, and the domain rule above holds.
- The callback redirects only to fixed paths chosen by the server: `/rooms` after a sign-in,
  `/signin?google=<outcome>` or `/settings/account?google=<outcome>` otherwise. No return path
  comes from the request.
- `GET /api/auth/google` returns `{enabled, linked}`. `POST /api/auth/google/unlink` deletes the
  link.
- Rate limits (per 15 minutes, failing closed): 20 starts and 30 callbacks per client address,
  10 unlinks per account.

## Setup (Google Cloud OAuth client)

1. In Google Cloud Console, open **APIs & Services → OAuth consent screen**. Choose
   **External**, and add the app name, a support email and the `openid`, `email` and `profile`
   scopes. Publish the app. (Only for the Google birthday later: enable the **People API**, add
   `https://www.googleapis.com/auth/user.birthday.read` and submit the app for verification.)
2. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Choose **Web
   application**.
3. Under **Authorized redirect URIs**, add exactly:
   - `https://centralcity.ai/api/auth/google/callback` (the production `CITY_PUBLIC_ORIGIN`
     followed by `/api/auth/google/callback`; hosted deployments use only the public origin);
   - for local development, the address you open the app at, followed by
     `/api/auth/google/callback`: `http://127.0.0.1:5173/api/auth/google/callback` with
     `pnpm dev`, and `http://127.0.0.1:4310/api/auth/google/callback` with `pnpm start`
     (`localhost` is a different URI; register it too if you use it).

   No JavaScript origins are needed.

4. Set the environment variables on the server (never in the repository):
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `GOOGLE_OAUTH_CLIENT_SECRET`
   - `CITY_GOOGLE_SIGNIN=1`
   - `CITY_PII_KEK` (32 random bytes, base64; for the date of birth)

   With the flag off, or either value missing, start, callback and unlink answer 404,
   `GET /api/auth/google` answers `{enabled: false}`, and no button is shown.

## Tests

- `tests/google-signin.test.ts`: ID token verification against a local fake JWKS and signer (bad
  signature, other algorithms, wrong issuer or audience, expired, issued in the future, wrong
  nonce, unverified email, other domains, key rotation, an unreachable JWKS).
- `tests/google-signin-flow.test.ts`: the HTTP flow with a fake Google and People API: link,
  Elric eligibility, sign-in, one subject per account, unlink, the relink cooldown, single use,
  browser binding, expiry, fixed redirects, rate limits, and the Google birthday behind its flag
  (adult, 17 and locked, the 18th birthday, missing or hidden birthdays, API errors, nothing in
  plaintext).
- `tests/google-pii.test.ts`: the date of birth: the lock and refused corrections, date
  validation, no plaintext at rest, in logs or in responses, wrong account, key, byte or purpose,
  key availability and distinctness, rotation, 29 February, deletion, age bands of at least 10,
  and that only `server/google/pii.ts` reads the stored date.
- `e2e/google-signin.spec.ts` with `e2e/google-server.ts`: link, sign in and unlink in the browser
  against a mocked Google.
