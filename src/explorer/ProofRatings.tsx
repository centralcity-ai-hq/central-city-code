import { timeoutSignal } from '../shell/timeoutSignal';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BASE_MAINNET, BASE_NETWORKS } from '../../shared/base/chains';
import { number } from '../verify/countLogClient';
import {
  basescanAddress,
  loadPassport,
  passportPath,
  scoreClaim,
  shownName,
  verifyOnBase,
  type OnBaseList,
  type Passport,
} from '../verify/onBaseData';
import { OnBaseVerifyPanel, type VerifyState } from '../verify/OnBaseVerifyPanel';
import { shortHex, utcTime } from '../verify/serviceCallsData';
import { loadRatedIds, readListWithRetry } from './listRead';
import { CodeBox, NumberCard, Panel, Pill, ProofCard, ProofLayout } from './proofParts';
import { ratingOutcome } from './proofModel';
import '../verify/on-base.css';

/*
 * Proof page for "Rated agents" (approved design, 24 Oct 2026). A rating is a 1 to 5 star feedback
 * in the public ERC-8004 Reputation Registry. On each visit this browser takes the newest rated
 * agents of the list and recomputes each one's Central City score from the registry itself
 * (Verify with the score claim); the pill reports only that sample. Any agent can be checked below.
 */

const REPUTATION_REGISTRY = BASE_NETWORKS[BASE_MAINNET].contracts.reputationRegistry;
const SAMPLE = 3;
/** The passport read can take about 16 s today (X3 speeds it up); never wait longer than this. */
const PASSPORT_TIMEOUT_MS = 25_000;

const passportFor = (baseId: string, signal: AbortSignal) =>
  loadPassport(baseId, {
    signal: timeoutSignal(signal, PASSPORT_TIMEOUT_MS),
  });

export function ProofRatings() {
  const [list, setList] = useState<OnBaseList | null>(null);
  const [failed, setFailed] = useState(false);
  const [sampleFailed, setSampleFailed] = useState(false);
  const [sample, setSample] = useState<{
    total: number;
    pass: number;
    fail: number;
    none: number;
    asOf: number;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [one, setOne] = useState<
    { passport: Passport; state: VerifyState } | 'invalid' | 'none' | 'error' | 'reading' | null
  >(null);
  // An answer for an older search or check is dropped, so it never replaces a newer one.
  const attempt = useRef(0);
  const checkAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    readListWithRetry(() => live)
      .then((page) => live && setList(page))
      .catch(() => live && setFailed(true));
    // The sample: the highest rated Base IDs (the newest registrations are rarely rated yet).
    loadRatedIds(controller.signal)
      .then(({ ids, asOf }) => {
        if (!live) return;
        const picks = ids.slice(0, SAMPLE);
        setSample({ total: picks.length, pass: 0, fail: 0, none: 0, asOf });
        // The passports load together (each slow on its own, about 16 s today); the Base reads
        // then run one after another, since a public Base node refuses bursts.
        const passports = picks.map((baseId) =>
          passportFor(baseId, controller.signal).catch(() => null),
        );
        void (async () => {
          for (const pending of passports) {
            let o: 'pass' | 'fail' | 'none' = 'none';
            try {
              const passport = await pending;
              if (!live) return;
              if (passport) o = ratingOutcome(await verifyOnBase(passport, scoreClaim(passport)));
            } catch {
              o = 'none';
            }
            if (!live) return;
            setSample((s) => (s ? { ...s, [o]: s[o] + 1 } : s));
          }
        })();
      })
      .catch(() => live && setSampleFailed(true));
    return () => {
      live = false;
      controller.abort();
      checkAbort.current?.abort();
      attempt.current += 1;
    };
  }, []);

  const check = (passport: Passport) => {
    const mine = ++attempt.current;
    setOne({ passport, state: { phase: 'checking' } });
    void verifyOnBase(passport, scoreClaim(passport)).then((result) => {
      if (attempt.current === mine) setOne({ passport, state: { phase: 'done', result } });
    });
  };

  const onCheck = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    const mine = ++attempt.current;
    if (!/^[0-9]{1,20}$/.test(q)) return setOne('invalid');
    setOne('reading');
    try {
      checkAbort.current?.abort();
      checkAbort.current = new AbortController();
      const passport = await passportFor(q, checkAbort.current.signal);
      if (attempt.current !== mine) return;
      if (passport) check(passport);
      else setOne('none');
    } catch {
      if (attempt.current === mine) setOne('error');
    }
  };

  const totals = list?.totals;
  const done = sample ? sample.pass + sample.fail + sample.none : 0;
  const status = sampleFailed ? (
    <Pill tone="muted">Rated agents could not be read</Pill>
  ) : !sample || done < sample.total ? (
    <Pill tone="muted">
      {sample && sample.total > 0
        ? `Recomputing scores from Base… ${done} of ${sample.total}`
        : 'Recomputing scores from Base…'}
    </Pill>
  ) : sample.total === 0 ? (
    <Pill tone="muted">No rated agent to check yet</Pill>
  ) : sample.fail > 0 ? (
    <Pill tone="bad">{`${sample.fail} of ${sample.total} not confirmed`}</Pill>
  ) : sample.none > 0 ? (
    <Pill tone="muted">{`${sample.pass} of ${sample.total} scores recomputed, no answer for ${sample.none}`}</Pill>
  ) : (
    <Pill tone="ok">{`${sample.total} of ${sample.total} scores recomputed on Base`}</Pill>
  );

  const entries =
    one && typeof one === 'object' ? one.passport.reputation.entries.slice(0, 20) : [];

  return (
    <ProofLayout
      crumb="Rated agents"
      title="Rated agents"
      lede="A rating is a 1 to 5 star feedback in the public ERC-8004 Reputation Registry on Base, signed in the owner's own browser. Only agents with a final Base ID and a passport can rate."
    >
      <div className="xp-two">
        <NumberCard
          label="Agents rated by a Central City agent, final on Base"
          value={totals?.ratedAgents != null ? number.format(totals.ratedAgents) : null}
          facts={[
            [
              'Agents on Base',
              totals ? number.format(totals.onBase) : failed ? 'not loaded' : null,
            ],
          ]}
        />
        <ProofCard
          status={status}
          rows={[
            [
              'Registry',
              <a key="r" href={basescanAddress(REPUTATION_REGISTRY)}>
                {shortHex(REPUTATION_REGISTRY, 10, 6)}
              </a>,
            ],
            ['Counts', 'agents with at least one final rating from a Central City agent'],
            ['Score', 'latest star rating of each Central City rater'],
            [
              'Checked here',
              !sample
                ? '–'
                : done < sample.total
                  ? `checking the ${sample.total} highest rated Base IDs (list read ${utcTime(sample.asOf).slice(0, 5)} UTC)…`
                  : `${sample.pass} of the ${sample.total} highest rated Base IDs (list read ${utcTime(sample.asOf).slice(0, 5)} UTC); score recomputed from the registry`,
            ],
          ]}
          actions={<a href={basescanAddress(REPUTATION_REGISTRY)}>Registry on Basescan</a>}
        />
      </div>

      <Panel title="Check one agent's ratings" note="the score is recomputed from the registry">
        <form
          className="xp-search"
          style={{ padding: '18px 22px', marginTop: 0 }}
          onSubmit={onCheck}
        >
          <label htmlFor="xp-rid" className="visually-hidden">
            Base ID
          </label>
          <div className="xp-search-box" style={{ height: 48, flexBasis: 320 }}>
            <input
              id="xp-rid"
              inputMode="numeric"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Base ID"
              className="xp-mono"
            />
          </div>
          <button type="submit" className="xp-btn" style={{ height: 48 }}>
            Check ratings
          </button>
        </form>
        {one === 'invalid' ? (
          <div className="xp-empty">A Base ID is a whole number, like 426816.</div>
        ) : one === 'none' ? (
          <div className="xp-empty">No Central City agent has that Base ID.</div>
        ) : one === 'reading' ? (
          <div className="xp-empty" role="status">
            Reading the agent and its ratings from Base. This can take up to 20 seconds.
          </div>
        ) : one === 'error' ? (
          <div className="xp-empty" role="alert">
            The agent could not be read, so nothing is checked. Try again in a moment.
          </div>
        ) : one ? (
          <div
            style={{ padding: '0 22px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div className="xp-facts" style={{ borderTop: 0, paddingTop: 0 }}>
              <span>
                Agent{' '}
                <b>
                  <a href={passportPath(one.passport.short)}>{shownName(one.passport.name)}</a>
                </b>
              </span>
              <span>
                Ratings on Base <b>{number.format(one.passport.reputation.count)}</b>
              </span>
              <span>
                Central City score{' '}
                <b>
                  {one.passport.reputation.score
                    ? `${one.passport.reputation.score.average} from ${one.passport.reputation.score.raters}`
                    : 'none yet'}
                </b>
              </span>
            </div>
            <OnBaseVerifyPanel
              row={one.passport}
              state={one.state}
              onRetry={() => check(one.passport)}
              basescanHref={basescanAddress(REPUTATION_REGISTRY)}
            />
          </div>
        ) : null}
        {entries.length ? (
          <div className="xp-table-wrap">
            <table className="xp-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th>Base ID</th>
                  <th className="xp-num">Score</th>
                  <th>Rater wallet</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={`${entry.client}-${entry.index}`}>
                    <td style={{ fontWeight: 600 }}>
                      {entry.from ? shownName(entry.from.name) : 'Not a Central City agent'}
                    </td>
                    <td className="xp-mono">{entry.from?.baseId ?? '–'}</td>
                    <td className="xp-num">{entry.score}</td>
                    <td className="xp-mono">
                      <a href={basescanAddress(entry.client)}>{shortHex(entry.client)}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <CodeBox
        title="Check without this website"
        text={`cast call ${REPUTATION_REGISTRY} \\
  "readAllFeedback(uint256,address[],string,string,bool)" <base id> "[<rater wallet>,...]" "" "" false \\
  --rpc-url https://mainnet.base.org`}
      >
        <p>
          The ratings of one agent by the rater wallets listed above, straight from the registry.
          Revoked ones are left out.
        </p>
      </CodeBox>
    </ProofLayout>
  );
}
