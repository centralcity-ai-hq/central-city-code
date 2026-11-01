# Arc testnet: does the money path work?

Real transactions on Arc testnet (chain 5042002), 31 October 2026, with throwaway keys and free test USDC. Nothing was sent on Arc mainnet, Base mainnet or Base Sepolia; Base was only read.

**Result: yes, every step worked, with no change to the contracts.** Router 3 settles on Arc's USDC, from a plain key and from a smart account. Our paymaster deploys accounts and pays their gas. ERC-8004 registration and spend permissions work. The one thing that needs a decision is money: at the 0.05 USDC minimum price, the 0.005 fee barely covers gas, and sometimes doesn't.

To repeat it: `ARC_TESTNET_KEYS_DIR=<folder outside the repo> npx tsx scripts/arc/deploy-testnet.ts`, then `npx tsx scripts/arc/testnet-e2e.ts <step>`. Both refuse any chain but 5042002, read from the node.

## What we deployed

| What | Address | Deploy tx | Gas | Cost (USDC) |
|---|---|---|---|---|
| CentralCityFeeRouter3 | `0x633798344cb67ac45688c5bf50572832b3964900` | `0xa89a644e64ff443a1d56ff1a9b53d8755384f3056a72405636b8658e4274964e` | 811,343 | 0.0203 |
| VerifyingPaymaster | `0x96165d05a3a9c8fc56c08e21fb3f56d98709b4db` | `0xfff91b260bcb60dc1a18cf2f36d94b01f832613c895e68c7d7fd08e4ae6ddaf1` | 1,913,743 | 0.0478 |

- **Router:** the kit's bytecode hash was checked before sending, and the masked runtime hash after. `token` is Arc USDC and `treasury` the throwaway address.
- **Paymaster:** Base's init code with only signer and owner replaced. The deployed runtime equals Base's paymaster byte for byte.
- **Setup:** allowlist `0xfe0fb9d4823c1a53d1c6d8b2a4b8debd279e44c880ed6ab7f5213a5f4ce2dde7` (47,778 gas), deposit of 2 USDC at the EntryPoint `0x6f2b735c74071d58349cb8fa219fe85fd3e1fa3d550ccacabff7d3e0c16fd108` (45,938 gas).

| Throwaway role | Address |
|---|---|
| Deployer | `0xc21e3d18daeC02DE980DE1F1D432CF7D6cEBD81B` |
| Paymaster owner | `0x5b7b6E1ec59c2095344389bA2BDbc32384d260dE` |
| Paymaster signer | `0xe4F621c3E05c1A28F71E73cB3C190A10B14c4c0C` |
| Bundler submitter | `0xcC7A8c03Ee2Af615bD492a71cf8DC9f7b1Eef068` |
| Treasury | `0x3234C6860B8E62fE4D867401f6c5C973ff47F1e1` |
| Smart account (spender, agent owner) | `0xFDCBa02E08Dd6CB1dF0181841064433800a1eCcA` |
| Agent wallet (owner key + SpendPermissionManager) | `0xdA3Ccf5B24c2D8B4B1cd5951f63690634b9cE2e7` |

**The paymaster's constructor order is entryPoint, signer, owner.** The last word of Base's deploy is the deployer, and the middle word is Base's `verifyingSigner()`. Read back on Arc: both roles are right.

## What we proved

### USDC and router 3

| Step | Tx | Gas | Result |
|---|---|---|---|
| EIP-3009, bytes overload, plain key | `0x73573653dfc710017cad48e7c95e07f87a75167527e2b704fe1085e7779921d6` | 92,047 | Works |
| EIP-3009, v r s overload | `0x9b6756e8496fa280bd41ce89b40e15ae65b8b51633535bb9ce5d19add32225d5` | 91,665 | Works |
| Router settle, plain key, repeat seller | `0x03cba182c34c1f21eb2cdc7a1276d748065e985f4a6e74613685cdad527ea292` | 176,056 | 45,000 to seller, 5,000 to treasury |
| Router settle, plain key, new seller | `0xd25b23a29e50ab6492ac0c4153d4988ce2ff3a7e6e63eda867e542729c4fb0fa` | 201,052 | Same split |
| Router settle, smart account (ERC-1271) | `0x881db38c1d936c14fd221beb6aec2505cd6d8b1c2c121c27a04afd7f35919766` | 197,818 | Same split |
| Our facilitator, smart account, new seller | `0xdf3cc877ad5f02b78a30cec3fdca53719a48d2b33496d6102b8eb84ef70ec111` | 222,818 | Reached `final` |
| Our facilitator, smart account, repeat seller | `0x731a86ecae2ebd395098dcc2bb7514f6e50c607b0f3c0f3e7fe3aba51223e786` | 197,818 | Reached `final` |
| settleBatch of 5, plain key | `0xa28da7094033141306311a16b7b4abe95dd4440fbbd77a7de7ca199052cb85e4` | 669,573 | 133,914 per settle |

- Arc's USDC reports name `USDC`, version `2`, 6 decimals. Its domain separator equals the one computed from our registry.
- A signature using Base's name `USD Coin` is refused: `FiatTokenV2: invalid signature`.
- The same settlement sent twice is refused with `AlreadyCharged` in simulation. The router's nonce matches our `router3Nonce`.
- The smart-account signatures came from the repo's `signTransferAuthorization`, and the facilitator rows from `createRouter3Facilitator` on PGlite.

### Account, registration, spending

All of these went through the repo's `prepareOperation` and `directBundler`, with its real policy and budget code on an in-memory PGlite. The keystore was replaced by a small wrapper around the test keys.

| Step | Tx | Tx gas | Paid from deposit (USDC) |
|---|---|---|---|
| New account + ERC-8004 register, one operation | `0x42fe2a0361740edfacd8f1d232f161ab783fdd8c1a4f023fc51b8630e0ca979c` | 459,002 | 0.011882 |
| Second register, account exists | `0x27cf2323f03a687b5fb7020fede08ce73c4da8d7526e1a4d21247b5d6bb16e18` | 256,636 | 0.006769 |
| First spend: approve (deploys the wallet by ERC-6492), spend, forward to seller | `0x2b49a236e171bd2a0647e9dcb4e41adcd5a08f4bac36c5285837820c41109401` | 524,145 | 0.014412 |
| Second spend | `0x1d697fad9bb9c68016b10cf20e1c33d15dcd1facdf639ec22265ece301e444c3` | 206,932 | 0.006178 |

- The account deploys and registers in one operation because our policy has no deploy-only flow. That is the production path, so steps b and c are proven together. Agent id 897710 is owned by the account, and the account paid nothing.
- After the first spend: the permission is approved, `getCurrentPeriod` shows 100,000 spent, the wallet is 100,000 lower and the seller 100,000 higher.
- A spend over the allowance is refused in simulation, before anything is sponsored: `the operation reverts in simulation`.
- The reservation for a further register settled on the first upkeep run at its actual cost: 0.006769 USDC against a worst case of 0.057799.

### spendWithWithdraw with the empty MagicSpend

**It is a no-op, not a revert.** Tx `0x7d1535cf630e0a873247519ca0645f6db3c0ebb62c05d3daf4f186acbf5f418c`, 117,842 gas, status success.

The manager's `MAGIC_SPEND` is `0x011A61C07DbF256A68256B1cB51A5e246730aB92`, which has no code on Arc. The wallet's call to it succeeds and does nothing, then the normal spend runs: the wallet lost 10,000 and the spender received 10,000 (its balance shows +7,054 because it paid 2,946 in gas from the same balance). Nothing here withdraws funds, and the spend stays inside the permission, so this is harmless. Our code doesn't call this function.

## Real cost per settle against the fee

The fee at the 0.05 USDC minimum price is 0.005 USDC. Base fee was 20 gwei throughout, so the price paid is 20 gwei plus the tip. The node's suggested tip moved between 0.5 and 5 gwei during this one session, and our code pays that suggestion.

| Settle | Gas | At 20.5 gwei (tip 0.5) | At 25 gwei (tip 5) | At 30 gwei (tip 10, our cap) |
|---|---|---|---|---|
| Batch of 5, plain key, per settle | 133,914 | 0.00275 | 0.00335 | 0.00402 |
| Plain key, repeat seller | 176,056 | 0.00361 | 0.00440 | 0.00528 |
| **Smart account, repeat seller** | 197,818 | 0.00406 | 0.00495 | **0.00593** |
| **Smart account, new seller** | 222,818 | 0.00457 | **0.00557** | **0.00668** |

Bold is more than the fee. Measured: the two smart-account rows at 20.5 gwei (`0x85a6b28adf6a24dc072b7703ed77e426521fa96e21df320607083c70fdb9832a`, `0x47ee8395a56106ffaf2939908568e39cc99613db03a398d91aa7e58b1d81b272`), and all rows at 25 gwei. The 20.5 gwei rows for the other two and the whole 30 gwei column are calculated from measured gas.

Production buyers are smart accounts, so the two bold rows are the ones that count. A 0.05 USDC sale keeps at most about 0.0009 of its fee, and loses money on a seller's first sale at a 5 gwei tip or on any sale at a 10 gwei tip.

A lower tip would fix most of it. Transactions with a tip of 0 and of 1 gwei were included (`0x411f3e20cc49870a7477f699585d66b8a3ce1da3549af1ae77fcfbbd790bb527`, `0xe7e6ddda2e1a692006e2c5bbfc957e32eaaf2a9622422a6305cb01eec4b83f67`). That is two simple transfers on a quiet testnet, which says nothing about a busy mainnet. How fast they landed was not measured properly, because the receipt polling was coarser than the blocks.

## Where Arc behaves differently

| Topic | What we saw | Effect on our code |
|---|---|---|
| Fee floor | Under 20 gwei the node returns a hash and no error, no receipt in 45 s. **It is not gone:** the node still knew the transaction, and a 20 gwei transaction at the same nonce was refused as `replacement transaction underpriced`. A 25 gwei one replaced it. Exactly 20 gwei with no tip is included. | Our floor check already prevents this. A manual send under the floor blocks that nonce until replaced at a higher fee. |
| Same-timestamp blocks | About half of neighbouring blocks share a timestamp (19 and 20 of 39 pairs), never more than 1 s apart. | Order by block number, as the strategy says. |
| Finality tag | `finalized` and `safe` both answer and sit at or within a block of `latest`. | Facilitator rows reached `final` about 1.3 s after sending. |
| Fee history | Base fee constant at 20 gwei, blocks under 12% full. Tips paid by others ranged from 0.5 to 80 gwei, and the node's suggestion moves with them. | The suggestion drives our cost (above). Our 10 gwei cap held. |
| Gas estimates | `estimateGas` works, including from the EntryPoint as the sender. Settles used about 1.4% less than estimated. | None. |
| L1 fee | No code at the OP-stack oracle, and receipts have no `l1Fee` field. | `l1FeeOracle: false` is right. |
| Clock | Block time was within 1 s of ours. | Sponsorship windows worked. |
| Gas and USDC | One balance, as documented. A wallet's spend and its gas draw on the same money. | A spender's balance change mixes the two, so read logs, not balance differences. |

`preVerificationGas` overpays slightly: the deposit was charged 3% to 19% more than the transaction's gas, and the submitter kept the difference (2 USDC funded, 2.0034 now). It is the safe direction, and the submitter's float doesn't drain.

## Arc values in chain-params.ts

| Value | Verdict |
|---|---|
| 186k gas, about 0.0046 USDC per settle | **Wrong for smart accounts:** 198k and 0.00495 at 25 gwei, 223k to a new seller. Comments and the test arithmetic now say so; no limit changed. |
| Settles per reserve (215, 21, 1075) | **Off by about 6%:** now 202, 20, 1010, in comments only. |
| Facilitator cap 100 gwei, gas limit 400k, tip cap 10 gwei | Room to spare, but see below on the tip cap. |
| Gas ceilings | Fine. Most used: call 749k of 1.5M, preVerification 96k of 200k. |
| `l1FeeOracle: false`, `usdcPerNative`, floor 20 gwei | Right. |
| `protectedWei` 10 USDC | **Correct by design, easy to trip:** with a 2 USDC deposit every ordinary flow is refused with `protected_reserve`. The first mainnet deposit must be well above 10 USDC. The test scripts lower this limit to 0.1 USDC; nothing else was changed. |
| Tip cap 10 gwei | **Not wrong, but costs more than the fee at the minimum price** (table above). Left as it is: a decision about money. |
| Settlement gas alert at 50% of fee | **Wrong for Arc, changed:** every minimum-price settle raised an ALERT (81% to 111% of the fee). Arc's is now 100%, so it fires only when gas passes the fee. Base's stays 50%, with a test. |

## Not tested

- Stuck-transaction handling on Arc: replacement at +30% and cancellation, in the bundler and the facilitator. These need a transaction to stay unmined, which didn't happen.
- `submitOperation` and the operation store, the runtime wiring with `CITY_ARC=1`, `createDirectBundler` with provisioned keys, and the HTTP routes. The scripts call the layers underneath them.
- Other sponsored flows: ratings, withdrawals, cancels, revokes, and the facilitator's batch lane (the batch above was sent directly).
- Blocklisted addresses, and load: all of this was one transaction at a time on a quiet testnet.
- Arc mainnet. Its fees may behave differently, and its SpendPermissionManager isn't deployed yet.
