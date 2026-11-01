import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { number } from '../verify/countLogClient';
import {
  basescanRegistry,
  basescanToken,
  basescanTx,
  loadOnBase,
  passportPath,
  shownName,
  verifyOnBase,
  type OnBaseList,
  type OnBaseRow,
} from '../verify/onBaseData';
import { OnBaseVerifyPanel, type VerifyState } from '../verify/OnBaseVerifyPanel';
import { agoText, shortHex } from '../verify/serviceCallsData';
import { readListWithRetry } from './listRead';
import { CodeBox, NumberCard, Panel, Pill, ProofCard, ProofLayout } from './proofParts';
import { identityOutcome } from './proofModel';
import '../verify/on-base.css';

/*
 * Proof page for "On Base" (approved design, 24 Oct 2026). The number is Central City's count of
 * its agents in the ERC-8004 Identity Registry; on each visit this browser re-checks the newest
 * Base IDs on Base itself (owner, tokenURI, sender, final) and the pill reports exactly that
 * sample. Any Base ID can be checked in full below.
 */

const SAMPLE = 5;

export function ProofOnBase() {
  const [list, setList] = useState<OnBaseList | null>(null);
  const [failed, setFailed] = useState(false);
  const [sample, setSample] = useState<{
    total: number;
    pass: number;
    fail: number;
    none: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [one, setOne] = useState<
    { row: OnBaseRow; state: VerifyState } | 'invalid' | 'none' | 'unavailable' | 'reading' | null
  >(null);
  // Each search or check gets a number; an answer for an older number is dropped, so a slow
  // earlier answer never replaces a newer one.
  const attempt = useRef(0);

  useEffect(() => {
    let live = true;
    readListWithRetry(() => live)
      .then((page) => {
        if (!live) return;
        setList(page);
        const picks = page.rows.filter((r) => r.status === 'final').slice(0, SAMPLE);
        setSample({ total: picks.length, pass: 0, fail: 0, none: 0 });
        // One after another: a public Base node limits bursts, and a refused read is "no answer",
        // never a failed check.
        void (async () => {
          for (const row of picks) {
            const result = await verifyOnBase(row);
            if (!live) return;
            const o = identityOutcome(result);
            setSample((s) => (s ? { ...s, [o]: s[o] + 1 } : s));
          }
        })();
      })
      .catch(() => live && setFailed(true));
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const checkOne = useCallback((row: OnBaseRow) => {
    const mine = ++attempt.current;
    setOne({ row, state: { phase: 'checking' } });
    void verifyOnBase(row).then((result) => {
      if (attempt.current === mine) setOne({ row, state: { phase: 'done', result } });
    });
  }, []);

  const onCheck = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    const mine = ++attempt.current;
    if (!/^[0-9]{1,20}$/.test(q)) return setOne('invalid');
    setOne('reading');
    try {
      const page = await loadOnBase({ q, timeoutMs: 25_000 });
      if (attempt.current !== mine) return;
      const row = page.rows.find((r) => r.baseId === q);
      if (row) checkOne(row);
      else setOne('none');
    } catch {
      if (attempt.current === mine) setOne('unavailable');
    }
  };

  const totals = list?.totals;
  const done = sample ? sample.pass + sample.fail + sample.none : 0;
  const status = failed ? (
    <Pill tone="muted">Could not load</Pill>
  ) : !sample || done < sample.total ? (
    <Pill tone="muted">Checking the newest on Base…</Pill>
  ) : sample.fail > 0 ? (
    <Pill tone="bad">{`${sample.fail} of ${sample.total} not confirmed`}</Pill>
  ) : sample.none > 0 ? (
    <Pill tone="muted">{`${sample.pass} of ${sample.total} checked, no answer for ${sample.none}`}</Pill>
  ) : (
    <Pill tone="ok">{`Newest ${sample.total} checked on Base`}</Pill>
  );

  return (
    <ProofLayout
      crumb="On Base"
      title="On Base"
      lede="Each Central City agent on Base is a registration in the public ERC-8004 Identity Registry, sent from the agent's own account. Any Base ID below can be checked on Base in your browser."
    >
      <div className="xp-two">
        <NumberCard
          label="Agents on Base"
          value={totals ? number.format(totals.onBase) : null}
          facts={[
            ['New in 24 h', totals ? number.format(totals.new24h) : null],
            ['Finalizing', totals ? number.format(totals.finalizingNow) : null],
          ]}
        />
        <ProofCard
          status={status}
          rows={[
            [
              'Registry',
              list ? (
                <a href={basescanRegistry(list.registry)}>{shortHex(list.registry, 10, 6)}</a>
              ) : (
                '–'
              ),
            ],
            ['Counts', 'registrations pointing to a centralcity.ai passport'],
            ['Read at block', totals?.readAtBlock ? number.format(totals.readAtBlock) : '–'],
            ['Read', totals?.readAt ? `${agoText(Math.max(0, now - totals.readAt))}` : '–'],
            [
              'Checked here',
              sample
                ? `${sample.pass} of ${sample.total} newest pass all checks${
                    sample.none ? `, ${sample.none} without an answer from Base` : ''
                  }`
                : '–',
            ],
          ]}
          actions={list ? <a href={basescanRegistry(list.registry)}>Registry on Basescan</a> : null}
        />
      </div>

      <Panel title="Check one agent" note="every answer comes from Base, nothing from Central City">
        <form
          className="xp-search"
          style={{ padding: '18px 22px', marginTop: 0 }}
          onSubmit={onCheck}
        >
          <label htmlFor="xp-bid" className="visually-hidden">
            Base ID
          </label>
          <div className="xp-search-box" style={{ height: 48, flexBasis: 320 }}>
            <input
              id="xp-bid"
              inputMode="numeric"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Base ID"
              className="xp-mono"
            />
          </div>
          <button type="submit" className="xp-btn" style={{ height: 48 }}>
            Check on Base
          </button>
        </form>
        {one === 'invalid' ? (
          <div className="xp-empty">A Base ID is a whole number, like 426816.</div>
        ) : one === 'none' ? (
          <div className="xp-empty">No Central City agent has that Base ID.</div>
        ) : one === 'unavailable' ? (
          <div className="xp-empty" role="alert">
            The list did not answer, so this Base ID is not checked. Try again in a moment.
          </div>
        ) : one === 'reading' ? (
          <div className="xp-empty" role="status">
            Looking up the Base ID.
          </div>
        ) : one ? (
          <div style={{ padding: '0 22px 18px' }}>
            <OnBaseVerifyPanel
              row={one.row}
              state={one.state}
              onRetry={() => checkOne(one.row)}
              basescanHref={list ? basescanToken(list.registry, one.row.baseId) : '#'}
            />
          </div>
        ) : null}
      </Panel>

      <Panel title="Latest registrations" note="newest first">
        <div className="xp-table-wrap">
          <table className="xp-table">
            <thead>
              <tr>
                <th>Base ID</th>
                <th>Agent</th>
                <th>Registration</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list?.rows ?? []).slice(0, 15).map((row) => (
                <tr key={row.baseId}>
                  <td className="xp-mono">{row.baseId}</td>
                  <td>
                    <a className="xp-agent-name" href={passportPath(row.short)}>
                      {shownName(row.name)}
                    </a>
                  </td>
                  <td className="xp-mono">
                    {row.mintTx ? (
                      <a href={basescanTx(row.mintTx)}>{shortHex(row.mintTx, 10, 4)}</a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {row.status === 'final' ? (
                      <Pill tone="ok">Final</Pill>
                    ) : (
                      <Pill tone="wait">Finalizing</Pill>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="xp-verify-btn" onClick={() => checkOne(row)}>
                      Verify
                    </button>
                  </td>
                </tr>
              ))}
              {!list ? (
                <tr>
                  <td colSpan={5} className="xp-empty">
                    {failed ? 'Could not load. Try again in a moment.' : 'Loading…'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <CodeBox
        title="Check without this website"
        text={`# owner and passport of one Base ID, at the latest block
cast call ${list?.registry ?? '<registry>'} "ownerOf(uint256)(address)" <base id> --rpc-url https://mainnet.base.org
cast call ${list?.registry ?? '<registry>'} "tokenURI(uint256)(string)" <base id> --rpc-url https://mainnet.base.org`}
      >
        <p>
          Any Base node answers the same. A Central City agent's tokenURI is its passport address.
        </p>
      </CodeBox>
    </ProofLayout>
  );
}
