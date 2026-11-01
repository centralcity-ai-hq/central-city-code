# Arc mainnet: what the owner does

Everything happens from MetaMask, on one page. The page fixes every transaction: you paste three addresses, check three amounts, and confirm eight times. Your key never leaves MetaMask, and no key is ever pasted anywhere.

Gas figures are **estimates**. Numbers marked "dry run" were asked of Arc mainnet on 31 October 2026 and sent nothing; the others were measured on Arc testnet ([TESTNET.md](TESTNET.md)). Amounts for the submitter and the facilitator are our proposal.

## Before you start

We do these first:

1. Produce the signer, submitter and facilitator addresses on the server, and give them to you. Addresses only. **Decided:** Arc has its own signer, submitters and facilitator, never Base's:
   1. We set only `CITY_ARC_OWN_PAYMASTER=prepare`. `CITY_ARC` stays off, so nobody sees Arc yet. At its next start the server provisions Arc's keys. Prepare mode sponsors and submits nothing.
   2. `GET /api/public/paymaster/arc` shows Arc's public addresses, `verifyingSigner` and `submitter`. On a server that runs Arc's paymaster alone, `/api/public/paymaster` shows the same.
   3. You paste those two addresses into step 4 of the page.
   4. Arc's fee router 3 facilitator has its own key too; the server refuses one that any role on Base also names. With the deployment holding migration 352, we call `POST /api/ops/x402/facilitator-key?purpose=arc-router3` once, with the ops secret. It creates the key inside the app and answers the facilitator's public address and an opaque key ref. A retry answers the same key; once the setting is set it answers 409. No key material leaves the server.
   5. We set the key ref as `CITY_ARC_FACILITATOR_KEY_REF`, and give you the address for step 8 of the page. It is used only when Arc is on and its router 3 is set.
2. Merge this page and tell you it's ready.

You:

1. Have about **23 USDC** on Arc mainnet in the account you'll use. It becomes the paymaster's owner, so use one you'll keep. On Arc, gas is paid from the same USDC balance.
2. Start the page on your own computer: `node scripts/protocol/serve-deploy-kit.mjs`, then open `http://127.0.0.1:8790/deploy-arc.html`. Use one browser from start to finish.

## What to do, in order

Press **Connect**. The page moves MetaMask to Arc (chain 5042), adding the network if needed. It refuses any other chain. Then press the one open button, confirm in MetaMask, and wait for the green status before the next.

| Step | What | You provide | Moves (USDC) | Gas (estimate) | Gas cost at 25-30 gwei (USDC) |
|---|---|---|---|---|---|
| 1 | Deploy PublicERC6492Validator | Nothing | 0 | 185k (dry run) | 0.0046-0.0056 |
| 2 | Deploy SpendPermissionManager | Nothing | 0 | 2.82M (dry run) | 0.0705-0.0846 |
| 3 | Deploy fee router 3 | Nothing | 0 | 811k (testnet) | 0.0203-0.0243 |
| 4 | Deploy the paymaster | Signer and submitter addresses | 0 | 1.91M (testnet) | 0.0478-0.0574 |
| 5 | Allow the submitter | Nothing | 0 | 48k (testnet) | 0.0012-0.0014 |
| 6 | Paymaster deposit | Amount, default 15 | 15 | 46k (testnet) | 0.0011-0.0014 |
| 7 | Fund the submitter | Amount, default 2 | 2 | 21k (dry run) | 0.0005-0.0006 |
| 8 | Fund the facilitator | Address, amount, default 5 | 5 | 21k (dry run) | 0.0005-0.0006 |
|   | **Total** |   | **22** | **about 5.87M** | **about 0.15-0.18** |

The dry run for steps 3 and 4 answered 819k and 1.93M, close to what testnet used. MetaMask reserves a little more than each step will use (gas limit 20% over the dry run, at the 30 gwei cap), so step 2 needs about 0.10 USDC free. The extra comes back. Keep about 1 USDC beyond the 22 for that and for later owner transactions.

## Why these amounts

- **Deposit, 15 USDC:** must be above 10. Arc's protected reserve is 10 USDC, kept for exits such as withdrawals. At or under it, every ordinary flow is refused; we saw that on testnet at 2 USDC. So 15 leaves 5 USDC for ordinary use. The page refuses 10 or less.
- **Submitter, 2 USDC (proposal):** it pays each send up front and the EntryPoint repays it, so its balance stays about level. It kept its 2 USDC through the testnet run. The server stops at 0.05, and alerts above 100; the page holds the amount between them.
- **Facilitator, 5 USDC (proposal):** it pays the gas of every settlement, and nothing repays it. At 25 gwei that is about 1,010 settlements. The server stops under 1 USDC, and alerts above 50; the page holds the amount between them.
- **Fee, 25-30 gwei:** the page pays 25 and allows up to 30. Keep MetaMask's suggested fee. Arc's floor is 20 gwei, and a lower fee doesn't fail: it stays pending and blocks your next transactions until replaced at a higher fee. If you see that warning, use **Speed up** in MetaMask.

## What the page protects

- The router's token (Arc USDC) and treasury (`0xAF36084a4dc0CE760A6dCfa46Cf129e140c92aa9`) are fixed: there is no field for them.
- It recomputes where the two replayed contracts land, checks every kit file against approved hashes, and refuses all steps on any difference.
- It skips what's already done, reading from Arc's public endpoint, and reads each step back afterwards.
- After a reload it never offers a sent transaction again.

**If a step says the outcome is unknown, or a status turns red:** stop, and send us a screenshot. Don't try again from another browser, and don't clear the browser's data.

## What you give back

At the end the page shows four lines. Copy them to us. They're public, and contain no key:

```text
CITY_ARC_FEE_ROUTER3=<shown by the page>
CITY_ARC_FEE_ROUTER3_FROM_BLOCK=<shown by the page>
CITY_ARC_PAYMASTER=<shown by the page>
CITY_ARC_RPC_URL=https://rpc.mainnet.arc.io
```

## What we do afterwards

1. Record the SpendPermissionManager (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`) for chain 5042 in `shared/chains.ts`. **Required:** it is empty in code today, and without it Arc mainnet stays off whatever the settings say.
2. Pin the new paymaster for Arc in `SPONSOR_PAYMASTERS` (`shared/base/paymasters.ts`). **Required:** operations on a real-money chain take a pinned sponsor or nothing.
3. Set the four settings, plus the rest of Arc's server settings (below), in production, and move `CITY_ARC_OWN_PAYMASTER` from `prepare` to `on`.
4. Try one small operation end to end before anything larger.

## Done 31 Oct 2026

The owner ran the page on Arc mainnet (chain 5042). The four public lines it gave back, each read back on chain:

```text
CITY_ARC_FEE_ROUTER3=0xe807a76385ec3d76d17ab955091c12329d0a1403
CITY_ARC_FEE_ROUTER3_FROM_BLOCK=28866621
CITY_ARC_PAYMASTER=0x271bfb75ca5741875f1c69bf478252133896fada
CITY_ARC_RPC_URL=https://rpc.mainnet.arc.io
```

The paymaster runs on EntryPoint v0.6 with signer `0x68CeE07C0391682836AaFf59475e70Bc9D91100D`. Steps 1 and 2 above are now in code: the SpendPermissionManager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` is recorded for 5042 in `shared/chains.ts`, and the paymaster is pinned for Arc in `SPONSOR_PAYMASTERS`. Arc stays off until `CITY_ARC=1` is set in production (step 3).

## Production settings

Every `CITY_ARC` name that `server/` and `shared/` read on 31 October 2026. Values aren't listed here. A key ref is a pointer into the encrypted keystore, not a key; it is still never logged. "Required" means required for Arc mainnet to run with payments through router 3.

| Setting | Required? | What it does |
|---|---|---|
| `CITY_ARC` | Required | Exactly `1` turns Arc on. |
| `CITY_ARC_CHAIN_ID` | Optional | Which Arc network. Unset is mainnet, 5042; testnet is 5042002. |
| `CITY_ARC_RPC_URL` | Required | Arc's endpoint, https. The chain runtime refuses to start without it, even though some reads fall back to Arc's public endpoint. |
| `CITY_ARC_MAX_FEE_PER_GAS_WEI` | Required | Hard cap on the gas price. Refused under Arc's 20 gwei floor. |
| `CITY_ARC_IDENTITY_FEE_CAP_WEI` | Required | Fee budget of one identity operation, in USDC of gas (18 decimals). Required on mainnet. |
| `CITY_ARC_WALLET_FEE_CAP_WEI` | Required | Cost cap of one owner operation or agent payment, in USDC of gas. Required on mainnet: without it those aren't built. |
| `CITY_ARC_OWN_PAYMASTER` | Required | `prepare` makes the keys and shows their addresses, even with `CITY_ARC` off. `on` sponsors. Arc has no other bundler, so it must end at `on`. |
| `CITY_ARC_PAYMASTER` | Required | The paymaster the page deployed. |
| `CITY_ARC_FEE_ROUTER3` | Required | Router 3 the page deployed. Read only together with `_FROM_BLOCK`. |
| `CITY_ARC_FEE_ROUTER3_FROM_BLOCK` | Required | Its deploy block, where the fee ledger starts reading. Without it router 3 counts as not configured. |
| `CITY_ARC_FEE_ROUTER3_ENABLED` | Required | Exactly `1` lets new fee-included payments on Arc pin to router 3. Set it last. |
| `CITY_ARC_FACILITATOR_KEY_REF` | Required | Key ref of the facilitator (`?purpose=arc-router3`). Without it nothing settles through router 3 on Arc. |
| `CITY_ARC_PAYMASTER_SIGNER_KEY_REF` | Optional | Arc's signer key ref. Unset, the key recorded at provisioning is used. |
| `CITY_ARC_SUBMITTER_KEY_REFS` | Optional | Arc's submitter key refs, comma-separated. Unset, the recorded keys are used. |
| `CITY_ARC_READ_FALLBACK_RPC_URL` | Optional | A second endpoint for reads, https. Unset, Arc's public endpoint on a hosted server. |
| `CITY_ARC_SPONSOR_INFLIGHT_WEI_PER_WALLET` | Optional | Sponsored gas in flight per wallet. Unset, 5 USDC. |
| `CITY_ARC_SPONSOR_INFLIGHT_WEI_TOTAL` | Optional | Sponsored gas in flight in total. Unset, 50 USDC. |
| `CITY_ARC_SFP_SENDER_MIN_GAS_WEI` | Optional | The sponsored sender's minimum gas balance. Unset or outside 2-50 USDC, 5 USDC. |
| `CITY_ARC_HOT_CEILING_<ROLE>_<ASSET>` | Optional | A hot wallet's ceiling, in raw units. `<ASSET>` is `USDC` or `GAS`. Unset or unparsable, the default in `chain-params.ts`. |
| `CITY_ARC_HOT_OUTFLOW_<ROLE>_<ASSET>` | Optional | A hot wallet's expected hourly outflow, same form. |
| `CITY_ARC_TREASURY` | Not on mainnet | A throwaway treasury on testnet. Ignored on mainnet, where the fee goes to Base mainnet's treasury. |

Arc also uses two kinds of settings it shares with Base: `CITY_BASE_SPENDER_KEK` (required, seals Arc's keys) and `CITY_BASE_SPONSOR_OPERATOR_ACCOUNTS` / `CITY_BASE_SPONSOR_OPERATOR_OWNERS` (who the fleet operators are). No other `CITY_BASE_*` setting reaches Arc's runtime. Base must stay configured: screening reads Base's oracle through Base's client.

## To decide

- Whether production uses Arc's public endpoint or a paid one. The page shows the public one; changing it later is one setting.
- How much to fund the fleets, and when. They aren't part of this page.
- The tip cap and the minimum price: at 25 gwei a minimum-price sale barely covers its gas ([TESTNET.md](TESTNET.md)).
- Whether routers 1 and 2 are needed on Arc. This page deploys router 3 only.

**Facilitator key:** `CITY_ARC_FACILITATOR_KEY_REF` is one setting for both Arc networks. Make a fresh `arc-router3` key for mainnet; a testnet key is never carried over.
