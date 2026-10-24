# Fee router 3: x402 settlement, fee included (pinned spec)

19 Oct 2026. Router 3 lets a Central City service payment settle as an x402 payment: one
transaction sent by an x402 facilitator, from authorizations the buyer signed off-chain. The fee
model stays the same as router 1 and 2's `pay`: fee included, 90% to the seller, 10% to the
treasury, one `FeeCharged` event (kind 1).

## Contract

`contracts/fees/CentralCityFeeRouter3.sol`: immutable, ownerless, never holds a balance.

- `settle(Settlement)`: one payment. `settleBatch(Settlement[])`: several in one transaction, all or
  nothing (the facilitator falls back to one by one).
- `Settlement`: `payer`, `payee`, `gross`, `ref`, `validAfter`, `validBefore`, `sellerSignature`,
  `feeSignature`.
- It calls Base USDC (FiatToken v2.2) `transferWithAuthorization` twice: payer to payee
  `gross - fee`, payer to treasury `fee`, with `fee = gross / 10`. The bytes-signature overload
  accepts an EOA signature or ERC-1271 (agent spender smart accounts).
- Nonces are derived by the router: `nonceFor(payer, payee, gross, ref, validAfter, validBefore,
leg)` with leg 0 (seller) and 1 (fee), domain tag `centralcity.router3.settle.v1`, chain id, router
  address and treasury. The buyer signs exactly those nonces, so both legs belong to one purchase; a changed
  amount, payee, ref, window or swapped leg does not verify.
- `ref` is `keccak256(call id)`; each settlement emits `FeeCharged` kind 1.
- One settlement per `(payer, ref)` (commitment, `AlreadyCharged` / `RefMismatch`), plus EIP-3009's
  own one-time nonces.
- Limits: `MIN_INCLUDED` 50,000 ($0.05) to `MAX_TOTAL` 100,000,000 ($100) per payment; payee not
  zero, not the treasury, not the payer; payer not the treasury.

Known property: each authorization is a standard EIP-3009 authorization, so whoever holds one could
submit it to USDC directly. Then `settle` reverts (nonce used) and nothing moves twice; the app reconciles that as a partial
payment and never re-signs new nonces for it; the
signatures only travel from the buyer to Central City's own resource server and facilitator, and
Base has no public mempool.

## Why two authorizations

x402 dashboards count USDC transfers in transactions sent by listed facilitators. Two transfers
straight from the buyer count every unit once. One authorization to the router would add
router-to-seller and router-to-treasury transfers and count the payment about twice.

## Evidence (19 Oct, local fork of Base mainnet, real USDC)

`pnpm tsx scripts/protocol/router3-fork-check.ts` (anvil fork, fresh keys): PASS.

| Case                                                             | Result                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| EOA buyer, 1 USDC                                                | seller +0.90, treasury +0.10, router 0, two transfers, one FeeCharged; 163,930 gas |
| Contract wallet buyer (ERC-1271), 100 USDC                       | seller +90.00; 168,804 gas                                                         |
| Batch of 3                                                       | 385,053 gas (128,351 per sale)                                                     |
| Replay, swapped legs, other amount, payee or ref                 | refused                                                                            |
| A leg used directly on USDC first                                | settle refused                                                                     |
| Over 100 USDC, under 0.05 USDC, expired window, payee = treasury | refused                                                                            |

Today's sponsored `pay` UserOp: 207,280 gas (canary, 18 Oct).

## Deploy

`ROUTER=3 pnpm tsx scripts/protocol/build-deploy-kit.ts` writes `contracts/deploy-kit/router3.json`
(creation bytecode hash `0xb6487fd6…7935`). `node scripts/protocol/serve-deploy-kit.mjs`, then
`http://localhost:8790/deploy.html?router=3`, connected as the treasury
`0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9`.

Deployed on Base mainnet on 19 Oct 2026 by the treasury, source verified on Basescan:

| What                    | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `CentralCityFeeRouter3` | `0xe807a76385ec3d76d17ab955091c12329d0a1403`                         |
| Deploy transaction      | `0xd68eed17124e592c978df2be9a3bf3d7882b92a9bfad5266aea632228aa92b5a` |
| Deploy block            | `52804453`                                                           |
| `FEE_BPS`               | `1000` (10%, fee included)                                           |
| `MIN_INCLUDED`          | 0.05 USDC                                                            |
| `MAX_TOTAL`             | 100 USDC                                                             |

## Live on Base mainnet

- **Facilitator.** Central City's own x402 facilitator, the EOA
  `0xc8d6Bac2ff7182d22c4f316BffF9f713261A6cEC`, sends router 3 settlements and pays their gas in
  ETH. It never holds USDC: both legs move straight from the payer.
- **Routing.** Hosted Central City services sold fee-included between 0.05 and 100 USDC settle
  through router 3 while `CITY_PROTOCOL_FEE_ROUTER3_ENABLED=1`. Other payments keep router 1
  (`0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B`, up to 0.10 USDC) and router 2
  (`0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d`, up to 100 USDC); below 0.05 USDC, router 1 is used.
- **First settlement (canary).** Transaction
  `0x343af3dbc00d25760c8d48b2b2e639b6e63ad81a93042f2c4a5282e13151f4c9`, block 52807250 (19 Oct 2026, 09:57 UTC): 1.04 USDC
  gross, 0.936 USDC to the seller and a 0.104 USDC fee to the treasury.
- **DefiLlama.** Both merged on 19 Oct 2026: dimension-adapters
  [#10269](https://github.com/DefiLlama/dimension-adapters/pull/10269) (the fees adapter counts
  router 3) and [#10270](https://github.com/DefiLlama/dimension-adapters/pull/10270) (the
  facilitator is in `dexs/x402/facilitators.ts`, so these settlements count in DefiLlama's x402
  listing). The figures include payments made by all agents created on Central City, counted under
  the same rules.

## x402 wire format

Stock x402 `exact` clients sign ONE authorization with a random nonce to `payTo`, so they cannot
pay through router 3. Central City's own buyers use a named, versioned split scheme; an external
buyer needs that client adapter. Plain `exact` compatibility for outside buyers is a separate
decision.
