/*
 * Independent coverage of Central City, shown on /news (src/trust/NewsRoom.tsx). Every piece we
 * know of is listed, whether neutral, positive or critical. The page sorts by date, newest first.
 */

export type CoverageItem = {
  publisher: string;
  /** Publication date, YYYY-MM-DD, or YYYY-MM when only the month is known. */
  date: string;
  title: string;
  url: string;
  /** What kind of piece it is, e.g. "Research" or "News analysis". */
  type: string;
  /** BCP 47 code when the piece is not in English (e.g. "ko"). */
  language?: string;
  /** One neutral sentence on what the piece covers. */
  note: string;
};

export const COVERAGE: readonly CoverageItem[] = [
  {
    publisher: 'ChainWard',
    date: '2026-10-31',
    title:
      'x402 Volume on Base, October 2026: 95% of DefiLlama’s Surge Is One Facilitator’s Own Settlement, Disclosed Before It Happened',
    url: 'https://chainward.ai/decodes/x402-one-platforms-own-volume',
    type: 'News analysis',
    note: 'Examines how much of Base x402 volume came from Central City’s own settlement, and how it was disclosed.',
  },
  {
    publisher: 'Stablecoin Insider',
    date: '2026-10-24',
    title: 'ERC-8004: Agent IDs for Stablecoin Payments, Explained',
    url: 'https://stablecoininsider.org/erc-8004/',
    type: 'Explainer',
    note: 'Explains ERC-8004 agent IDs and Central City’s share of registrations on Base.',
  },
  {
    publisher: 'Hana Securities',
    date: '2026-10-26',
    title: '가격이 오르고 보면 늦다 (디지털자산 Weekly 온체인 I 2026.10.26)',
    url: 'https://file.hanaw.com/download/research/FileServer/WEB/strategy/digital_asset/2026/10/25/Onchain_20261026.pdf',
    type: 'Institutional report',
    language: 'ko',
    note: 'Weekly on-chain review naming Central City in ERC-8004 adoption on Base, separating registrations from payments.',
  },
  {
    publisher: 'Hana Securities',
    date: '2026-10-19',
    title: 'AI 에이전트 채택, 토큰화 주식 성장 지속 (디지털자산 Weekly 온체인 I 2026.10.19)',
    url: 'https://file.hanaw.com/download/research/FileServer/WEB/strategy/digital_asset/2026/10/18/Onchain_20261019.pdf',
    type: 'Institutional report',
    language: 'ko',
    note: 'Weekly on-chain review covering AI agent adoption, including Central City’s Base identities.',
  },
  {
    publisher: 'Agentic Finance Graph',
    date: '2026-11-01',
    title: 'State of Agent Money · October 2026',
    url: 'https://agenticfinancegraph.com/state-of-agent-money-2026-10',
    type: 'Research',
    note: 'Monthly report on agent payments on Base, including a correction that added previously missed paying wallets.',
  },
  {
    publisher: 'Agentic Finance Graph',
    date: '2026-10-24',
    title: 'Where the ERC-8004 registrations live, chain by chain',
    url: 'https://agenticfinancegraph.com/where-erc-8004-registrations-live-chain-by-chain',
    type: 'Research',
    note: 'Counts ERC-8004 registrations across 40 chains; finds centralcity.ai the most common metadata host on Base.',
  },
  {
    publisher: 'Agentic Finance Graph (DEV Community)',
    date: '2026-10-20',
    title:
      '208,589 new AI agents on Base in one week: where the money went, and two things we were counting wrong',
    url: 'https://dev.to/agenticfinancegraph/208589-new-ai-agents-on-base-in-one-week-where-the-money-went-and-two-things-we-were-counting-h0p',
    type: 'Research',
    note: 'Analyses Central City’s registration growth and payment activity, and corrects its own counting.',
  },
  {
    publisher: 'Agentic Finance Graph (DEV Community)',
    date: '2026-10-20',
    title:
      '44,364 AI-agent ratings on Base, none after a payment from the rater: what real chain data adds to the review standards',
    url: 'https://dev.to/agenticfinancegraph/44364-ai-agent-ratings-on-base-none-after-a-payment-from-the-rater-what-real-chain-data-adds-to-5a9m',
    type: 'Research',
    note: 'Examines whether agent ratings on Base followed payments, using Central City’s agent wallet structure.',
  },
  {
    publisher: 'Sato Hub',
    date: '2026-10-26',
    title: 'State of Onchain Agents 2026',
    url: 'https://satohub.ai/state-of-onchain-agents',
    type: 'Research',
    note: 'Independent report on onchain agents; identifies Central City as the top registering platform in its sample.',
  },
  {
    publisher: 'Agentic Rails Atlas (merces.ai)',
    date: '2026-10-18',
    title:
      'ERC-8004 Trustless Agents explained: on-chain agent identity, reputation and validation',
    url: 'https://atlas.merces.ai/p/erc-8004/',
    type: 'Technical analysis',
    note: 'Technical reference on ERC-8004 with an on-chain sample of registrations pointing to centralcity.ai.',
  },
];
