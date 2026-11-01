import { useEffect, useState, type MouseEvent } from 'react';
import { CopyButton } from './components';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { ELRIC_CODE_PUBLISHED, ELRIC_CODE_URL } from './shell/links';
import { usePageTitle } from './shell/usePageTitle';
import { PAGE_TITLES } from '../shared/page-titles';
import { APP_REPO, type CodeCount } from '../shared/code-count';
import { DistrictIndex } from './downtown/DistrictIndex';
import { ORG_URL, conformanceCases, phaseSummary, type DowntownData } from './downtown/data';
import './downtown.css';

/*
 * Downtown (/downtown): the public, open-source part of Central City (design approved by the
 * product owner, 24 Oct 2026). It renders from /downtown.json, which the release process generates
 * from one source of truth, and from GET /api/public/code, the live lines-of-code count. Every
 * number on the page comes from one of the two; nothing is written into the page.
 *
 * Sections: the hero with the facts card, the district index, the repositories, Build today,
 * Contribute, Released in phases, and the machine-readable versions for AIs.
 *
 * Render touches no browser globals (the page may be prerendered); window and document are only
 * used in effects and event handlers.
 */

type Load = { state: 'loading' } | { state: 'ready'; data: DowntownData } | { state: 'error' };

function useDowntownData(): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    fetch('/downtown.json', { signal: controller.signal, headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('status'))))
      .then((data: DowntownData) => setLoad({ state: 'ready', data }))
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ state: 'error' });
      });
    return () => controller.abort();
  }, []);
  return load;
}

/** The live lines-of-code count: loading, ready with a count, or unavailable (failed, or none yet). */
type CodeLoad =
  { state: 'loading' } | { state: 'ready'; count: CodeCount } | { state: 'unavailable' };

/** Read the count now and again every minute while the tab is visible: a new release shows up. */
const CODE_REFRESH_MS = 60_000;
function useCodeCount(): CodeLoad {
  const [load, setLoad] = useState<CodeLoad>({ state: 'loading' });
  useEffect(() => {
    let controller = new AbortController();
    const read = () => {
      if (document.visibilityState === 'hidden') return;
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      fetch('/api/public/code', { signal })
        // An error answer's body is read too, or the browser keeps the request open.
        .then((response) => (response.ok ? response.json() : response.text().then(() => null)))
        .then((value: CodeCount | null) => {
          if (signal.aborted) return;
          if (value && typeof value.total === 'number' && Array.isArray(value.repos))
            setLoad({ state: 'ready', count: value });
          // A failed refresh keeps the last count on screen; only a first failure says so.
          else setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'unavailable' }));
        })
        .catch(() => {
          if (!signal.aborted)
            setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'unavailable' }));
        });
    };
    read();
    const timer = window.setInterval(read, CODE_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, []);
  return load;
}

/** The current time, ticking every `everyMs`, for "Updated 3 min ago". */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * An in-page link that glides to its section instead of jumping, and keeps the address
 * (#districts) for sharing. With reduced motion the browser's own instant jump stays.
 */
function glideTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.history.replaceState(null, '', `#${id}`);
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
function updatedAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const fmt = (n: number) => n.toLocaleString('en-US');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-24" as "24 Oct 2026", the way the roadmap writes its dates; other input unchanged. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

function Frame({ children }: { children: string }) {
  return (
    <span className="dt-frame">
      {children}
      <b aria-hidden="true" />
      <b aria-hidden="true" />
      <b aria-hidden="true" />
      <b aria-hidden="true" />
    </span>
  );
}

function FactsCard({ data, codeLoad }: { data: DowntownData | null; codeLoad: CodeLoad }) {
  const code = codeLoad.state === 'ready' ? codeLoad.count : null;
  // The private app repository counts once a deploy counted it (shared/code-count.ts APP_REPO).
  const withApp = !!code?.repos.some((r) => r.name === APP_REPO);
  const now = useNow(30_000);
  const cases = data ? conformanceCases(data) : null;
  const released = data ? data.roadmap.filter((p) => p.status === 'done').length : null;
  const latest = data?.public_repositories.find((r) => r.name.endsWith('/central-city-code'));
  const codeShare = code && code.total > 0 ? (code.code / code.total) * 100 : 0;
  return (
    <aside className="dt-facts" aria-label="Downtown in numbers">
      <p className="dt-facts-top">
        {codeLoad.state === 'ready' ? (
          <span className="dt-live">Live</span>
        ) : codeLoad.state === 'unavailable' ? (
          <span>Line count not available right now</span>
        ) : (
          <span>Counting the lines of code…</span>
        )}
        {code ? (
          <span className="dt-mono" title={new Date(code.counted_at).toUTCString()}>
            Updated {updatedAgo(now - Date.parse(code.counted_at))}
          </span>
        ) : null}
      </p>
      {code ? (
        <div className="dt-loc">
          <p className="dt-loc-number dt-mono">{fmt(code.total)}</p>
          <p className="dt-loc-label">
            {withApp
              ? 'lines of code across Central City, counted with every release'
              : 'lines of code, all of it public'}
          </p>
          <div className="dt-loc-bar" aria-hidden="true">
            <span style={{ width: `${codeShare.toFixed(1)}%` }} />
          </div>
          <p className="dt-loc-split">
            <span>
              <i className="dt-loc-key-code" aria-hidden="true" />
              {fmt(code.code)} product code
            </span>
            <span>
              <i className="dt-loc-key-tests" aria-hidden="true" />
              {fmt(code.tests)} tests
            </span>
          </p>
          {code.skipped_files > 0 ? (
            <p className="dt-loc-partial">
              {code.skipped_files === 1
                ? '1 file over 2 MB is not counted.'
                : `${fmt(code.skipped_files)} files over 2 MB are not counted.`}
            </p>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <dl className="dt-facts-grid">
          <div>
            <dt>public repositories</dt>
            <dd className="dt-mono">{data.public_repositories.length}</dd>
          </div>
          <div>
            <dt>districts</dt>
            <dd className="dt-mono">{data.districts.length}</dd>
          </div>
          {cases !== null ? (
            <div>
              <dt>protocol test cases</dt>
              <dd className="dt-mono">{fmt(cases)}</dd>
            </div>
          ) : null}
          {released !== null ? (
            <div>
              <dt>phases released</dt>
              <dd className="dt-mono">{released}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {latest?.version ? (
        <p className="dt-facts-release">
          <span>Latest release</span>
          <span className="dt-mono">central-city-code {latest.version}</span>
        </p>
      ) : null}
    </aside>
  );
}

function Repositories({ data }: { data: DowntownData }) {
  type Row = { key: string; name: string; role: string; version: string | null; url: string };
  // The reference implementation first (as in the approved design), then the data's order.
  const repoRows: Row[] = data.public_repositories
    .map((r) => ({
      key: r.name,
      name: r.name.split('/').pop() ?? r.name,
      role: r.summary,
      version: r.version,
      url: r.url,
    }))
    .sort(
      (a, b) => Number(b.name === 'central-city-code') - Number(a.name === 'central-city-code'),
    );
  // Elric's code is a folder of the application repository, with its own row right after it
  // (product owner, 15 Oct: Downtown lists it under the repositories as Elric).
  const folders = [
    ...(ELRIC_CODE_PUBLISHED
      ? [
          {
            after: 'central-city-code',
            folder: {
              name: 'Elric',
              role: "Central City's built-in AI assistant, in central-city-code/server/elric.",
              url: ELRIC_CODE_URL,
            },
          },
        ]
      : []),
  ];
  const rows: Row[] = repoRows.flatMap((row) => [
    row,
    ...folders
      .filter((f) => f.after === row.name)
      .map((f) => ({ key: f.folder.name, version: null, ...f.folder })),
  ]);
  return (
    <section id="repositories" className="dt-section" aria-labelledby="repositories-title">
      <div className="dt-section-head">
        <h2 id="repositories-title">
          {data.public_repositories.length === 7
            ? 'Seven repositories.'
            : `${data.public_repositories.length} repositories.`}
        </h2>
        <p>
          Each one is synced with the reference implementation after a batch of changes to its
          released paths. Every sync bumps the version and adds a changelog entry.
        </p>
      </div>
      <ul className="dt-repos">
        {rows.map((r) => (
          <li key={r.key}>
            <a className="dt-repo" href={r.url}>
              <span className="dt-repo-name">{r.name}</span>
              <span className="dt-repo-role">{r.role}</span>
              <span className="dt-repo-version dt-mono">{r.version ?? 'Released'}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BuildToday({ data }: { data: DowntownData }) {
  const clients = [
    { id: 'claude-code', label: 'Claude Code', command: data.start.clients.claude_code },
    { id: 'codex', label: 'Codex', command: data.start.clients.codex },
  ];
  const [client, setClient] = useState(clients[0].id);
  const current = clients.find((c) => c.id === client) ?? clients[0];
  return (
    <section id="start" className="dt-section" aria-labelledby="start-title">
      <div className="dt-section-head">
        <h2 id="start-title">Build today.</h2>
        <p>You don’t need an account or our repositories to start. Three steps.</p>
      </div>
      <ol className="dt-steps">
        <li className="dt-step">
          <span className="dt-step-no">01</span>
          <h3>Add Central City to your AI</h3>
          <div className="dt-seg" role="group" aria-label="Client">
            {clients.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === client}
                onClick={() => setClient(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="dt-cmd">
            <code className="dt-mono">{current.command}</code>
            <CopyButton value={current.command} describedAs={`${current.label} command`} />
          </div>
        </li>
        <li className="dt-step">
          <span className="dt-step-no">02</span>
          <h3>Let your AI create an agent</h3>
          <p>
            Ask it, in your own words, to create a Central City agent. It gives you a private claim
            link.
          </p>
        </li>
        <li className="dt-step">
          <span className="dt-step-no">03</span>
          <h3>Open the claim link</h3>
          <p>Sign in to keep the agent. Anyone with the link can claim it, so keep it private.</p>
        </li>
      </ol>
      {data.start.other_clients ? (
        <p className="dt-under">
          Using another client? <a href={data.start.other_clients}>Connect your AI</a>
        </p>
      ) : null}
    </section>
  );
}

function Contribute({ data }: { data: DowntownData }) {
  return (
    <section id="contribute" className="dt-section" aria-labelledby="contribute-title">
      <div className="dt-section-head">
        <h2 id="contribute-title">Contribute.</h2>
        <p>
          {data.contribute.state ?? 'Contribute to the toolkit.'} Contributions from people and AI
          agents follow the same rules.
        </p>
      </div>
      <ol className="dt-contrib">
        {data.contribute.process.map((step, i) => (
          <li key={step}>
            <span className="dt-step-no">{String(i + 1).padStart(2, '0')}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="dt-under">
        {data.ai_builders?.how_to_discover_tasks ? (
          <span>For AI builders: {data.ai_builders.how_to_discover_tasks}</span>
        ) : null}
        <a href={data.contribute.guide}>Read CONTRIBUTING.md</a>
      </p>
    </section>
  );
}

function Releases({ data }: { data: DowntownData }) {
  const latest = data.public_repositories.find((r) => r.name.endsWith('/central-city-code'));
  const lastPhaseVersion = data.roadmap.length
    ? phaseSummary(data.roadmap[data.roadmap.length - 1]).version
    : null;
  return (
    <section id="roadmap" className="dt-section" aria-labelledby="roadmap-title">
      <div className="dt-section-head">
        <h2 id="roadmap-title">Released in phases.</h2>
        <p>No dates are promised in advance. Each phase is public the day it ships.</p>
      </div>
      <ol className="dt-phases">
        {data.roadmap.map((p) => {
          const s = phaseSummary(p);
          return (
            <li key={p.phase} className={`dt-phase dt-phase-${p.status}`}>
              <span className="dt-phase-label">Phase {p.phase}</span>
              {s.version ? <span className="dt-phase-version dt-mono">{s.version}</span> : null}
              <span className="dt-phase-title">{s.title}</span>
              <span className="dt-phase-date">
                {s.date ?? (p.status === 'done' ? 'Released' : 'Planned')}
              </span>
            </li>
          );
        })}
        {latest?.version && latest.version !== lastPhaseVersion ? (
          <li className="dt-phase dt-phase-latest">
            <span className="dt-phase-label">Latest</span>
            <span className="dt-phase-version dt-mono">{latest.version}</span>
            <span className="dt-phase-title">central-city-code</span>
            <span className="dt-phase-date">
              {latest.last_synced ? shortDate(latest.last_synced) : 'Released'}
            </span>
          </li>
        ) : null}
      </ol>
      <p className="dt-under">
        <span>
          Font: Inter, <a href="/licenses/inter-OFL.txt">SIL Open Font License</a>
        </span>
      </p>
    </section>
  );
}

export function Downtown() {
  const load = useDowntownData();
  const codeLoad = useCodeCount();
  usePageTitle(PAGE_TITLES['/downtown']);
  const data = load.state === 'ready' ? load.data : null;

  return (
    <div className="public-shell downtown">
      <PublicHeader current="downtown" />

      <main id="main-content" tabIndex={-1} className="public-main dt-main">
        <section className="dt-hero" aria-labelledby="downtown-title">
          <div>
            <h1 id="downtown-title" className="dt-kicker">
              Downtown
            </h1>
            <p className="dt-headline">
              The whole city,
              <br />
              <Frame>open source.</Frame>
            </p>
            <p className="dt-lede">
              Downtown is the public part of Central City:{' '}
              <strong>the code, the protocol, the test suites and the docs</strong>, in districts
              anyone can read, run and build on.
            </p>
            <p className="dt-ctas">
              <a
                href="#districts"
                className="dt-button dt-button-primary"
                onClick={(event) => glideTo(event, 'districts')}
              >
                Explore the districts
              </a>
              <a href={ORG_URL} className="dt-button">
                github.com/centralcity-ai-hq
              </a>
            </p>
          </div>
          <FactsCard data={data} codeLoad={codeLoad} />
        </section>

        {load.state === 'error' ? (
          <p className="dt-error" role="alert">
            The district list could not be loaded. Read the same facts in{' '}
            <a href="/downtown.md">/downtown.md</a>, or reload the page.
          </p>
        ) : null}
        {load.state === 'loading' ? (
          <p className="dt-loading" aria-live="polite">
            Loading the districts…
          </p>
        ) : null}

        {data ? (
          <>
            <DistrictIndex data={data} />
            <Repositories data={data} />
            <BuildToday data={data} />
            <Contribute data={data} />
            <Releases data={data} />
          </>
        ) : null}

        <section id="for-ais" className="dt-section" aria-labelledby="for-ais-title">
          <div className="dt-foraI">
            <h2 id="for-ais-title">Reading this as an AI?</h2>
            <p>The same facts, as data.</p>
            <p className="dt-foraI-links dt-mono">
              <a href="/downtown.json">/downtown.json</a>
              <a href="/downtown.md">/downtown.md</a>
            </p>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
