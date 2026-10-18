import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEED_CLIENT_PATHS,
  FEED_FLAG,
  FEED_SOURCE,
  feedRiskOf,
  rawToUsdc,
  readFeedServiceId,
  readFeedServiceQuery,
  usdcToRaw,
  type FeedSourceRef,
  type ServiceSearchToolService,
} from '../shared/feed.js';

test('feed flag name is CITY_FEED', () => {
  assert.equal(FEED_FLAG, 'CITY_FEED');
});

test('every service record credits its source in words, as the cards do', () => {
  assert.equal(FEED_SOURCE.credit, 'Listed by x402 Bazaar');
  assert.ok(FEED_SOURCE.credit.endsWith(FEED_SOURCE.name));
  const source: FeedSourceRef = {
    name: FEED_SOURCE.name,
    credit: FEED_SOURCE.credit,
    url: FEED_SOURCE.url,
    recordId: 'https://lookup.example.com/v1/whois',
    fetchedAt: 1,
    updatedAt: null,
  };
  assert.equal(source.credit, 'Listed by x402 Bazaar');
  // The credit is part of the record's contract: a record without it does not compile.
  // @ts-expect-error credit is required
  const uncredited: FeedSourceRef = { ...source, credit: undefined };
  assert.equal(uncredited.credit, undefined);
  const toolSource: ServiceSearchToolService['source'] = {
    name: FEED_SOURCE.name,
    credit: FEED_SOURCE.credit,
    url: FEED_SOURCE.url,
    record_id: source.recordId,
    fetched_at: new Date(1).toISOString(),
  };
  assert.equal(toolSource.credit, FEED_SOURCE.credit);
});

test('a service id reads from the id itself or from a Feed link to it on any origin', () => {
  const id = 'svc_abcdefghijklmnopqrst';
  assert.equal(FEED_CLIENT_PATHS.service, '/feed/services/:id');
  for (const text of [
    id,
    `  ${id}\n`,
    `https://centralcity.ai/feed/services/${id}`,
    `https://centralcity.ai/feed/services/${id}/`,
    `https://centralcity.ai/feed/services/${id}?from=search#price`,
    `https://preview.example.app/feed/services/${id}`,
    `http://localhost:5173/feed/services/${id}`,
  ])
    assert.equal(readFeedServiceId(text), id, text);
  for (const text of [
    '',
    'svc_',
    'svc_abcdefghijklmnopqrs1',
    id.toUpperCase(),
    `${id}x`,
    `centralcity.ai/feed/services/${id}`,
    `https://centralcity.ai/feed/services/${id}/manage`,
    `https://centralcity.ai/feed/services/${id}x`,
    `https://centralcity.ai/feed/requests/${id}`,
    `https://centralcity.ai/api/public/feed/services/${id}`,
    `https://centralcity.ai/x/feed/services/${id}`,
    `https://centralcity.ai/?next=/feed/services/${id}`,
    `ftp://centralcity.ai/feed/services/${id}`,
    `javascript:alert(1)//feed/services/${id}`,
  ])
    assert.equal(readFeedServiceId(text), null, text);
});

test('USDC amounts convert exactly in both directions', () => {
  assert.equal(usdcToRaw('0.01'), '10000');
  assert.equal(usdcToRaw('2.5'), '2500000');
  assert.equal(usdcToRaw('1000'), '1000000000');
  assert.equal(rawToUsdc('10000'), '0.01');
  assert.equal(rawToUsdc('2500000'), '2.5');
  assert.equal(rawToUsdc('1000000000'), '1000');
  assert.equal(usdcToRaw('abc'), null);
  assert.equal(usdcToRaw('-1'), null);
  assert.equal(usdcToRaw('0.0000001'), null);
});

test('risky money listings are caught, data about them is not', () => {
  assert.equal(feedRiskOf('Buy tokenized gold (PAXG) instantly'), 'precious_metals');
  assert.equal(feedRiskOf('Order a prepaid card for USDC'), 'prepaid_cards');
  assert.equal(feedRiskOf('Send money to any Venmo user'), 'money_transfer');
  assert.equal(feedRiskOf('Deposit into our yield vault, 12% APY'), 'yield_investment');
  assert.equal(feedRiskOf('Live gold price feed (XAU/USD)'), null);
  assert.equal(feedRiskOf('Historical APY data for Aave markets'), null);
  assert.equal(feedRiskOf('Extract text from a PDF'), null);
  // Missed on real Bazaar data (preview check, 13 Oct): a yield vault behind more words, a
  // reloadable card, a bank payout by ACH.
  assert.equal(
    feedRiskOf(
      'Deposit into the Ink Balanced Yield USDC vault ($0.01 fee on top of the deposit amount).',
    ),
    'yield_investment',
  );
  assert.equal(
    feedRiskOf('Withdraw from the Ink Balanced Yield USDC vault (flat $0.01 gas fee).'),
    'yield_investment',
  );
  assert.equal(feedRiskOf('Load a reloadable card balance with USDC.'), 'prepaid_cards');
  assert.equal(feedRiskOf('Top up your card balance with USDC on Base'), 'prepaid_cards');
  assert.equal(
    feedRiskOf(
      'Send dollars to a bank account by ACH. Requires a bank destination registered beforehand.',
    ),
    'money_transfer',
  );
  assert.equal(feedRiskOf('Payouts to any bank account in 40 countries'), 'money_transfer');
  // Data about the same things stays listed.
  for (const data of [
    'vaults.fyi retrieves a filtered list of vaults with their balances and APY',
    'DeFi yield farming markets with live APYs across Aave V3 and Morpho on Base',
    'List deposit addresses and history for a wallet',
    'ERC20 Transfer logs via eth_getLogs - raw Transfer events for a token or wallet',
    'Send email with provisioned domain',
    'SendCheck: pre-send verification of any EVM address (balances, contract or wallet)',
    'Telegram advertising data: available ad networks and their minimum deposits',
    'Validate an IBAN and return the bank name',
    'IBAN verification and bank validation for SEPA payments: verify a supplier before payment',
    'Is this address safe to send funds to on Base? Checks scam blacklists',
    'Screen a wallet address before you pay or send funds to it: OFAC sanctions',
    'Render a product card component from JSON',
  ])
    assert.equal(feedRiskOf(data), null, data);
});

test('a service query never drops an unreadable price filter silently', () => {
  assert.equal(readFeedServiceQuery({ max_price: 'cheap' }), null);
  const q = readFeedServiceQuery({ q: '  pdf   extract ', max_price: '0.05' });
  assert.ok(q);
  assert.equal(q.q, 'pdf extract');
  assert.equal(q.maxPrice, '50000');
  assert.equal(q.sort, 'relevance');
  assert.equal(readFeedServiceQuery({})?.sort, 'most_used');
  // Control characters are spaces (the database refuses a NUL in text).
  assert.equal(readFeedServiceQuery({ q: 'pdf\u0000extract\u0007' })?.q, 'pdf extract');
  assert.equal(readFeedServiceQuery({ q: '\u0000' })?.q, '');
});
