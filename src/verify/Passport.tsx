import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { NO_SCORE_LINE, scoreLine } from '../../shared/base/rating-score';
import { number, plural } from './countLogClient';
import { OnBaseVerifyPanel, type VerifyState } from './OnBaseVerifyPanel';
import {
  basescanAddress,
  basescanToken,
  basescanTx,
  finalizingMinutes,
  initial,
  loadOnBase,
  loadPassport,
  scoreClaim,
  shownName,
  shortWallet,
  verifyKey,
  verifyOnBase,
  type Passport as PassportData,
} from './onBaseData';
import './verify.css';
import './on-base.css';

/*
 * /a/<Base ID>: one Base agent's passport (docs/design/on-base-mockup.html, "Passport"). The same
 * address the Base ID's tokenURI points to; the on-chain short link (/a/<6 characters>) shows it
 * too. Everything comes from the public read route (onBaseData.ts); Verify re-reads the Base ID
 * from Base in this browser and claims nothing it couldn't read.
 */

/** While an agent is finalizing, the page re-reads its passport this often (visible tab only). */
const REFRESH_MS = 30_000;
const EXPLORER = '/explorer/base';

const berlinTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "0x78d0e389…3e6e2c22": the registration transaction, shortened for the facts. */
const shortTx = (hash: string) =>
  hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
/** "+1", "-0.5", "0": a feedback score as Base stores it, with its sign. */
const signedScore = (score: string) =>
  score.startsWith('-') || /^0(\.0*)?$/.test(score) ? score : `+${score}`;
/** A Base ID is decimal; anything else in /a/<x> is the on-chain short link. */
/**
 * The Base ID behind a short id, from the public list (its search knows short ids, also while an
 * agent is finalizing): the row whose short id is exactly this one. Null when there is none.
 */
async function baseIdOf(short: string): Promise<string | null> {
  const { rows } = await loadOnBase({ q: short });
  return rows.find((row) => row.short === short)?.baseId ?? null;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; passport: PassportData }
  | { kind: 'missing' }
  | { kind: 'error' };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        type="button"
        className="ob-pp-cp"
        aria-label={label}
        title={label}
        onClick={() => {
          // Inside the click, so the browser counts it as the visitor's own copy.
          let copying: Promise<void>;
          try {
            copying = navigator.clipboard.writeText(text);
          } catch {
            return;
          }
          copying.then(
            () => {
              setDone(true);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setDone(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        {done ? (
          <Check size={13} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
      <span className="ob-pp-copied" role="status">
        {done ? 'Copied' : ''}
      </span>
    </>
  );
}

function Status({ passport, now }: { passport: PassportData; now: number }) {
  if (passport.status === 'final')
    return (
      <span className="ob-pp-chip" data-state="final">
        <Check size={12} strokeWidth={3} aria-hidden="true" /> Final
      </span>
    );
  const minutes = finalizingMinutes(passport.finalizingSince, now);
  return (
    <>
      <span className="ob-pp-chip" data-state="finalizing">
        <i className="ob-pulse" aria-hidden="true" /> Finalizing
      </span>
      <span className="ob-pp-since">
        {minutes === null ? 'usually 15–30 min' : `${minutes} min · usually 15–30`}
      </span>
    </>
  );
}

function Facts({ passport }: { passport: PassportData }) {
  return (
    <dl className="ob-pp-facts">
      <div className="ob-pp-fact">
        <dt>Base ID</dt>
        <dd className="ob-pp-num">
          <b>{passport.baseId}</b>
        </dd>
      </div>
      <div className="ob-pp-fact" data-tool="true">
        <dt>Owner wallet</dt>
        <dd>
          <span className="ob-pp-mono">{passport.owner}</span>
          <CopyButton text={passport.owner} label="Copy owner wallet" />
        </dd>
      </div>
      <div className="ob-pp-fact" data-tool="true">
        <dt>Agent wallet</dt>
        <dd>
          <span className="ob-pp-mono">{passport.agentWallet}</span>
          <CopyButton text={passport.agentWallet} label="Copy agent wallet" />
        </dd>
      </div>
      <div className="ob-pp-fact" data-tool="true">
        <dt>Registration</dt>
        <dd>
          {passport.registrationTx ? (
            <>
              <a
                className="ob-pp-mono ob-pp-tx"
                href={basescanTx(passport.registrationTx)}
                target="_blank"
                rel="noreferrer"
                title={passport.registrationTx}
              >
                {shortTx(passport.registrationTx)}
              </a>{' '}
              <span className="ob-pp-note">
                · {berlinTime.format(new Date(passport.registeredAt))} Berlin
              </span>
              <a
                className="ob-pp-cp"
                href={basescanTx(passport.registrationTx)}
                target="_blank"
                rel="noreferrer"
                aria-label="View on Basescan"
                title="View on Basescan"
              >
                <ArrowUpRight size={13} strokeWidth={2.2} aria-hidden="true" />
              </a>
            </>
          ) : (
            <>
              {berlinTime.format(new Date(passport.registeredAt))} Berlin{' '}
              <span className="ob-pp-note">· transaction not on record</span>
            </>
          )}
        </dd>
      </div>
      <div className="ob-pp-fact">
        <dt>Finality</dt>
        <dd>
          {passport.final && passport.final.block !== null ? (
            <>
              Final at Base block{' '}
              <span className="ob-pp-num">{number.format(passport.final.block)}</span>
            </>
          ) : passport.status === 'final' ? (
            'Final'
          ) : (
            'Finalizing · usually 15–30 min'
          )}
        </dd>
      </div>
    </dl>
  );
}

function Verify({ passport }: { passport: PassportData }) {
  const [state, setState] = useState<VerifyState | null>(null);
  const run = useRef(0);
  const claim = scoreClaim(passport);
  const check = useCallback(() => {
    const mine = ++run.current;
    setState({ phase: 'checking' });
    void verifyOnBase(passport, scoreClaim(passport)).then((result) => {
      if (mine === run.current) setState({ phase: 'done', result });
    });
  }, [passport]);
  return (
    <section className="ob-pp-sec" aria-labelledby="ob-pp-verify">
      <div className="ob-pp-sec-head">
        <h2 id="ob-pp-verify">Verify</h2>
        <span>In your browser, against Base</span>
      </div>
      <div className="ob-pp-card">
        {state ? (
          <OnBaseVerifyPanel
            row={passport}
            state={state}
            onRetry={check}
            passportLink={false}
            basescanHref={basescanToken(passport.registry, passport.baseId)}
          />
        ) : (
          <div className="ob-pp-verify">
            <p>
              Reads Base ID {passport.baseId} from Base in this browser: who owns it, where it
              points, how it was minted and whether it&apos;s final. From Central City it reads only
              the passport this ID points to, and checks that it still names this ID.
              {claim
                ? ' It also recomputes the Central City score from the ratings on Base of the wallets this passport names.'
                : ''}
            </p>
            <button type="button" className="ob-pill" onClick={check}>
              Verify
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function Reputation({ passport }: { passport: PassportData }) {
  const { readAtBlock, count, entries, score } = passport.reputation;
  const read = readAtBlock !== null;
  return (
    <section className="ob-pp-sec" aria-labelledby="ob-pp-reputation">
      <div className="ob-pp-sec-head">
        <h2 id="ob-pp-reputation">Reputation</h2>
        {read && count ? (
          <span className="ob-pp-num">{plural(count, 'entry', 'entries')} on Base</span>
        ) : null}
      </div>
      <div className="ob-pp-card">
        {read ? (
          <p className="ob-pp-city" data-scored={score ? '' : undefined}>
            {score ? scoreLine(score) : NO_SCORE_LINE}
          </p>
        ) : null}
        {!read ? (
          <p className="ob-pp-none">
            Couldn&apos;t read Base&apos;s Reputation Registry just now. Try again in a moment.
          </p>
        ) : entries.length ? (
          <ul className="ob-pp-reps">
            {entries.map((entry) => (
              <li key={`${entry.client}-${entry.index}`} className="ob-pp-rep">
                <b>
                  From{' '}
                  {entry.from ? (
                    entry.from.name ? (
                      `${entry.from.name} · ID ${entry.from.baseId}`
                    ) : (
                      `ID ${entry.from.baseId}`
                    )
                  ) : (
                    <a
                      className="ob-pp-tx"
                      href={basescanAddress(entry.client)}
                      target="_blank"
                      rel="noreferrer"
                      title={entry.client}
                    >
                      {shortWallet(entry.client)}
                    </a>
                  )}
                </b>
                <span className="ob-pp-score">{signedScore(entry.score)}</span>
                <p>
                  {entry.tags.length ? `${entry.tags.join(' · ')} · ` : ''}
                  Feedback #{entry.index}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ob-pp-none">No feedback on Base yet.</p>
        )}
      </div>
      {read ? (
        <p className="ob-pp-rep-note">
          Read from Base at block {number.format(readAtBlock)}
          {count > entries.length
            ? ` · the last ${number.format(entries.length)} of ${number.format(count)}`
            : ''}
          . Anyone can give an agent feedback on Base; only Central City agents are named. The score
          counts the latest star rating of each Central City agent with a final Base ID, one vote
          per agent.
        </p>
      ) : null}
    </section>
  );
}

const FACT_LABELS = ['Base ID', 'Owner wallet', 'Agent wallet', 'Registration', 'Finality'];
const SKELETON_WIDTHS = ['56px', '62%', '62%', '44%', '36%'];

function SkeletonHead() {
  return (
    <div className="ob-pp-head" aria-hidden="true">
      <i className="ob-av ob-pp-av ob-pp-sk-av" />
      <div className="ob-pp-sk-lines">
        <div className="ob-sk" style={{ width: 160, height: 24 }} />
        <div className="ob-sk" style={{ width: 200 }} />
      </div>
    </div>
  );
}

function SkeletonFacts() {
  return (
    <>
      <p className="visually-hidden" role="status">
        Reading the passport…
      </p>
      <dl className="ob-pp-facts" aria-hidden="true">
        {FACT_LABELS.map((label, index) => (
          <div key={label} className="ob-pp-fact">
            <dt>{label}</dt>
            <dd>
              <div className="ob-sk" style={{ width: SKELETON_WIDTHS[index] }} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function Head({ passport, now }: { passport: PassportData; now: number }) {
  return (
    <div className="ob-pp-head">
      <i
        className="ob-av ob-pp-av"
        style={passport.colour ? ({ '--ob-c': passport.colour } as CSSProperties) : undefined}
        aria-hidden="true"
      >
        {initial(passport.name)}
      </i>
      <div>
        <h1 data-private={passport.name.trim() ? undefined : ''}>{shownName(passport.name)}</h1>
        <p>
          <span className="ob-pp-num">Base agent · ID {passport.baseId}</span>
          <Status passport={passport} now={now} />
        </p>
      </div>
    </div>
  );
}

export function Passport({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const passport = load.kind === 'ready' ? load.passport : null;
  usePageTitle(
    passport
      ? `${shownName(passport.name)}, Base agent ${passport.baseId} · Central City`
      : 'Base agent · Central City',
  );

  const read = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoad({ kind: 'loading' });
      try {
        const baseId = await baseIdOf(id);
        const loaded = baseId === null ? null : await loadPassport(baseId);
        // An unknown id (404) is null: "No agent with Base ID …".
        if (!loaded) {
          if (!quiet) setLoad({ kind: 'missing' });
          return;
        }
        setLoad({ kind: 'ready', passport: loaded });
        setNow(Date.now());
      } catch {
        // A quiet re-read that fails keeps what is shown; the next one tries again.
        if (quiet) return;
        setLoad({ kind: 'error' });
      }
    },
    [id],
  );
  useEffect(() => {
    void read();
  }, [read]);

  // Finalizing: the minutes count on, and the passport turns final by itself.
  const finalizing = passport?.status === 'finalizing';
  useEffect(() => {
    if (!finalizing) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      void read(true);
    }, REFRESH_MS);
    return () => window.clearInterval(tick);
  }, [finalizing, read]);

  return (
    <div className="public-shell">
      <PublicHeader current="downtown" />
      <main
        id="main-content"
        tabIndex={-1}
        className="public-main vf-main ob-pp-main"
        aria-busy={load.kind === 'loading' ? true : undefined}
      >
        <header className="vf-head ob-pp-top">
          <p className="vf-eyebrow">
            <a href={EXPLORER}>Agent Explorer · On Base</a>
          </p>
          {load.kind === 'ready' ? (
            <Head passport={load.passport} now={now} />
          ) : load.kind === 'loading' ? (
            <SkeletonHead />
          ) : null}
        </header>
        {load.kind === 'loading' ? (
          <SkeletonFacts />
        ) : load.kind === 'missing' ? (
          <div className="ob-pp-card">
            <div className="ob-empty">
              <b>No agent at this address</b>
              <span>
                Central City has no agent on Base under this ID. A new one shows up here as soon as
                Base includes it.
              </span>
              <a className="ob-pill" href={EXPLORER}>
                Back to the Agent Explorer
              </a>
            </div>
          </div>
        ) : load.kind === 'error' ? (
          <div className="ob-banner" data-tone="warn" role="alert">
            <div>
              <b>The passport couldn&apos;t be read right now</b>
              <p>Nothing is shown rather than something out of date. Try again in a moment.</p>
            </div>
            <button type="button" className="ob-pill" onClick={() => void read()}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <Facts passport={load.passport} />
            {/* A re-read that changes a checked fact (the score too) starts Verify over: no
                earlier result stays beside the new facts, and a check still on its way is
                dropped. */}
            <Verify
              key={`${verifyKey(load.passport)}|${JSON.stringify([
                load.passport.reputation.score ?? null,
                load.passport.reputation.scoredBy ?? [],
              ])}`}
              passport={load.passport}
            />
            <Reputation passport={load.passport} />
            <div className="ob-pp-later">
              <span>
                <b>Payments</b> · this agent&apos;s payments on Base appear here later.
              </span>
              <span>Coming later</span>
            </div>
          </>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
