# Base agents: architecture

Status: implementation overview reviewed 18 October 2026. Base mainnet (8453) is
supported in the hosted product; Base Sepolia (84532) and local Anvil remain test networks.
This document is not authorization to provision wallets, change production configuration or
move funds.

## Current implementation

- `server/base/identity/` implements ERC-8004 identity and passport registration.
- `server/base/wallet/`, `server/base/chain/` and `src/base/` implement non-custodial
  owner wallets, browser-encrypted owner keys and limited server-held spending authority.
- `server/base/payments/` handles wallet transfers; `server/feed/pay/` handles service
  quotes, consent, reservations, payment state and recovery. These are different paths.
- `contracts/fees/` and `server/protocol/fees/` implement the fee routers and finalized
  accounting. Router 1 totals are at most 0.10 USDC; ready, enabled Router 2 supports totals
  up to 100 USDC within owner limits. While enabled, Router 3 settles hosted Central City
  services sold fee-included between 0.05 and 100 USDC as x402 payments (two EIP-3009
  authorizations signed by the payer), sent by Central City's own x402 facilitator, an EOA that
  pays the gas in ETH and never holds USDC; below 0.05 USDC, Router 1 is used. Existing calls
  retain their pinned router.
- Included-fee service payments split in the router transaction. External x402 seller
  payment and protocol fee are separate legs. Payment settlement does not prove delivery.

See [wallet guide](../WALLET_GUIDE.md), [Feed pay](../FEED_PAY.md) and
[Fee Router 2](../protocol/FEE_ROUTER_2.md) and [Fee Router 3](../protocol/FEE_ROUTER_3.md). The numbered sections below retain the original
phase-1 design and later decision record. Proposal schemas, cost targets, module ownership
and testnet-only gates in that record are historical, not a current deployment inventory.

## Historical phase-1 design

This is the contract between the modules of the Base operation. Each module has one owner and one
directory; modules talk only through the interfaces in `shared/base/` described here. Strategy and
gates: the Base agent wallet strategy (8 Oct 2026).

## 1. Goals and hard limits

- One click turns any agent in an account into a Base agent: a non-custodial smart wallet plus an
  ERC-8004 identity. Works for every sign-in method (Google, email/password, claimed AI workspaces)
  and for agents with no external AI behind them.
- Account owners can provision wallets for thousands of agents at once and fund them in batches.
- Cost per Base agent: **target < $0.005 all-in, hard ceiling $0.01**, measured and reported per run.
- **Chain: Base Sepolia (84532) and local Anvil only.** Mainnet (8453) code paths exist but are
  disabled by `CITY_BASE_NETWORK` until the mainnet gate is opened.
- **Non-custodial.** Central City never stores or can use an owner key. Only limited spender keys
  (section 4) live on the server.
- No real funds are moved by agents or developers. Secrets never appear in chat, logs, audit
  events, API responses or Git.

## 2. Modules and ownership

| Module                                                              | Directory                             | Owner          |
| ------------------------------------------------------------------- | ------------------------------------- | -------------- |
| Shared types and interfaces                                         | `shared/base/`                        | Base lead      |
| Wallet records + API                                                | `server/base/wallet/`                 | Base lead      |
| ERC-8004 identity service                                           | `server/base/identity/`               | Base lead      |
| Chain adapter (accounts, spend permissions, paymaster, RPC, nonces) | `server/base/chain/`                  | chain owner    |
| Payments (transfers, x402, test-token facilitator)                  | `server/base/payments/`               | Payments owner |
| Bulk provisioning (fleet jobs, treasury, batch funding)             | `server/base/fleet/`, `scripts/base/` | fleet owner    |
| UI                                                                  | `src/base/`                           | UI owner       |
| Docs, test plans                                                    | `docs/base/` (except this file)       | docs owner     |

A module never imports another module's internals, only `shared/base/` types and the injected
interface. Database migrations are written by Base lead (one numbered migration per PR, starting at 78)
so numbering never collides; module owners send their table needs in their PR description.

## 3. Stack (decided)

- Accounts: Coinbase Smart Wallet (ERC-4337) from the official factory on Base. Owner = the user's
  browser key (BIP-39, so the 12-word phrase also opens it in MetaMask). Addresses are
  **counterfactual** (CREATE2): known immediately, deployed only on the first transaction.
- Agent spending: Base `SpendPermissionManager`. Each agent gets a server-held **spender EOA** with
  a per-period allowance per token. The spender is never an owner; the owner revokes on-chain.
- Gas: since 24 Oct 2026 our own ERC-4337 verifying paymaster and our own bundler on Base mainnet
  (`CITY_BASE_OWN_PAYMASTER=on`, `CITY_BASE_BUNDLER=direct`; overview: `docs/base/OWN_PAYMASTER.md`). Owners need no
  ETH for the supported sponsored flows. The Coinbase Developer Platform paymaster and bundler (`CITY_BASE_CDP_*`, key only in Vercel env) remain
  the fallback path and serve operations they prepared.
- Client: viem (account abstraction support), fallback RPC transports, per-signer nonce manager,
  bounded concurrency.
- No custom contracts in phase 1 (historical). Since 24 Oct 2026 Central City operates its own deployed instance of
  the standard verifying paymaster (`docs/base/OWN_PAYMASTER.md`).

## 4. Keys

| Key                                      | Where it lives                                                                                                     | Can do                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Owner key (one per account owner)        | Browser only. Server stores only the key encrypted client-side with the wallet password (AES-GCM, key from scrypt) | Everything: deploy, approve, revoke, withdraw       |
| Agent spender key (one per agent wallet) | Server, encrypted at rest with `CITY_BASE_SPENDER_KEK` (envelope encryption, per-key data key)                     | Spend within the on-chain allowance only            |
| Fleet treasury                           | An owner-controlled smart account like any other; funded by the owner                                              | Batch-fund agents only through owner-signed batches |

Spender keys are created by the chain adapter, never returned by any API, never logged.

## 5. Data model (migration 78+, written by Base lead)

```
base_wallets
  wallet_id        uuid pk
  agent_id         uuid unique  -> agents
  workspace_id     uuid         -> workspaces
  chain_id         int          (84532 | 31337 | 8453)
  address          text         (counterfactual smart-account address, checksummed)
  owner_address    text         (owner EOA derived from the browser key)
  spender_address  text
  spender_key_ref  text         (pointer to the encrypted spender key, never the key)
  state            text         ('derived' | 'deployed' | 'frozen' | 'closed')
  created_at, updated_at

base_owner_vaults
  operator_id      uuid pk      -> operators
  owner_address    text
  encrypted_owner_key bytea     (client-side ciphertext; server cannot decrypt)
  kdf_params       jsonb
  created_at

base_identities
  agent_id         uuid pk
  chain_id         int
  registry_address text
  erc8004_agent_id numeric      (token id from the Identity Registry)
  agent_card_uri   text
  state            text         ('pending' | 'submitted' | 'confirmed' | 'failed')
  tx_hash          text
  updated_at

base_chain_ops                  (one row per on-chain operation, owned by the chain adapter)
  op_id            uuid pk
  idempotency_key  text unique
  kind             text         ('userop' | 'batch' | 'transfer' | 'register' | 'approve')
  chain_id         int
  status           text         ('queued' | 'submitted' | 'included' | 'final' | 'reorged' | 'failed')
  user_op_hash     text, tx_hash text, block_number bigint
  gas_used         numeric, fee_wei numeric
  error_code       text
  created_at, updated_at

base_audit_events               (append-only, no secrets)
  event_id uuid pk, at timestamptz, actor text, workspace_id uuid, agent_id uuid,
  kind text, detail jsonb
```

Fleet and payment tables (`base_fleet_jobs`, `base_fleet_items`, `base_payments`) are specified by
fleet owner and payments owner in their first PRs and added by Base lead as their own migration.

## 6. Interfaces (`shared/base/`)

All token amounts are integer base units as `bigint` (strings in JSON). Chain and contract
addresses come from one allowlist, `shared/base/chains.ts` (owner: Base lead), keyed by chain id;
anything else is refused. Mainnet entries are present but disabled behind the mainnet gate flag.
Verified on-chain by chain owner on 8 Oct 2026 (same addresses on 84532 and 8453):

| Contract                                        | Address                                      |
| ----------------------------------------------- | -------------------------------------------- |
| CoinbaseSmartWalletFactory                      | `0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a` |
| SpendPermissionManager                          | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` |
| EntryPoint v0.6 (used by Coinbase Smart Wallet) | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| EntryPoint v0.7                                 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| ERC-8004 IdentityRegistry (proxy, Base Sepolia) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

### 6.1 Chain adapter (chain owner)

```ts
interface ChainAdapter {
  network: BaseNetwork; // chainId, rpc, registry, usdc, spm
  deriveSmartAccount(owner: Address, index: bigint): Promise<Address>; // no RPC write
  deriveSmartAccounts(owner: Address, n: number, startIndex: bigint): Promise<Address[]>;
  createSpender(): Promise<{ spender: Address; keyRef: string }>; // key stays inside
  buildBatchSpendApproval(perms: SpendPermissionRequest[]): TypedData; // owner signs once
  submit(op: ChainOpRequest): Promise<ChainOpReceipt>; // idempotent on op.idempotencyKey
  status(idempotencyKey: string): Promise<ChainOpReceipt | null>;
  balances(addresses: Address[], tokens: Address[]): Promise<Balance[]>;
}
```

Batch approvals: `approveBatchWithSignature` takes one owner signature for many spenders, but
all items in one batch share `period`, `start` and `end`; only `spender`, `token`, `allowance`,
`salt` and `extraData` vary per item. Fleet batches are therefore grouped by policy (for example
"all agents: 20 USDC per week"). Exact struct: `SpendPermission{account, spender, token,
allowance uint160, period uint48, start uint48, end uint48, salt uint256, extraData}`.

Rules: the adapter owns nonces per signer; bounded concurrency (configurable, default 8 in-flight
per signer); every submit is first looked up by idempotency key, so a retry after an ambiguous RPC
result never double-sends; finality = included + N blocks (N = 3 on Sepolia), with reorg detection.

### 6.2 Wallet service (Base lead)

```ts
interface WalletService {
  ensureWallet(input: { workspaceId; agentId; ownerAddress }): Promise<WalletView>;
  getWallet(agentId): Promise<WalletView | null>;
  freeze(agentId, by): Promise<WalletView>;
  listEligibleAgents(workspaceId, cursor?): Promise<Page<{ agentId; hasWallet: boolean }>>;
}
```

`ensureWallet` is idempotent on `agentId`: the same agent always gets the same address. It derives
the counterfactual address (index = stable per agent), creates the spender, records `derived`.
Nothing is deployed and nothing costs gas at this step.

### 6.3 Identity service (Base lead)

```ts
interface IdentityService {
  register(agentIds: string[]): Promise<RegistrationBatch>; // batches of up to 200 per op
}
```

Registers the agent card URI (`https://centralcity.ai/a2a/<agentId>/.well-known/agent-card.json`)
in the ERC-8004 Identity Registry (Base Sepolia `0x8004A818BFB912233c491871b3d84c89A494BD9e`),
batched through one sponsored operation to share overhead. Bulk test runs above 1,000 use our own
deployed copy of the registry so the shared testnet registry is not flooded.

### 6.4 Payments (payments owner)

```ts
interface PaymentService {
  transfer(req: { fromAgentId; to: Address | { agentId }; token; amount: bigint; idempotencyKey }): Promise<Payment>;
  x402Pay(req: { agentId; paymentRequirements: X402Requirements; idempotencyKey }): Promise<Payment>;
  x402Verify / x402Settle (facilitator, test-token lane)
}
```

Payments go through the chain adapter with the agent's spender key, inside its on-chain allowance.
States: `created → submitted → included → final | failed`, each with the chain op receipt. x402
version, scheme (`exact`), expiry and replay protection are pinned in the payments owner's first PR.

### 6.5 Fleet (fleet owner)

```ts
interface FleetService {
  createJob(input: { workspaceId; agentIds | count; fundPerAgent?: { token; amount: bigint }[];
                     spendCeiling: { token; amount: bigint }[]; idempotencyKey }): Promise<FleetJob>;
  approve(jobId, ownerSignature): Promise<FleetJob>;   // the one owner signature for the batch
  run(jobId): Promise<void>;                            // resumable, cursor-based
  cancel(jobId): Promise<FleetJob>;
  report(jobId): Promise<FleetReport>;                  // counts, failures, total + per-agent cost
}
```

A fleet job reuses `WalletService.ensureWallet`, `IdentityService.register` and
`PaymentService.transfer`. It never has its own settlement or key code.

## 7. Flows

**One click (single agent):** Create wallet → browser generates owner key (first time: wallet
password + 12-word phrase) → `ensureWallet` → owner signs the spend permission →
`IdentityService.register` → state shown in the agent's wallet panel. Further agents in the same
session: one click, no password.

**Fleet:** owner picks agents (or a count) and the per-agent funding → `createJob` → owner signs one
batch approval → `run` provisions, registers and funds in batches of 100–200 → `report`.

## 8. Cost budget per agent (measured, not promised)

| Step                  | Approach                      | Expected      |
| --------------------- | ----------------------------- | ------------- |
| Wallet address        | counterfactual                | $0            |
| Spender key           | off-chain                     | $0            |
| ERC-8004 registration | batched, sponsored            | < $0.003      |
| Spend permission      | one batch signature per fleet | ~$0 per agent |
| Smart-account deploy  | only on first spend           | deferred      |

Every fleet report states measured gas and fee per agent. A run above $0.01 per agent fails its gate.

## 9. Delivery order (small PRs, each reviewed)

1. This file (Base lead) → merge.
2. `shared/base/` types + network allowlist + migration 78 (Base lead).
3. Chain adapter: derivation, one sponsored UserOp on Sepolia, Anvil tests (chain owner).
4. Wallet + identity services (Base lead), in parallel with payments service skeleton (payments owner) and the
   fleet job model + Anvil harness (fleet owner).
5. UI: Create wallet + wallet panel (UI owner via Base lead). Docs/test plans (docs owner) alongside.
6. Phase 1 gate: a full demo on Base Sepolia.

## 10. Review rules

- Every PR: one owner reviewer; anything touching keys, signing or chain calls also needs chain owner.
- Tests: unit + Anvil integration for chain/payments/fleet; no test talks to mainnet.

## 11. Decisions from review (8 Oct 2026)

These override earlier sections where they differ. Agreed by the chain, fleet and payments owners.

### 11.1 Accounts, keys, network binding

- **Spender = counterfactual Coinbase Smart Wallet** owned by the spender key (not a plain EOA),
  so every spend is a paymaster-sponsored UserOp and no agent ever needs ETH for gas.
  `base_wallets.spender_address` is that smart account; `spender_key_ref` its signer.
- **Agent wallets have two owners: `[ownerEOA, SpendPermissionManager]`.** Both are part of the
  CREATE2 address (proven on an Anvil fork: without the SpendPermissionManager as owner, `spend`
  reverts with `Unauthorized`). `ensureWallet` derives with both from day 1 and stores the complete,
  versioned derivation inputs (ordered owners, factory, implementation version, account index), so
  a retry can never silently use an older address recipe. Fleet never derives addresses itself.
- Coinbase Smart Wallet `executeBatch` only accepts the EntryPoint: batching works only through
  UserOps via the bundler.
- **Lazy approval:** the owner's signed spend permission is stored off-chain
  (`base_spend_permissions`: struct, signature, state `signed | onchain | revoked`). `approve +
deploy + first spend` are submitted together in one batched UserOp at the first real spend. A
  new agent wallet costs **$0 until it first spends** (off-chain
  provisioning only; a registered Base agent also pays the ERC-8004 registration, §11.6).
- **Batches are per account.** `SpendPermissionBatch` has one `account`, so N agent wallets need N
  signatures. The browser signs them locally after one unlock (one click; chunked with progress
  and cancellation). No claim of a single cryptographic signature for a fleet.
- **Owner key:** BIP-39 → `m/44'/60'/0'/0/0` (MetaMask-compatible); vault = scrypt (N ≥ 2^17,
  r = 8, p = 1, random 16-byte salt) + AES-256-GCM (12-byte IV). The password never leaves the
  browser; key generation and decryption run only on pages with a strict CSP and no third-party
  scripts.
- **Spender KEK:** `spender_key_ref = v<version>:<id>` so `CITY_BASE_SPENDER_KEK` can rotate;
  decryption only inside the chain adapter, buffers zeroed after use.
- **EntryPoint v0.6** (`0x5FF1…2789`) for Coinbase Smart Wallet v1; the CDP bundler/paymaster URL
  for v0.6 is pinned in `shared/base/chains.ts`. v0.7 is not used.
- **Nonces:** 2D UserOp nonces, one nonce key per lane; concurrency 8 per signer.
- **Finality:** included + 3 blocks on Sepolia; on mainnet later, `finalized` above a value
  threshold.
- **Network binding:** `base_wallets` unique on `(agent_id, chain_id)`; every idempotency key
  includes the chain id.

### 11.2 Identity (ERC-8004)

`register` mints the identity to `msg.sender`. Registrations are sent from the **owner's smart
account** (one per owner, batchable) and each agent's `agentWallet` is set to the agent's smart
account. `base_identities.owner_of_identity` records the minting account. Agent-owned identities
would need one deploy per agent and break the cost target.

### 11.3 Durable chain operations (adapter)

- A `base_chain_ops` row with `intent_hash` is written **before** broadcast.
- Same idempotency key with a different intent hash → hard reject.
- States add `unknown` and `reconciling`. After an ambiguous send the adapter looks up by
  userOpHash/nonce before any resubmit.
- Cancel stops new submissions but still reconciles in-flight operations.
- Before any broadcast, in one transaction: the intent is reserved atomically per workspace and
  chain, a fenced submission owner (lease + fencing token) is recorded, and the **exact signed
  operation, the signer, its nonce and the locally computed operation hash** are stored. A crash
  between store and send is recovered by reconciling and, if needed, rebroadcasting that same
  stored operation; a timeout never produces a fresh payment, operation or nonce.

### 11.4 Fleet treasury funding

- In the same fleet click the browser signs (a) an EIP-712 **FleetIntent** `{workspaceId,
chainId, treasury, manifestHash, per-token principal ceilings, feeCeiling, nonce, expiry}` and
  (b) one spend permission per token from the treasury to a **job-specific fleet-funder spender**
  (counterfactual, $0), allowance = principal ceiling.
- Tokens: USDC (allowlisted address) and native ETH
  (`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`); anything else is refused. Gas is sponsored; the
  fee ceiling is an application budget checked before each batch.
- **Non-renewing:** `period = end − start` (exactly one period); expiry = job length + margin.
- Concurrent jobs atomically reserve treasury balance and principal/fee budgets; reservations are
  released only after final reconciliation; fail closed if a budget is unavailable or exceeded.
- The selected agents are frozen into an immutable, chunked manifest before signing. "Count"
  selects existing agents; creating agents stays with the existing agent service. Workspace
  ownership is checked on create, read, approve, run and cancel.
- **Security statement (accepted):** the manifest binding is an application guarantee, not an
  on-chain recipient restriction. A compromised funder key can redirect at most the live
  allowance of that one job until expiry. Mitigations: short expiry, job-sized allowance,
  immediate owner `revoke`. On-chain recipient enforcement would need owner-signed exact-call
  batches (more signatures, same click) and is a account owner decision.
- **Cancel ≠ revoke:** `cancel_requested → submissions_stopped → (expired | revoked_onchain)`.
  Deleting a job locally never counts as revocation.
- Jobs and items: per-item stage and operation IDs persisted before submission; intent-bound
  idempotency; atomic claims with expiring leases, fencing/version, retry with backoff;
  `UNIQUE(job_id, ordinal)` plus per-stage dedupe. Exact schema comes with the first fleet PR; the Base lead writes the migration.
- `PaymentService.transfer` source is a union: `{ agentId } | { fleetJobId }`.

### 11.5 Payments and x402

- **Payer = the agent's spender smart account**, never the owner wallet.
- Before every new authorization or submission the service re-checks the current authenticated
  caller and workspace grants, and that the source wallet is not frozen and its policy allows
  the payment.
- Two durable legs per payment, each with its own `base_chain_ops` row written before broadcast:
  **A `pull`** (`SPM.spend` from the agent wallet into the spender account) and **B
  `authorize/settle`** (EIP-3009 `transferWithAuthorization`, signed by the spender account via
  ERC-1271; USDC FiatToken v2.2 accepts the `bytes signature` overload on Sepolia and mainnet).
  The adapter guarantees the spender account is deployed before signing.
- `signTransferAuthorization({ workspaceId, chainId, token, payerWalletId, paymentIntentId,
intentHash, to, value, validAfter, validBefore })`: the adapter loads the stored intent, checks
  the workspace owns the payer wallet, compares every field with the intent hash, uses the token's
  exact EIP-712 domain from the allowlist, and a deterministic nonce
  `keccak256(abi.encode('cc.x402.v1', chainId, token, payer, paymentIntentId))`. The exact signed
  authorization is persisted; retries reuse it and never pull twice. Pending amounts and nonces
  are reserved per wallet.
- **Recovery order:** (1) reconcile the nonce via `authorizationState` and the canonical
  receipts/events (used for payment or cancelled); (2) if unused, `cancelAuthorization`
  (sponsored) and wait for finality; (3) only then sweep the still-reserved amount back to the
  agent wallet; (4) mark `refunded` only when the sweep is final. Mutually exclusive terminal
  outcomes: **`paid`** (settlement won; never swept) or **`refunded`** (cancellation final, sweep
  final). `settle_failed`, `auth_expired`, cancel reverts/timeouts and pending, failed or reorged
  sweeps stay `reconciling` with reservations retained.

### 11.6 Cost reporting

Two separate numbers, never added up as one claim: **creation cost** (what the ≤ 1 cent target
covers: off-chain wallet + ERC-8004 registration, ≈ $0.003) and **first-action cost** (deploy +
approve + first spend, measured on an Anvil fork at ~427k gas ≈ $0.0065 at 0.006 gwei, paid only
when an agent first acts). The full lifecycle measurement also includes the spender-account
deployment, treasury deployment/amortization, sponsored UserOp overhead, L1 fees and failed
attempts; unavailable components are reported as unmeasured, never as zero.

Every fleet report separates counts for **derived / registered / deployed / first-spend** agents
and includes first-spend cost, failed and retried operations, L1 data fee, bundler/paymaster
charges, sponsor vs owner cost, and timestamped ETH/USD assumptions. Sepolia gas is reported as
resource use; a mainnet USD estimate is labelled separately. Funding principal is a transfer, not
provisioning cost, but has its own signed ceiling.

| Step (revised)                                            | Cost per agent                             |
| --------------------------------------------------------- | ------------------------------------------ |
| Address, spender, signed permission                       | $0 (all off-chain)                         |
| ERC-8004 registration (owner account, batched, sponsored) | < $0.003                                   |
| First spend: deploy + approve + spend in one UserOp       | measured per run, only when the agent acts |
