/*
 * The single source in code for Central City's own paymaster on Base mainnet (chain 8453): its
 * address, its verifying signer and its public deploy record. docs/base/OWN_PAYMASTER.md and
 * docs/base/OWN_PAYMASTER_OPS.md must name exactly these values (tests/own-paymaster-record.test.ts
 * checks it, without any network). The owner, its history, the deployer and the constructor
 * arguments are kept in the private operations repository, never in public code or documents.
 * The chain is the source of truth: when the signer changes on chain, change it here first, then
 * the documents, in the same commit.
 *
 * Every address is written in its EIP-55 checksum form.
 */

export const OWN_PAYMASTER_RECORD = {
  chainId: 8453,
  /** VerifyingPaymaster v1.0.0, unmodified; also pinned in shared/base/paymasters.ts. */
  address: '0x8Bf5b18b733a864c17Cd92615cD45D833Fcfe105',
  /** EntryPoint v0.6 (entryPoint()). */
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  /** verifyingSigner(), read on chain; unchanged since the deploy. */
  verifyingSigner: '0x5DF424aB1BD45ce2faCBbC002Aa53504CF5710A5',
  deploy: {
    tx: '0xc7ba196ddd47ac3d7e982ec1187c183e981513cf2e3f74d03134737f946fb96d',
    block: 53000665,
    /** Block timestamp, UTC. */
    at: '2026-10-23T21:24:37Z',
    upstream: {
      repository: 'https://github.com/coinbase/verifying-paymaster',
      tag: 'v1.0.0',
      commit: 'ca356bb0ff67',
    },
  },
} as const;
