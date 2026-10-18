# Base Wallet: Threat Model and Release Gates

The threat model behind agent wallets on Base (Operation Base Wallet W0–W3) and agent-to-agent
payments (Base Pay P1). It lists what each piece must defend against, the evidence a release needs,
and what is still open. It describes requirements and reviewed decisions; it is not an approval to
switch wallets on. Status as of 11 October 2026.

## Scope and authority

- Wallets and payments are merged **disabled**: every wallet route answers 404 unless
  `CITY_BASE_WALLET=1`. In production they answered 404 when checked on 11 October 2026; other
  environments were not checked for this document. The wallet network is the one constant in
  `shared/base/wallet-network.ts`: the test network (Base Sepolia, chain 84532) until the mainnet
  activation change merges, then Base (chain 8453).
- No mainnet transaction, real-money onramp or real funds without the product owner's explicit go
  **and** documented legal clearance. The product owner gave both on 11 October 2026 for wallets
  and Base Pay on Base, under the release order in gate 5. The first real-money transactions are the
  product owner's own; the team moves no real funds. A merged pull request alone switches nothing
  on.
- Goal: the owner controls withdrawal and recovery; the agent receives only a signed, bounded USDC
  spending permission. Central City must not hold an owner key, a recovery key, an administrative
  withdrawal path or an upgrade path that can seize funds. A server-held agent spender key can use
  its authorized allowance: never describe that as the server having no spending capability at all.

## Existing code it builds on

- `server/base/wallet/service.ts`: one wallet per agent and chain, derived from `[owner EOA,
SpendPermissionManager]` with a recorded factory, owner order and account index. Accepting an
  address is not proof that the browser controls its key.
- `server/base/chain/permissions.ts`: permission validation and the browser owner's typed-data
  wrapper; lazy approval and undeployed-account signatures. A hash-only signing payload needs
  independently decoded, human-readable terms before signing.
- `server/base/chain/keystore.ts`: server-decryptable agent spender keys. This is **not** an
  owner-key vault and must never be reused as one.

## Trust boundaries

Untrusted: agent and model output, room messages, API request fields, RPC responses, token symbols,
indexer events, onramp callbacks, links and QR payloads. A stolen Central City session alone must
not authorize a withdrawal, a recovery, new spending terms or a change of wallet ownership.

The browser decrypts the owner key only after the wallet password is entered. The API receives
encrypted key material and signatures, never passwords, plaintext keys or backup keys. Whoever
controls the delivered application can still steal an unlocked key: encryption at rest does not
stop malicious same-origin JavaScript. Browser extensions and compromised devices remain residual
risks. Do not claim protection against a compromised web application without a separately trusted
signing surface.

The browser encryption binds a fixed, versioned application value as authenticated data, not
the account, wallet or chain. Cross-account substitution is defended by other layers instead:
authenticated route ownership (a vault is read and written by its own account only), the owner's
signature over the complete encrypted envelope with its person and version, and checking that the
derived owner matches the expected one. Keep and test those layers; do not describe
account-specific authenticated data as implemented.

## Required controls and acceptance evidence

| Threat                                             | Required control                                                                                                                                                                                                                                                                                                                                                                                                                     | Acceptance evidence                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong network / accidental real funds              | One wallet network constant (`shared/base/wallet-network.ts`) in browser, API, signer, bundler and sponsor paths; verify the RPC chain id; no fallback to another network; mainnet needs its own gate (`CITY_BASE_MAINNET=1`).                                                                                                                                                                                                       | A mismatched network or RPC is refused before signing or broadcasting; the screens accept only the two exact network answers.                                                                          |
| Fake USDC                                          | The token address is pinned per network, never a symbol or user input; integer base units, checked decimals, no floating-point amounts.                                                                                                                                                                                                                                                                                              | Look-alike tokens and malformed or overflowing amounts are refused.                                                                                                                                    |
| Owner-key disclosure                               | Browser CSPRNG and a reviewed key library; authenticated encryption with a unique random salt and nonce; a password-derived key with versioned, bounded KDF parameters. Never log or persist plaintext.                                                                                                                                                                                                                              | Network, log and storage inspection with a synthetic key; a wrong password, a modified ciphertext and a cross-account blob substitution fail closed.                                                   |
| Offline password cracking / blob denial of service | A strong wallet-password policy and a calibrated memory-hard KDF; imported KDF parameters capped before allocation. The sign-in password and its reset are not wallet recovery.                                                                                                                                                                                                                                                      | A stolen blob needs the password; oversized KDF inputs do not exhaust the browser; a reset cannot decrypt or replace ownership.                                                                        |
| XSS / dependency compromise / phishing             | Strict CSP; no third-party scripts or analytics on unlock, backup or signing surfaces; no untrusted HTML; frame protection; locked by default and on inactivity. No secrets in URLs, telemetry, crash reports, clipboard defaults or service-worker caches.                                                                                                                                                                          | Injection and iframe tests; navigating away or locking hides the key; a browser network trace contains no secret. JavaScript zeroization is best effort, not a guarantee.                              |
| Backup omitted or wrong                            | Show the backup locally once during setup; require a local proof of possession before funding is enabled; the confirmation is bound to the exact wallet and key version. No passkeys and no server recovery copy.                                                                                                                                                                                                                    | Recovery in a fresh browser from the backup produces the identical owner and wallet address, including the counterfactual derivation.                                                                  |
| Recovery depends on Central City                   | Keep enough non-secret metadata to recover the smart account without us: network, factory, account index, owner order, implementation and wallet address; document an independent signing and recovery path.                                                                                                                                                                                                                         | A recovery and withdrawal rehearsal with the Central City API unavailable, using synthetic keys and test funds.                                                                                        |
| Address substitution / blind signing               | The browser derives the expected wallet itself, pins contracts, decodes destination, token, amount and chain, and shows the exact terms before local confirmation. Server-prepared calldata is untrusted: extra calls, approvals, upgrades and owner changes are refused. A deploying operation must be the pinned factory's `createAccount` with exactly the expected ordered owners at the agent's index.                          | Tampering with each signed field, or adding a hidden batch call, is refused. Zero, self, token-contract and QR network-mismatch destinations are tested.                                               |
| Replay / duplicate withdrawal                      | Chain- and account-bound signatures, nonce and exact calldata; server idempotency plus on-chain nonce checks. Pending is not confirmed.                                                                                                                                                                                                                                                                                              | Replays across chain or account, simultaneous submissions, timeouts and retries produce at most one withdrawal. EIP-712 alone is not replay prevention.                                                |
| Sponsor drains the balance / sponsor outage        | Fees are covered or nothing happens: only a pinned paymaster in its exact data layout with no token to charge (`shared/base/paymasters.ts`, checked at prepare and before submit, nothing pinned on the test network); no fee transfer, token-paymaster deduction or silent owner-funded fallback (an owner-funded fallback exists only behind its own setting, default off, and never for payments).                                | An empty or unknown sponsor, a bundler failure or a charging fee quote is an honest failure that reduces no funds; the recipient receives exactly the requested amount.                                |
| Limit bypass                                       | The on-chain spend permission (token, allowance, spender, period, start and end) is the only security bound; no agent owner role, arbitrary execution, token approvals, native-token permission or upgrade power. UI and server limits are defense in depth only.                                                                                                                                                                    | A compromised spender calling contracts directly cannot exceed the allowance, move ETH, change an owner or bypass limits by batching.                                                                  |
| Multiple permissions / renewal                     | Track every live permission, not just the latest settings: one active limit per token, and a new one only after Base shows the old one revoked. Explain period-boundary behaviour.                                                                                                                                                                                                                                                   | Two grants, parallel spend, boundary timestamps, expiry, replacement and stale signatures cannot exceed the advertised total authority.                                                                |
| Revocation race / crash                            | The owner signs the revocation; it shows pending until a read of Base at a settled block shows it revoked; transactions already ordered before it count. The signed revoke is stored before it is sent, so a stop in between resumes the same operation. An API toggle is not an on-chain revocation.                                                                                                                                | Pending spend versus revoke, retries, a stop before and after the chain store, and stale grant replay; an honest remaining and used display.                                                           |
| Cancel race                                        | A cancel is a sponsored no-op at the withdrawal's nonce; either may win. A signed operation stays live until its nonce is used; only unsigned requests expire. A read never decides from an older row than the one it writes.                                                                                                                                                                                                        | A read held across a concurrent cancel signature and landing never reports a failure the chain did not produce; holds are released once.                                                               |
| Forged or duplicated deposits                      | Canonical token Transfer logs scoped to chain and address; dedupe by chain, transaction hash and log index; keep block hashes, roll back on reorgs, resume a cursor safely; balances read at a named block independently of event sums.                                                                                                                                                                                              | A fake token, a duplicate or removed log, a reorg, a restart and an RPC outage never create a balance.                                                                                                 |
| Privacy / authorization                            | Vault blobs are read and written by their own account only; authorization follows the wallet's owner account, also after an agent is removed or transferred; an AI workspace is not a human owner; CSRF guard and rate limits. Agent grants cannot read owner blobs or ask for arbitrary sponsored calls.                                                                                                                            | Cross-tenant and AI-principal tests fail; concurrent setup cannot replace an existing wallet or key binding.                                                                                           |
| Payments to the wrong agent (Base Pay)             | A recipient is parsed from text only (canonical Base ID, exact passport link, passport number, address), never fetched from a user URL; verified on Base at one block (ownerOf at that block hash), behind a short-lived server-stored lookup; checked again right before the operation is prepared, and again in the browser on Base itself before review and before signing. Both wallets must be vault-linked, backed-up wallets. | Look-alike hosts, user-info, homographs, ambiguous numbers and bad checksums are refused; a recipient that changes between lookup and payment is refused; nothing is fetched from a user-supplied URL. |

## Honest product states

- Always show "Base network only" and the network the wallet is on. A mainnet identity does not
  make a test-network wallet a mainnet wallet; show the separation.
- Funding stays locked until the backup is confirmed. Anyone can still send unsolicited assets to
  a public address; the application cannot prevent that.
- A balance is an on-chain read with chain, token, block and read time. Unknown or stale is not
  zero. Pending deposits stay separate from the confirmed balance.
- ETH is visible and owner-withdrawable, never available to agents.
- "Withdraw at any time" is an ownership goal, not a promise of network or sponsor availability.
  The owner is never charged silently when sponsorship is unavailable.
- A stolen backup grants owner power. Changing the password only re-encrypts the local key; it
  does not invalidate a stolen backup. A key-compromise response needs an on-chain ownership
  rotation, designed and approved separately.
- A payment reads as paid only when final; while on its way it says so, and a failed one says it
  did not go through.

## Backup format

One raw owner private key: 64 hex characters shown as 16 numbered groups of four, with two groups
typed again to confirm. Validate length, hex encoding and the secp256k1 scalar range; derive the
address and match the expected owner before accepting a recovery. Hex alone has no checksum. An
expected address fetched only from a possibly compromised server is not independent recovery
evidence: keep trusted derivation metadata with the backup. Copying requires an explicit owner
action and warns about the clipboard; never copy automatically and never log it.

## Release gates

1. **Calendar limits** (decided by the product owner, 11 October 2026). Base enforces fixed
   periods: 24 hours, 7 days or 31 days, the first starting at 00:00 Berlin of the day the limit is
   prepared (so a limit works at once; limits created under the previous limit-start behavior start
   at the next 00:00 Berlin after they were prepared; later fixed periods can drift from local
   midnight across daylight saving), with an on-chain allowance of half the limit per period (the "half" model, the only one
   the screens offer). The app counts the Berlin calendar day, week (from Monday) and month (from
   the 1st) and refuses agent spends beyond the limit in it; that count is defense in depth, never
   the bound.
   The product decision accepts these fixed periods; it does not promise an exact Berlin-calendar
   bound. For one grant only, an argument (not yet independently proven): every period boundary
   lies a whole number of hours from a Berlin midnight, and a calendar interval is at most one hour
   longer than its period (a 25-hour day, the week holding it, October), so no day, week or month
   overlaps more than two periods of that grant, at most twice half the limit.
   `tests/base-wallet-limits-bound.test.ts` checks every interval for grants starting from October
   2026 to December 2030; a test over dates is evidence, not a proof. Revocation and replacement
   timing are outside it: a replacement grant inside the same interval starts a new allowance and
   needs a new owner signature. As a grant starts on the day it is signed, a replacement signed
   after a revoke can spend in that same interval at once; the app's calendar count (per wallet,
   across grants) still refuses agent spends beyond the new limit in it. With "full" (not
   offered), an agent could spend up to twice the limit around a reset.
2. **Live evidence** (decided, 11 October 2026). No test-network sponsor with verifiable source is
   pinned, so test-network operations fail closed. The product owner decided on a first live check
   on Base with small amounts, made personally: 1 USDC in, 0.50 USDC withdrawn, 0.10 USDC paid
   between two of the owner's new agents, then a limit set and revoked. The team watches and moves
   no funds; if anything is off, the wallet setting goes back off at once.
3. **Wallets of agents registered before wallets existed** (decided: one wallet for new
   registrations, 11 October 2026; not built yet). New registrations will use the vault key as the
   Base ID's owner, taken from the owner's own vault and never from the request, so the Base ID and
   the money share one wallet and the browser's derivation (gate 4) applies unchanged; the vault key
   then controls the Base ID as well. Agents registered earlier are not migrated: their Base ID is
   held by an identity wallet owned by the owner's external key, not the vault key, so such wallets
   are shown but never used, and payments to or from them are refused.
4. **Deployed wallet and deposit address** (done). The browser derives every wallet itself
   (`src/base/wallet/derive.ts`: the pinned factory and init-code hash, the owners `[owner key,
SpendPermissionManager]` and the agent's index) and refuses any other address before signing a
   withdrawal, a limit, a revoke or a payment. A funding address (the Add funds address, QR code and
   copy; the Wallet screen's address row) is shown only against the owner key this browser held
   itself: made, unlocked or restored here. That key's address is kept per signed-in person (the
   session's id), never per an id a vault response names. Before that, Add funds asks for one
   unlock in place, and a vault naming another account is refused. If storage refuses the key, it
   is held for that page only. Residual: the held address lives in same-origin storage, so a
   same-origin script compromise is outside this boundary (see Trust boundaries).
5. **Mainnet activation** (go given, 11 October 2026). Moving the wallet network to Base, the
   required settings (including a per-operation fee cap) and the sponsor policy are a separate
   change. It merges only after a safety review of its exact head, an attack review and full green
   CI, with the wallet setting off on deploy; the product owner then sets the production settings
   and switches it on.

## Release evidence

Every key, signing or money pull request needs: a safety review; a non-author review (another
reviewer for safety-reviewer-authored work); an independent attack review; full green CI; and,
before it is switched on, a narrowly scoped live check (gate 2). Never paste a
real backup or password into a chat, pull request or test artifact. Report local tests, teammate
reports and independent checks separately. Record exact commits and chain evidence without
secrets.

## Primary sources

- Circle USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses (Base
  Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; test tokens have no value).
- EIP-712: https://eips.ethereum.org/EIPS/eip-712 (typed structured signing; application replay
  controls are still required).
- Coinbase Spend Permissions: https://github.com/coinbase/spend-permissions (the permission
  mechanism; an exact release and deployment audit is still required).
- OWASP Password Storage Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html (basis for
  password hardening, not a complete wallet encryption design).
