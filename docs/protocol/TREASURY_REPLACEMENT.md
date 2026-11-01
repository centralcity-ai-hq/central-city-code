# Replacing the fee treasury (contingency design)

**Status: contingency design only. This is not an owner action and not an approved procedure.**
Under the current owner mandate, deploying new contracts and changing any protocol address
(router, treasury or deploy block) are prohibited. Nothing below may be carried out unless the
owner first lifts that prohibition with a new, explicit decision; the design would then need its
own review before any step is taken. Audit finding CCA-124 (no tested way to replace the
treasury) stays open: this document describes a design, it has not been rehearsed, and it does
not fix the finding.

The three fee routers (`CentralCityFeeRouter`, `CentralCityFeeRouter2`, `CentralCityFeeRouter3`)
are immutable and ownerless. Each one fixes its token (Base USDC) and its treasury when it is
deployed, and all three pay the same treasury. Nothing in a router can change the fee receiver:
replacing the treasury would mean three new routers and a reviewed switch of every place that
names the old ones. This document records what that switch would involve. See
[FEES.md](FEES.md), "What the routers trust".

## When it would apply

- The treasury key is lost or may be exposed: fees keep arriving at an address nobody (or the
  wrong party) controls.
- USDC blocks the treasury: every router payment reverts.
- A planned move to another treasury account.

## 1. Stopping new fee payments

This part uses existing switches only and needs no new contract. When the key is lost, exposed
or blocked, the first measure is the emergency off for Production, `CITY_PROTOCOL_FEES=0`
([LIVE.md](LIVE.md)): new Feed pay calls take no fee and the ledger scan and public metrics
pause. `CITY_PROTOCOL_FEE_ROUTER2_ENABLED` and `CITY_PROTOCOL_FEE_ROUTER3_ENABLED` set to
anything but `1` route no new payment to router 2 or 3. Calls already quoted keep the route they
pinned and finish or expire.

## 2. The new treasury

A new treasury account would be the one input of the switch. Its key must be held by the owner
and never on a server.

## 3. New routers (design only; prohibited under the current mandate)

The deploy kit (`contracts/deploy-kit/deploy.html`) deploys from the treasury account itself
and, for routers 2 and 3, requires router 1's treasury (`ROUTER1_TREASURY` in the page). A
replacement would need:

- a reviewed change of `ROUTER1_TREASURY` in `deploy.html` to the new treasury (the kits'
  bytecode does not change, as the treasury is a constructor argument, so the approved hashes
  and `tests/deploy-kit.test.ts` stay the same);
- router 1, then `deploy.html?router=2` and `deploy.html?router=3`, each read back from the
  public Base endpoint (runtime code equal to the kit's with USDC and the new treasury as its
  immutables, getters matching);
- each router's address, deploy transaction and deploy block on record, and its source verified
  on Basescan;
- the fork checks against the new addresses: `scripts/protocol/fee-router-check.ts`,
  `scripts/protocol/router-fork-check.ts` and `scripts/protocol/router3-fork-check.ts`.

## 4. What the application switch would change

- `shared/protocol.ts` `PROTOCOL_BASE_MAINNET`: `treasury`, `feeRouter`, `feeRouterDeployBlock`,
  `feeRouter2`, `feeRouter2DeployBlock`, `feeRouter3`, `feeRouter3DeployBlock`. The reserved
  payees (`protocolReservedPayees`) are derived from these, so new routers and a new treasury
  would be refused as payees too; the old routers and the old treasury would stay reserved.
- The old routers would stay readable: the ledger and the public totals count fees from each
  router's deploy block onwards, so the old routers' history would remain a scan source (from
  their own deploy blocks to their last fee) or the totals would drop. Today the deployment lists
  one address per router; adding the old ones as historical sources would be part of the change.
- Test networks: `CITY_PROTOCOL_TREASURY`, `CITY_PROTOCOL_ROUTER`, `CITY_PROTOCOL_START_BLOCK`,
  `CITY_PROTOCOL_FEE_ROUTER2`, `CITY_PROTOCOL_FEE_ROUTER2_FROM_BLOCK`, `CITY_PROTOCOL_FEE_ROUTER3`
  and `CITY_PROTOCOL_FEE_ROUTER3_FROM_BLOCK`.
- Documents with the deployed addresses: [CANARY.md](CANARY.md), [FEE_ROUTER_2.md](FEE_ROUTER_2.md),
  [FEE_ROUTER_3.md](FEE_ROUTER_3.md), [FEES.md](FEES.md) and
  [DEFILLAMA_ADAPTER.md](DEFILLAMA_ADAPTER.md).

## 5. Fees back on and indexers

After a live switch, fees and the router 2 and 3 switches would go back on, one small
fee-included payment would be checked end to end (the new router's `FeeCharged` event and the
matching USDC transfer to the new treasury in the same transaction), and the DefiLlama adapter
would be updated with the new routers and their start blocks, keeping the old routers for
history.

## What would not change

- The exact-transfer proof: the ledger counts a fee only with the matching USDC transfer to the
  treasury in the same transaction.
- The kits' bytecode and approved hashes.
- The routers' trust in USDC (pause, blocklist, upgrade, and router 3's signed transfers).
