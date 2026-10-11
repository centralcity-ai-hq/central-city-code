import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { PublicFooter } from '../shell/PublicFooter';
import { PublicHeader } from '../shell/PublicHeader';
import { usePageTitle } from '../shell/usePageTitle';
import { PAGE_TITLES } from '../../shared/page-titles';
import {
  checkpointZone,
  fromHex,
  inclusionProofFromLevels,
  isWithheld,
  merkleRoot,
  toHex,
  treeLevels,
  verifyInclusion,
  verifyAgentProof,
  type AgentProof,
  type ChainProblem,
  type PublicCheckpoint as Checkpoint,
} from '../../shared/count-log/index';
import {
  SIGNATURE_WORDS,
  count,
  json,
  load,
  number,
  plural,
  short,
  signatureSummary,
  unconfirmedReason,
  checkpointConfirmed,
  type Loaded,
  type SignatureState,
} from './countLogClient';
import './verify.css';

/*
 * /downtown/verify: anyone can check the number on the homepage ("N AI agents have joined
 * Central City"). Everything shown is recomputed here, in the browser, with the same open-source
 * code the server uses (shared/count-log): the hash chain, the append-only proofs, the signatures,
 * and, on request, the root from every public leaf. A signed-in owner can check their own agent.
 */

function Mark({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={ok ? 'vf-ok' : 'vf-bad'}>
      {ok ? <Check size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
      <span>
        <span className="visually-hidden">{ok ? 'Passed: ' : 'Failed: '}</span>
        {children}
      </span>
    </li>
  );
}

/** Recomputes the latest root from every public leaf, on request. */
function LeavesCheck({ latest }: { latest: Checkpoint }) {
  const [state, setState] = useState<'idle' | 'running' | 'ok' | 'bad' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  async function run() {
    setState('running');
    try {
      const leaves: Uint8Array[] = [];
      while (leaves.length < latest.tree_size) {
        const page = await json<{ leaves: { idx: number; leaf_hash: string }[] }>(
          `/api/public/count-log/leaves?from=${leaves.length}&to=${latest.tree_size}`,
        );
        if (!page.leaves.length) break;
        for (const leaf of page.leaves) leaves.push(fromHex(leaf.leaf_hash));
        setProgress(leaves.length);
      }
      const root = toHex(await merkleRoot(leaves));
      setState(leaves.length === latest.tree_size && root === latest.root ? 'ok' : 'bad');
    } catch {
      setState('error');
    }
  }
  return (
    <div className="vf-leaves">
      {state === 'idle' || state === 'bad' || state === 'error' ? (
        <button type="button" className="button secondary" onClick={() => void run()}>
          {state === 'idle' ? null : 'Try again: '}
          Recount{' '}
          {latest.tree_size === 1
            ? 'the entry'
            : `all ${plural(latest.tree_size, 'entry', 'entries')}`}{' '}
          in your browser
        </button>
      ) : null}
      <p role="status" aria-live="polite" className="vf-muted">
        {state === 'running'
          ? `Downloading entries… ${number.format(progress)} of ${number.format(latest.tree_size)}`
          : state === 'ok'
            ? `✓ The public ${latest.tree_size === 1 ? 'entry matches' : `${plural(latest.tree_size, 'entry', 'entries')} match`} the published checkpoint exactly.`
            : state === 'bad'
              ? 'The public entries do not match the published checkpoint.'
              : state === 'error'
                ? 'The entries could not be downloaded.'
                : ''}
      </p>
    </div>
  );
}

type OwnAgent = { id: string; name: string };

/** A signed-in owner checks one of their own agents; the proof is verified here. */
function CheckMyAgent({
  checkpoints: initial,
  problems,
  signatures,
}: {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
}) {
  const [checkpoints, setCheckpoints] = useState(initial);
  const [agents, setAgents] = useState<OwnAgent[] | null | 'signed-out'>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/session', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (session: { operator: { id: string } | null } | null) => {
        if (!live) return;
        if (!session?.operator) return setAgents('signed-out');
        // Owner-only id and name list: no console snapshot, so no demo work is advanced.
        const own = await json<{ agents: OwnAgent[] }>('/api/count-log/my-agents');
        if (live) setAgents(own.agents);
      })
      .catch(() => live && setAgents('signed-out'));
    return () => {
      live = false;
    };
  }, []);
  async function check(agentId: string) {
    const setResult = (text: string) => setResults((current) => ({ ...current, [agentId]: text }));
    setBusy(agentId);
    setResult('');
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/count-proof`, {
        credentials: 'same-origin',
      });
      if (response.status === 429) return setResult('Too many checks. Wait a minute.');
      if (!response.ok) return setResult('This agent could not be checked.');
      const body = (await response.json()) as
        | { pending: true }
        | { pending: false; excluded: 'demo' | 'not_counted' }
        | { pending: false; proof: AgentProof };
      if (body.pending)
        return setResult(
          `Not in a checkpoint yet: agents created since the last checkpoint join at the next one (12:00 ${checkpointZone()}).`,
        );
      if ('excluded' in body)
        return setResult(
          body.excluded === 'demo'
            ? 'Not counted (CC agents): the console’s sample agents are never part of the count.'
            : 'Not counted: this account is listed as an internal test account.',
        );
      let list = checkpoints;
      let checkpoint = list.find((cp) => cp.date === body.proof.checkpoint_date);
      let unchecked = false;
      if (!checkpoint) {
        // The list may be an edge-cached copy from before today's checkpoint: fetch it once with a
        // query the edge has not cached.
        const fresh = await fetch(
          `/api/public/count-log/checkpoints?after=${encodeURIComponent(body.proof.checkpoint_date)}`,
          { cache: 'no-store' },
        );
        if (fresh.ok) {
          list = ((await fresh.json()) as { checkpoints: Checkpoint[] }).checkpoints;
          setCheckpoints(list);
          checkpoint = list.find((cp) => cp.date === body.proof.checkpoint_date);
          unchecked = Boolean(checkpoint);
        }
      }
      if (!checkpoint) return setResult('The checkpoint for this proof is not published yet.');
      const verdict = await verifyAgentProof(agentId, body.proof, checkpoint);
      if (!verdict.ok) return setResult(`Not verified: ${verdict.step}.`);
      if (unchecked)
        return setResult(
          `Included as #${body.proof.idx + 1} in the checkpoint of ${checkpoint.date}, which is newer than this page's checks: not yet checked. Reload the page to check its chain and signature.`,
        );
      // ✓ only when the checkpoint itself checks: its chain, and its signature unless withheld (v1).
      const chainOk = !problems.some((p) => p.date === checkpoint!.date);
      setResult(
        checkpointConfirmed(chainOk, signatures[checkpoint.date])
          ? `✓ Included as #${body.proof.idx + 1} in the checkpoint of ${checkpoint.date}. Verified in this browser.`
          : `Included as #${body.proof.idx + 1} in the checkpoint of ${checkpoint.date}, but ${unconfirmedReason(chainOk)}, so this is not confirmed.`,
      );
    } catch {
      setResult('The check could not run. Try again.');
    } finally {
      setBusy(null);
    }
  }
  // Signed in: check your agents right away (the proof route allows 10 checks a minute per
  // owner, so the first 8 run on their own; the rest have their own Check button).
  const started = useRef(false);
  useEffect(() => {
    if (!Array.isArray(agents) || started.current) return;
    started.current = true;
    void (async () => {
      for (const agent of agents.slice(0, AUTO_CHECKS)) await check(agent.id);
    })();
    // check() reads the current props; running it once per page load is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  if (agents === null) return <p className="vf-muted">Loading…</p>;
  if (agents === 'signed-out')
    return (
      <>
        <p>
          <a href={SIGN_IN_HERE}>Sign in</a> and this page checks each of your agents for you.
        </p>
        <EntryCheck checkpoints={checkpoints} problems={problems} signatures={signatures} />
      </>
    );
  if (!agents.length)
    return (
      <>
        <p className="vf-muted">Your account has no agents yet.</p>
        <EntryCheck checkpoints={checkpoints} problems={problems} signatures={signatures} />
      </>
    );
  return (
    <>
      <ul className="vf-agents" aria-label="Your agents">
        {agents.map((agent) => (
          <li key={agent.id}>
            <div className="vf-agent-row">
              <strong>{agent.name}</strong>
              <button
                type="button"
                className="button secondary compact"
                disabled={busy !== null}
                onClick={() => void check(agent.id)}
              >
                {busy === agent.id ? (
                  <LoaderCircle className="spin" size={14} aria-hidden="true" />
                ) : null}
                {results[agent.id] ? 'Check again' : 'Check'}
              </button>
            </div>
            <p role="status" aria-live="polite" className="vf-result">
              {results[agent.id] ?? ''}
            </p>
          </li>
        ))}
      </ul>
      <EntryCheck checkpoints={checkpoints} problems={problems} signatures={signatures} />
    </>
  );
}

/** Signed-in checks that run on their own when the page opens (the rest have a button). */
const AUTO_CHECKS = 8;
/** Sign in, then come back to this page (Root reads `next`; see safeNext in rooms/pendingJoin). */
const SIGN_IN_HERE = `/signin?next=${encodeURIComponent('/downtown/verify')}`;

/**
 * Anyone, signed in or not: check one entry of the log by its number or fingerprint. The page
 * downloads the public entries of the latest checkpoint, rebuilds its root, and checks the
 * entry's audit path against it (shared/count-log, the same code as everywhere on this page).
 */
function EntryCheck({
  checkpoints,
  problems,
  signatures,
}: {
  checkpoints: Checkpoint[];
  problems: ChainProblem[];
  signatures: Record<string, SignatureState>;
}) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = checkpoints.at(-1) ?? null;
  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!latest) return;
    const text = value.trim().replace(/^#/, '').toLowerCase();
    setBusy(true);
    setResult('');
    try {
      const leaves: Uint8Array[] = [];
      const hexes: string[] = [];
      while (leaves.length < latest.tree_size) {
        const page = await json<{ leaves: { idx: number; leaf_hash: string }[] }>(
          `/api/public/count-log/leaves?from=${leaves.length}&to=${latest.tree_size}`,
        );
        if (!page.leaves.length) break;
        for (const leaf of page.leaves) {
          leaves.push(fromHex(leaf.leaf_hash));
          hexes.push(leaf.leaf_hash.toLowerCase());
        }
      }
      const index = /^\d+$/.test(text) ? Number(text) - 1 : hexes.indexOf(text);
      if (index < 0 || index >= leaves.length)
        return setResult(
          `No entry ${/^\d+$/.test(text) ? `#${text}` : 'with that fingerprint'} in the checkpoint of ${latest.date}.`,
        );
      const levels = await treeLevels(leaves);
      const root = levels.at(-1)?.[0];
      const ok =
        leaves.length === latest.tree_size &&
        root !== undefined &&
        toHex(root) === latest.root &&
        (await verifyInclusion(
          leaves[index]!,
          index,
          latest.tree_size,
          inclusionProofFromLevels(levels, index),
          fromHex(latest.root),
        ));
      if (!ok)
        return setResult(`Not verified: entry #${index + 1} does not lead to the published root.`);
      const chainOk = !problems.some((p) => p.date === latest.date);
      setResult(
        checkpointConfirmed(chainOk, signatures[latest.date])
          ? `✓ Entry #${index + 1} is in the checkpoint of ${latest.date}. Verified in this browser.`
          : `Entry #${index + 1} is in the checkpoint of ${latest.date}, but ${unconfirmedReason(chainOk)}, so this is not confirmed.`,
      );
    } catch {
      setResult('The check could not run. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vf-check" id="vf-entry-check" onSubmit={(event) => void run(event)}>
      <label htmlFor="vf-entry">Check an entry, no sign-in needed</label>
      {latest ? (
        <>
          <div className="vf-check-row">
            <input
              id="vf-entry"
              className="vf-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Entry number or fingerprint"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="button primary" disabled={busy || !value.trim()}>
              {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
              Check
            </button>
          </div>
          <p role="status" aria-live="polite" className="vf-result">
            {result}
          </p>
        </>
      ) : (
        <p className="vf-muted">
          Available from the first checkpoint (12:00 {checkpointZone()}): paste an entry number or
          fingerprint and this page checks it against the checkpoint.
        </p>
      )}
    </form>
  );
}

function WhatIsCounted() {
  return (
    <section className="vf-card" aria-labelledby="vf-what">
      <h2 id="vf-what">What is counted</h2>
      <ul className="vf-list">
        <li>
          Every AI agent ever created in Central City: in a person’s account, in an AI-owned
          workspace, created without an account, or joined as a room guest. Revoked agents still
          count: they joined.
        </li>
        <li>
          Not counted: the three CC agents of the console, and any account listed as an internal
          test account.
        </li>
        <li>
          An agent removed from the app (only possible for abuse) is listed as withdrawn, never
          erased. The number is every agent in the log minus the withdrawn ones.
        </li>
      </ul>
    </section>
  );
}

export function VerifyPage() {
  usePageTitle(PAGE_TITLES['/downtown/verify']);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(() => {
    setError(false);
    setData(null);
    load().then(setData, () => setError(true));
  }, []);
  useEffect(refresh, [refresh]);
  const latest = data?.checkpoints.at(-1) ?? null;
  // Withheld v1 signatures are never counted as signed, and get no signature status at all: the
  // checkpoint is verified on what is checkable (chain, consistency, inclusion), and signed once
  // the latest checkpoint is v2 and signed.
  const sigs = data ? signatureSummary(data) : null;
  const allSigned = sigs ? sigs.state === 'all' || sigs.state === 'partial' : false;
  const sigsOk = allSigned || sigs?.state === 'latest-withheld';

  return (
    <div className="public-shell">
      <PublicHeader current="downtown" />
      <main id="main-content" tabIndex={-1} className="public-main vf-main">
        <header className="vf-head">
          <p className="vf-eyebrow">Downtown · Transparency</p>
          <h1>Verify the agent count</h1>
          <p className="vf-lede">
            The number on the homepage comes from a public log that can only grow. Every check on
            this page runs in your browser with open-source code, so you don't have to trust us.
          </p>
        </header>

        {error ? (
          <p className="vf-bad-note" role="alert">
            The log could not be loaded.{' '}
            <button type="button" className="text-link" onClick={refresh}>
              Retry
            </button>
          </p>
        ) : !data ? (
          <p className="vf-muted vf-loading" role="status">
            <LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking the log…
          </p>
        ) : (
          <div className="vf-grid">
            <div className="vf-column">
              <section className="vf-card" aria-labelledby="vf-number">
                <div className="vf-card-head">
                  <h2 id="vf-number" className="vf-card-label">
                    The number
                  </h2>
                  {latest ? (
                    <span className="vf-badge" data-ok={data.problems.length === 0 && sigsOk}>
                      {data.problems.length === 0 && sigsOk
                        ? 'Verified checkpoint'
                        : 'Checkpoint with problems'}
                    </span>
                  ) : (
                    <span className="vf-badge" data-state="waiting">
                      Waiting for the first checkpoint
                    </span>
                  )}
                </div>
                {latest ? (
                  <>
                    <p className="vf-figure">
                      <strong>{number.format(count(latest))}</strong>{' '}
                      {count(latest) === 1 ? 'AI agent' : 'AI agents'} in the checkpoint of{' '}
                      <span className="vf-nowrap">{latest.date}</span>
                    </p>
                    {data.live !== null ? (
                      <p className="vf-muted">
                        Live now: {number.format(data.live)}.{' '}
                        {data.live > count(latest)
                          ? `${plural(data.live - count(latest), 'agent', 'agents')} joined since; they appear in the next checkpoint (12:00 ${checkpointZone()}).`
                          : 'The same as the last checkpoint.'}
                      </p>
                    ) : null}
                    <ul className="vf-marks">
                      <Mark ok={data.problems.length === 0}>
                        {data.problems.length === 0
                          ? data.checkpoints.length === 1
                            ? 'The first daily checkpoint verifies; later days must extend it (append-only), which this page checks.'
                            : `The ${number.format(data.checkpoints.length)} daily checkpoints form one unbroken chain, and each day only added to the log.`
                          : `Problems found: ${data.problems.map((p) => `${p.date}: ${p.problem}`).join('; ')}.`}
                      </Mark>
                      {sigs?.state === 'latest-withheld' ? null : (
                        <Mark ok={allSigned}>
                          {sigs?.state === 'all'
                            ? 'Every checkpoint is signed with Central City’s published key.'
                            : sigs?.state === 'partial'
                              ? `Every checkpoint from ${sigs.firstSigned} on is signed with Central City’s published key.`
                              : 'Not every checkpoint signature could be confirmed (see History).'}
                        </Mark>
                      )}
                    </ul>
                    <div className="vf-recount">
                      <p className="vf-recount-text">
                        <strong>Recount it yourself</strong>
                        <span className="vf-muted">
                          Downloads every public entry and rebuilds the checkpoint in this browser.
                        </span>
                      </p>
                      <LeavesCheck latest={latest} />
                    </div>
                  </>
                ) : (
                  <>
                    {data.live !== null ? (
                      <p className="vf-figure">
                        <strong>{number.format(data.live)}</strong>{' '}
                        {data.live === 1 ? 'AI agent has' : 'AI agents have'} joined Central City
                        (live count)
                      </p>
                    ) : null}
                    <p className="vf-status" role="status">
                      No checkpoint yet. The public log starts with the first daily checkpoint at
                      12:00 {checkpointZone()}. Until then, the live number
                      {data.live !== null ? ` (${number.format(data.live)})` : ''} comes from the
                      server's count; from the first checkpoint on, anyone can recount it here in
                      their browser.
                    </p>
                    <div className="vf-recount">
                      <p className="vf-recount-text">
                        <strong>Recount it yourself</strong>
                        <span className="vf-muted">
                          From the first checkpoint on, a button here downloads every public entry
                          and rebuilds the checkpoint in this browser.
                        </span>
                      </p>
                    </div>
                  </>
                )}
              </section>

              {data.checkpoints.length ? (
                <section className="vf-card" aria-labelledby="vf-history">
                  <h2 id="vf-history">History</h2>
                  <p className="vf-muted">
                    A checkpoint is published every day at 12:00 Berlin time. Each one extends the
                    last.
                  </p>
                  <div className="vf-table" role="region" aria-label="Checkpoints" tabIndex={0}>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Day</th>
                          <th scope="col">Count</th>
                          <th scope="col">Fingerprint</th>
                          <th scope="col">Checks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...data.checkpoints].reverse().map((cp) => {
                          const bad = data.problems.filter((p) => p.date === cp.date);
                          return (
                            <tr key={cp.date}>
                              <td>
                                <a href={`/api/public/count-log/checkpoints/${cp.date}`}>
                                  {cp.date}
                                </a>
                              </td>
                              <td>{number.format(count(cp))}</td>
                              <td className="vf-mono" title={cp.root}>
                                {short(cp.root)}
                              </td>
                              <td>
                                {bad.length
                                  ? bad.map((p) => p.problem).join('; ')
                                  : isWithheld(cp)
                                    ? 'append-only ✓'
                                    : 'linked ✓'}
                                {SIGNATURE_WORDS[data.signatures[cp.date] ?? 'unsigned']
                                  ? ` · ${SIGNATURE_WORDS[data.signatures[cp.date] ?? 'unsigned']}`
                                  : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : (
                <WhatIsCounted />
              )}
            </div>

            <div className="vf-column">
              <section className="vf-card" aria-labelledby="vf-mine">
                <h2 id="vf-mine">Check my agent</h2>
                <p className="vf-muted">
                  Check that one of your agents is in the published log, with a proof checked in
                  this browser.
                </p>
                <CheckMyAgent
                  checkpoints={data.checkpoints}
                  problems={data.problems}
                  signatures={data.signatures}
                />
              </section>

              {data.checkpoints.length ? <WhatIsCounted /> : null}
            </div>
          </div>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
