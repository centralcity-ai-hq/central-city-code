import { timeoutSignal } from '../shell/timeoutSignal';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { number } from '../verify/countLogClient';
import { basescanAddress, basescanTx } from '../verify/onBaseData';
import {
  agoText,
  loadServiceCalls,
  shortHex,
  utcTime,
  type ServiceCall,
  type ServiceCallsPage,
} from '../verify/serviceCallsData';
import { CodeBox, NumberCard, Panel, Pill, ProofCard, ProofLayout } from './proofParts';
import { receiptOutcome, type Outcome, type Receipt } from './proofModel';

/*
 * Proof page for "Paid service calls" (approved design, 24 Oct 2026). Every paid call settles in
 * USDC through one of three ownerless fee routers, one FeeCharged event per payment. On each
 * visit this browser fetches the receipts of the newest payments from a public Base node and
 * checks that each succeeded and carries a fee router's event; the pill reports only that.
 */

const BASE_RPC = 'https://mainnet.base.org';
const ROUTERS = [
  {
    name: 'Router 1',
    range: 'up to 0.10 USDC',
    address: '0xA5f89AE25c87C21a8E2B03aaBf398A880d9be81B',
  },
  {
    name: 'Router 2',
    range: 'up to 100 USDC',
    address: '0xb1945a2af160e84e34f7c0fb0e4dd94fd4c0af0d',
  },
  {
    name: 'Router 3',
    range: '0.05 to 100 USDC, x402',
    address: '0xe807a76385ec3d76d17ab955091c12329d0a1403',
  },
] as const;
const ROUTER_SET = new Set(ROUTERS.map((r) => r.address.toLowerCase()));
const SAMPLE = 5;
const REFRESH_MS = 10_000;

async function checkReceipt(call: ServiceCall, signal: AbortSignal): Promise<Outcome> {
  try {
    const response = await fetch(BASE_RPC, {
      signal: timeoutSignal(signal, 8_000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [call.tx_hash],
      }),
    });
    if (!response.ok) return 'none';
    const body = (await response.json()) as { result?: Receipt };
    return receiptOutcome(call, body.result, ROUTER_SET);
  } catch {
    return 'none';
  }
}

type Sample = Record<Outcome, number> & { total: number; at: number; newest: string | null };

export function ProofCalls() {
  const [page, setPage] = useState<ServiceCallsPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sampled = useRef(false);
  const reading = useRef(false);
  const live = useRef(true);
  const aborts = useRef(new AbortController());

  // One read at a time: a slow answer is never overtaken by the next refresh. The receipt sample
  // is taken once, from the payments shown at that moment, and says which ones and when.
  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const next = await loadServiceCalls();
      if (!live.current) return;
      setPage(next);
      setFailed(false);
      if (!sampled.current) {
        sampled.current = true;
        const picks = next.items.slice(0, SAMPLE);
        setSample({
          total: picks.length,
          pass: 0,
          fail: 0,
          none: 0,
          at: Date.now(),
          newest: picks[0]?.tx_hash ?? null,
        });
        void (async () => {
          for (const call of picks) {
            if (!live.current) return;
            const o = await checkReceipt(call, aborts.current.signal);
            if (!live.current) return;
            setSample((s) => (s ? { ...s, [o]: s[o] + 1 } : s));
          }
        })();
      }
    } catch {
      if (live.current) setFailed(true);
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    live.current = true;
    aborts.current = new AbortController();
    let first = true;
    const tick = () => {
      if (!first && document.visibilityState === 'hidden') return;
      first = false;
      setNow(Date.now());
      void read();
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_MS);
    return () => {
      live.current = false;
      aborts.current.abort();
      window.clearInterval(timer);
    };
  }, [read]);

  const done = sample ? sample.pass + sample.fail + sample.none : 0;
  const status =
    !sample && failed ? (
      <Pill tone="muted">Payments did not load, nothing checked</Pill>
    ) : sample && sample.total === 0 ? (
      <Pill tone="muted">No payments to sample yet</Pill>
    ) : !sample || done < sample.total ? (
      <Pill tone="muted">Checking the newest on Base…</Pill>
    ) : sample.fail > 0 ? (
      <Pill tone="bad">{`${sample.fail} of ${sample.total} not confirmed`}</Pill>
    ) : sample.none > 0 ? (
      <Pill tone="muted">{`${sample.pass} of ${sample.total} checked, no answer for ${sample.none}`}</Pill>
    ) : (
      <Pill tone="ok">{`${sample.total} of ${sample.total} receipts match`}</Pill>
    );

  const items = page?.items ?? [];
  const usdc = (raw: string | null | undefined) =>
    raw == null
      ? null
      : `${(Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`;

  return (
    <ProofLayout
      crumb="Paid service calls"
      title="Paid service calls"
      lede="Every paid call settles in USDC through one of three open-source, ownerless fee routers on Base. Each payment emits exactly one FeeCharged event, so the count is the number of those events."
    >
      <div className="xp-two">
        <NumberCard
          label="Paid service calls on Base mainnet"
          value={page?.total != null ? number.format(page.total) : null}
          facts={[
            ['Last minute', page?.perMinute != null ? number.format(page.perMinute) : null],
            ['Last 24 h', page?.last24h != null ? number.format(page.last24h) : null],
            ['Settled 24 h', usdc(page?.value24hRaw)],
          ]}
        />
        <ProofCard
          status={status}
          rows={[
            ...ROUTERS.map(
              (r) =>
                [
                  r.name,
                  <a key={r.address} href={basescanAddress(r.address)}>
                    {shortHex(r.address, 8, 6)}
                  </a>,
                ] as [string, ReactNode],
            ),
            ['Counts', 'one FeeCharged event per payment'],
            [
              'Checked here',
              sample
                ? sample.total === 0
                  ? 'no payments to sample yet'
                  : `${sample.pass} of the ${sample.total} payments newest at ${utcTime(sample.at)}: receipt succeeded, with the router's FeeCharged event for the same payer, payee and payment ref`
                : '–',
            ],
          ]}
        />
      </div>

      <Panel
        title="Payments"
        note={
          failed && page
            ? 'not refreshed, showing the last answer'
            : page
              ? `live · ${agoText(Math.max(0, now - Date.parse(page.as_of)))}`
              : undefined
        }
      >
        <div className="xp-table-wrap">
          <table className="xp-table">
            <thead>
              <tr>
                <th>Transaction</th>
                <th>Service</th>
                <th className="xp-num">Paid</th>
                <th className="xp-num">To seller</th>
                <th className="xp-num">Fee</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {items.map((call) => (
                <tr key={`${call.tx_hash}-${call.ref}`}>
                  <td className="xp-mono">
                    <a href={basescanTx(call.tx_hash)}>{shortHex(call.tx_hash, 10, 4)}</a>
                  </td>
                  <td
                    style={{
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {call.service}
                  </td>
                  <td className="xp-num" style={{ fontWeight: 600 }}>
                    {call.amount}
                  </td>
                  <td className="xp-num">{call.provider_amount}</td>
                  <td className="xp-num" style={{ color: 'var(--xp-muted)' }}>
                    {call.fee?.amount ?? '–'}
                  </td>
                  <td style={{ color: 'var(--xp-muted)' }}>
                    {agoText(Math.max(0, now - call.time))}
                  </td>
                </tr>
              ))}
              {!items.length ? (
                <tr>
                  <td colSpan={6} className="xp-empty">
                    {failed ? 'Payments did not load. Retrying every 10 s.' : 'Loading…'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="xp-panel-foot">
          <a href="/explorer/calls">Search all payments</a>
        </div>
      </Panel>

      <CodeBox
        title="Check without this website"
        text={`# every payment through router 3 emits one FeeCharged event
cast logs --address ${ROUTERS[2].address} \\
  "FeeCharged(address indexed payer, address indexed payee, bytes32 indexed ref, uint8 kind, uint256 gross, uint256 fee)" --from-block <deploy block> --rpc-url https://mainnet.base.org`}
      >
        <p>
          Count the events of all three routers from their deploy blocks. The public DefiLlama
          adapter counts the same events.
        </p>
      </CodeBox>
    </ProofLayout>
  );
}
