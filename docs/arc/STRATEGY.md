# Adding Arc next to Base: strategy

Working paper, written and changed by both leads as we go. Facts dated 31 Oct 2026, read from Arc mainnet over RPC and from docs.arc.io unless marked otherwise.

## Goal

Central City works on Base today. It should also work on Arc, Circle's USDC-native Layer 1, with the same setup: fee router, facilitator, paymaster, smart accounts. An agent chooses Base or Arc. The Agent Explorer gets "On Arc" as its own explorer next to "On Base". When everything works, the landing page says "Central City ERC-8004 Agents".

**Rule one: Base doesn't change.** Arc is additive and off unless `CITY_ARC=1`. Every step must leave Base's behaviour identical, proven by the existing suites.

**Not in this operation:** payments across chains, or a liquidity pool for them. A Base agent can't buy from an Arc agent yet, and the Feed says so plainly.

## Decisions

| Decision | Choice |
|---|---|
| Accounts on Arc | Same as Base: a smart account per agent; our paymaster pays gas, owners need no USDC for gas |
| Chain per agent | One, Base or Arc, no dual identity for now |
| Fee | Same as Base: 10%, 0.05 USDC minimum |
| Treasury | Same address as Base |
| Explorer | Two explorers: `/explorer/base` unchanged, `/explorer/arc` new |
| Analytics | Switch All, Base, Arc, opening on All |
| Launch path | Local tests, then Arc testnet with a throwaway key, then mainnet |
| Fleets | Small first (about 100 agents, low prices), larger on the owner's word |
| Funding and mainnet deploys | The owner, at the end; we prepare addresses and exact amounts |
| Code layout | Generalise in place under `server/base/`; rename later if at all |

## What Arc has

| Item | Mainnet (5042) | Testnet (5042002) |
|---|---|---|
| ERC-8004 Identity, Reputation | Yes, same addresses as Base | Yes, same as Base Sepolia |
| EntryPoint v0.6, v0.7 | Yes | Yes |
| Coinbase Smart Wallet factory | Yes, same code as Base | Yes, replayed at the same address |
| SpendPermissionManager | **No**, replayable at Base's address | Yes, replayed at Base's address |
| Sanctions oracle | **No** | **No** |
| Multicall3, CREATE2 factory | Yes | Docs list them |
| USDC | `0x3600...0000`, signing name `USDC` version 2 | Same |
| Bundler on the public RPC | No | To check |

## Where Arc differs, and what we do

| Difference | Risk | What we do |
|---|---|---|
| Gas is USDC: native 18 decimals, ERC-20 6, one balance | A 10^12 error; every "ETH" check is wrong | A per-chain gas asset in the registry; floors and alarms in that asset |
| Signing name `USDC`, Base mainnet `USD Coin` | Signatures fail | Domain per chain, never a constant |
| maxFee under 20 gwei is dropped with no error | A send waits forever | A per-chain fee floor |
| Final at inclusion, blocks can share a timestamp | Base's waits are pointless; ordering by time is wrong | Per-chain finality; order by block number |
| No sanctions oracle | Screening silently off | Read the Base oracle; refuse if it can't answer |
| Blocklisted addresses revert and still cost gas | Gas lost | Screening before sending; watch revert rates |
| Settle costs about 0.0046 USDC at the 0.05 floor, fee 0.005 | Nearly no margin at the floor | Watch per-call cost; price floor stays an open question |

## Work

**Chain core:** chain registry; `chain_id` CHECK migrations; identity and registration on Arc; wallets and spending limits; router, facilitator, paymaster and bundler per chain; gas asset everywhere; deploy kit.

**Product and data:** Explorer "On Arc"; ledger, indexers and stats per chain; Analytics switch; chain choice in the console; mockups; docs; test fleet; landing page last.

## Stages

1. Registry and migrations, no behaviour change.
2. Server paths take a chain instead of assuming Base; Base identical.
3. Arc on a local test setup with fakes.
4. Testnet: deploy our contracts with a throwaway key; end-to-end: register, pay, settle, see it in the Explorer.
5. Deploy list for the owner: exact contracts, order, addresses, amounts.
6. Mainnet with a small fleet, watched.
7. Landing page.

## What only the owner does

Deploy on mainnet: fee router 3 (routers 1 and 2 only if we decide they're needed), two replayed transactions for PublicERC6492Validator and SpendPermissionManager (about 3M gas in all), paymaster. Fund the facilitator, paymaster deposit and fleets in USDC. Set the production settings.

## Open

- A real wallet deploy and spend through the replayed contracts on testnet.
- A bundler on Arc: our own direct bundler is the assumption.
- Whether a local fork tool is available, or testnet takes that role.
