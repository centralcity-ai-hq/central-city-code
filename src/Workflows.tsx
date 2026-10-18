import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  CheckCheck,
  Download,
  FileText,
  LoaderCircle,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type { Agent, Job, Snapshot, Workflow, WorkflowDetail } from '../shared/types';
import { api } from './api';
import { searchLiveAgents } from './agents/ownAgents';
import { useAgentPicker } from './agents/useAgentPicker';
import { EmptyState, formatDate, statusLabels } from './components';
import { ReadableData } from './ui/ReadableData';
import { ExchangeCircle, workflowExchangeState } from './circle';

const labels: Record<Workflow['status'], string> = {
  briefing: 'Preparing brief',
  awaiting_review: 'Review the draft',
  checking: 'Checking draft',
  completed: 'Ready for your decision',
  accepted: 'Accepted by you',
  failed: 'Needs attention',
  canceled: 'Canceled',
};
const sampleSource =
  'Project: River Library\nThe team plans a reading room with 24 seats.\nThe proposed opening date is 15 November; funding approval is still pending.\nThe coordinator will confirm the budget on 3 October.\nSource note: This is fictional sample material for a private test.';

const steps = ['Add your source', 'Review brief', 'Check against source', 'Accept result'];

/**
 * Where a collaboration stands on the four steps, from its recorded status only: how many steps
 * are done and which one (if any) is current. Failed and canceled records have no current step.
 */
export function workflowProgress(workflow: Pick<Workflow, 'status' | 'checkJobId'>): {
  done: number;
  current: number | null;
} {
  switch (workflow.status) {
    case 'briefing':
    case 'awaiting_review':
      return { done: 1, current: 1 };
    case 'checking':
      return { done: 2, current: 2 };
    case 'completed':
      return { done: 3, current: 3 };
    case 'accepted':
      return { done: 4, current: null };
    default:
      return { done: workflow.checkJobId ? 2 : 1, current: null };
  }
}

function WorkflowSteps({ workflow }: { workflow: Workflow }) {
  const { done, current } = workflowProgress(workflow);
  return (
    <ol className="collaboration-steps adv2-track" aria-label="Collaboration progress">
      {steps.map((label, index) => {
        const state = index === current ? 'current' : index < done ? 'done' : 'todo';
        return (
          <li
            key={label}
            className={`adv2-step-${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span>{String(index + 1).padStart(2, '0')}</span> {label}
            {state === 'done' ? <span className="visually-hidden"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function Workflows({
  snapshot,
  refresh,
  v2 = false,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  /** Workspace v2: progress track and source, brief and check side by side. */
  v2?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const workflows = snapshot.workflows ?? [];
  const selected = workflows.find((item) => item.id === selectedId);
  const nameOf = (id: string) => snapshot.agents.find((agent) => agent.id === id)?.name ?? 'Agent';
  return (
    <div className="collaboration-layout">
      <section className="panel collaboration-intro">
        <div>
          <p className="eyebrow">One source, two agents, your decision</p>
          <h2>A brief you can inspect.</h2>
          <p>
            Give a researcher your source material, review its draft, then ask a second agent to
            check it against the original. You decide when the work is accepted.
          </p>
        </div>
        <button
          className="button primary"
          disabled={snapshot.paused}
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
          }}
        >
          <FileText size={16} />
          New collaboration
        </button>
        <ol className="collaboration-steps" aria-label="Collaboration steps">
          <li>
            <span>01</span> Add your source
          </li>
          <li>
            <span>02</span> Review brief
          </li>
          <li>
            <span>03</span> Check against source
          </li>
          <li>
            <span>04</span> Accept result
          </li>
        </ol>
        <p className="field-note">
          Private to this workspace. CC agents follow a script; an agent connected to a real AI
          model writes a real brief. A checker can make mistakes: review the source yourself.
        </p>
      </section>
      {creating ? (
        <NewWorkflow
          snapshot={snapshot}
          refresh={refresh}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
        />
      ) : null}
      {selected ? (
        <WorkflowReview
          key={selected.id}
          workflow={selected}
          snapshot={snapshot}
          refresh={refresh}
          v2={v2}
        />
      ) : null}
      <section className="panel">
        <div className="panel-heading">
          <div className="panel-title">
            <FileText size={17} />
            <h2>Your collaborations</h2>
            <span className="small-tag">{workflows.length}</span>
          </div>
        </div>
        {workflows.length ? (
          <div className="collaboration-list">
            {workflows.map((item) => (
              <button
                key={item.id}
                className={`collaboration-row ${selectedId === item.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setCreating(false);
                }}
              >
                <ExchangeCircle state={workflowExchangeState(item.status)} size="small" />
                <div>
                  <strong>
                    {nameOf(item.researcherId)} <ArrowRight size={13} /> {nameOf(item.reviewerId)}
                  </strong>
                  <p>{item.source.slice(0, 110)}</p>
                  <small>{formatDate(item.createdAt)}</small>
                </div>
                <span className={`workflow-state state-${item.status}`}>{labels[item.status]}</span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState title="Your first shared result" live={v2}>
            Start with a source note, project brief or document excerpt. Every step will be recorded
            here.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function NewWorkflow({
  snapshot,
  refresh,
  onClose,
  onCreated,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const live = snapshot.agents.filter((agent) => agent.status !== 'revoked');
  const [requesterId, setRequester] = useState(
    () => live.find((agent) => agent.capability === 'extract')?.id ?? '',
  );
  const [researcherId, setResearcher] = useState(
    () => live.find((agent) => agent.capability === 'research')?.id ?? '',
  );
  const [reviewerId, setReviewer] = useState(
    () => live.find((agent) => agent.capability === 'verify')?.id ?? '',
  );
  // A paged workspace (src/agents/agentPages.ts) carries only some agents: each picker also
  // searches every agent of the workspace.
  const paged = Boolean(snapshot.agentsPage);
  const searchOf = (capability?: Agent['capability']) =>
    paged
      ? (q: string, signal: AbortSignal) =>
          searchLiveAgents(q, signal).then((found) =>
            capability ? found.filter((agent) => agent.capability === capability) : found,
          )
      : null;
  const requesters = useAgentPicker(live, searchOf(), [requesterId]);
  const researchers = useAgentPicker(
    live.filter((agent) => agent.capability === 'research'),
    searchOf('research'),
    [researcherId],
  );
  const reviewers = useAgentPicker(
    live.filter((agent) => agent.capability === 'verify'),
    searchOf('verify'),
    [reviewerId],
  );
  const agents = [
    ...new Map(
      [
        ...requesters.known.values(),
        ...researchers.known.values(),
        ...reviewers.known.values(),
      ].map((agent) => [agent.id, agent]),
    ).values(),
  ];
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ serialized: string; key: string } | null>(null);
  const distinct = Boolean(
    requesterId &&
    researcherId &&
    reviewerId &&
    new Set([requesterId, researcherId, reviewerId]).size === 3,
  );
  const routes = [
    { fromAgentId: requesterId, toAgentId: researcherId },
    { fromAgentId: researcherId, toAgentId: reviewerId },
  ];
  const missing = routes.filter(
    (route) =>
      !snapshot.connections.some(
        (connection) =>
          connection.fromAgentId === route.fromAgentId && connection.toAgentId === route.toAgentId,
      ),
  );
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'Select an agent';
  const external = [researcherId, reviewerId].some(
    (id) => agents.find((agent) => agent.id === id)?.mode === 'external',
  );
  async function authorize() {
    setBusy(true);
    setError('');
    try {
      for (const route of missing) await api('/api/connections', route);
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : "The agents couldn't be connected."} Any connection already made is listed under Connections.`,
      );
    } finally {
      await refresh();
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const values = { requesterId, researcherId, reviewerId, source: source.trim() };
    const serialized = JSON.stringify(values);
    if (attempt.current?.serialized !== serialized)
      attempt.current = { serialized, key: crypto.randomUUID() };
    try {
      const result = await api<WorkflowDetail>('/api/workflows', {
        ...values,
        idempotencyKey: attempt.current.key,
      });
      await refresh();
      onCreated(result.workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The collaboration couldn't start.");
    } finally {
      setBusy(false);
    }
  }
  const choices = (items: Agent[]) => (
    <>
      <option value="">Select an agent</option>
      {items.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name} · {agent.mode === 'hosted' ? 'CC agent' : 'external runtime'} ·{' '}
          {agent.status}
        </option>
      ))}
    </>
  );
  return (
    <section className="panel workflow-compose">
      <div className="panel-heading">
        <h2>Start a source brief</h2>
        <button className="text-link" onClick={onClose} disabled={busy}>
          Close setup
        </button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="workflow-agent-selects">
          <>
            <label>
              Requesting agent
              <select
                value={requesterId}
                disabled={busy}
                onChange={(event) => setRequester(event.target.value)}
                required
              >
                {choices(requesters.agents ?? [])}
              </select>
            </label>
            {requesters.field}
          </>
          <>
            <label>
              Research agent
              <select
                value={researcherId}
                disabled={busy}
                onChange={(event) => setResearcher(event.target.value)}
                required
              >
                {choices(researchers.agents ?? [])}
              </select>
            </label>
            {researchers.field}
          </>
          <>
            <label>
              Checking agent
              <select
                value={reviewerId}
                disabled={busy}
                onChange={(event) => setReviewer(event.target.value)}
                required
              >
                {choices(reviewers.agents ?? [])}
              </select>
            </label>
            {reviewers.field}
          </>
        </div>
        {!distinct ? (
          <p className="field-note">
            Choose three different agents, including a research specialist and a checking
            specialist. Create missing agents in Agents.
          </p>
        ) : null}
        {distinct && missing.length ? (
          <div className="workflow-permissions">
            <ShieldCheck size={20} />
            <div>
              <strong>Connect these agents</strong>
              <p>
                {missing
                  .map((route) => `${nameOf(route.fromAgentId)} → ${nameOf(route.toAgentId)}`)
                  .join(' · ')}
              </p>
              <p>
                The connections let these agents send each other work. They share no tools and
                nothing else in your workspace.
              </p>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={busy || snapshot.paused}
              onClick={() => void authorize()}
            >
              Connect
            </button>
          </div>
        ) : distinct ? (
          <p className="field-note">
            These agents are connected. You can remove the connections under Connections.
          </p>
        ) : null}
        <label>
          Source material
          <textarea
            value={source}
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
            maxLength={4000}
            rows={7}
            placeholder="Paste the material the brief must be based on. Include uncertainties and source references."
            required
          />
        </label>
        <div className="workflow-source-tools">
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => setSource(sampleSource)}
          >
            Use sample source
          </button>
          <span>{source.length.toLocaleString()} / 4,000 characters</span>
        </div>
        <div className="workflow-disclosure">
          <strong>What each agent receives</strong>
          <p>
            The researcher receives this source. After you review its draft and choose Send to
            checker, the checker receives the source and complete draft output.
          </p>
          <p>
            {external
              ? 'You chose an agent that runs on someone’s own computer. Only use one you trust with this text. Whoever runs it decides how it works and pays for any AI use; Central City has no control over that.'
              : 'Both agents are scripted demos. This shows how a collaboration works, without an AI model.'}
          </p>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="button primary"
          disabled={busy || snapshot.paused || !distinct || missing.length > 0 || !source.trim()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}Start brief
        </button>
      </form>
    </section>
  );
}

function WorkflowReview({
  workflow,
  snapshot,
  refresh,
  v2,
}: {
  workflow: Workflow;
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  v2: boolean;
}) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    setDetail(null);
    void api<WorkflowDetail>(`/api/workflows/${workflow.id}`)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((err) => {
        if (active)
          setError(err instanceof Error ? err.message : "The collaboration couldn't be loaded.");
      });
    return () => {
      active = false;
    };
  }, [workflow.id, workflow.updatedAt, reload]);
  async function act(action: 'check' | 'accept' | 'cancel') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await api<WorkflowDetail>(`/api/workflows/${workflow.id}/${action}`, {});
      setDetail(value);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!detail) return;
    const file = new Blob(
      [
        JSON.stringify(
          {
            format: 'central-city-collaboration',
            version: 1,
            exportedAt: new Date().toISOString(),
            ...detail,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `central-city-brief-${workflow.id}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const current = detail?.workflow ?? workflow;
  const finished = ['accepted', 'failed', 'canceled'].includes(current.status);
  return (
    <section className="panel workflow-review" aria-label="Collaboration review">
      <div className="panel-heading">
        <div className="panel-title">
          <ExchangeCircle state={workflowExchangeState(current.status)} size="small" />
          <h2>Collaboration record</h2>
        </div>
        <span className={`workflow-state state-${current.status}`}>{labels[current.status]}</span>
      </div>
      <div className="workflow-review-body">
        {v2 ? (
          <WorkflowSteps workflow={current} />
        ) : (
          <details className="workflow-source">
            <summary>Original source material</summary>
            <pre>{workflow.source}</pre>
          </details>
        )}
        {error ? (
          <div role="alert" className="form-error">
            {error}{' '}
            <button className="text-link" onClick={() => setReload((value) => value + 1)}>
              Reload record
            </button>
          </div>
        ) : null}
        {v2 ? (
          <div className="workflow-output-grid adv2-review-grid">
            <article className="workflow-result workflow-source-card">
              <h3>Original source material</h3>
              <pre>{workflow.source}</pre>
            </article>
            {detail ? (
              <>
                <ResultCard title="Research brief" job={detail.briefJob} />
                <ResultCard title="Source check" job={detail.checkJob} />
              </>
            ) : null}
          </div>
        ) : null}
        {!detail && !error ? (
          <p className="field-note" role="status">
            <LoaderCircle size={15} className="spin" />
            Loading the full record…
          </p>
        ) : null}
        {detail ? (
          <>
            {v2 ? null : (
              <div className="workflow-output-grid">
                <ResultCard title="Research brief" job={detail.briefJob} />
                <ResultCard title="Source check" job={detail.checkJob} />
              </div>
            )}
            {current.error ? (
              <p role="alert" className="form-error">
                {current.error}
              </p>
            ) : null}
            {current.status === 'awaiting_review' ? (
              <div className="workflow-gate">
                <strong>Review the draft first</strong>
                <p>
                  Read the brief above. Sending it to the checker shares the source and the full
                  draft with that agent. It does not accept the brief.
                </p>
                <button
                  className="button primary"
                  disabled={busy || snapshot.paused}
                  onClick={() => void act('check')}
                >
                  <ArrowRight size={16} />
                  Send to checker
                </button>
              </div>
            ) : null}
            {current.status === 'completed' ? (
              <div className="workflow-gate">
                <strong>The agents have finished. Your decision is next.</strong>
                <p>
                  Compare both results with the source. The checker gives an opinion, not proof.
                  Accept only when the work meets your needs.
                </p>
                <button
                  className="button primary"
                  disabled={busy || snapshot.paused}
                  onClick={() => void act('accept')}
                >
                  <CheckCheck size={16} />
                  Accept collaboration
                </button>
              </div>
            ) : null}
            {current.status === 'accepted' ? (
              <p className="workflow-accepted">
                <CheckCheck size={18} />
                You accepted this collaboration. Its source and both results are kept.
              </p>
            ) : null}
            {current.status === 'briefing' || current.status === 'checking' ? (
              <p className="field-note">
                Waiting for the agent to finish. An agent on someone's own computer must be running.
              </p>
            ) : null}
          </>
        ) : null}
        <div className="workflow-actions">
          <button className="button secondary" disabled={!detail || busy} onClick={download}>
            <Download size={15} />
            Download record
          </button>
          {!finished ? (
            <button
              className="button danger"
              disabled={busy || !detail}
              onClick={() => void act('cancel')}
            >
              <Square size={13} />
              Cancel collaboration
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ResultCard({ title, job }: { title: string; job: Job | null }) {
  const output = job?.output;
  const modelResult = output?.execution === 'local-language-model';
  return (
    <article className="workflow-result">
      <h3>{title}</h3>
      {!job ? (
        <p className="field-note">
          Waiting for your draft review. Nothing has been sent to the checker.
        </p>
      ) : (
        <>
          <p className="field-note">
            {statusLabels[job.status] ?? job.status} ·{' '}
            {job.isDemo ? 'CC agent' : 'Agent on its own computer'} ·{' '}
            {job.costCents === null
              ? 'Cost not tracked'
              : `${(job.costCents / 100).toFixed(2)} USD recorded`}
          </p>
          {job.output ? (
            <>
              {modelResult ? (
                <div className="model-result">
                  <p className="small-tag">
                    Local AI · {String(output.model ?? 'model not named')}
                  </p>
                  {typeof output.title === 'string' ? <h4>{output.title}</h4> : null}
                  {typeof output.summary === 'string' ? <p>{output.summary}</p> : null}
                  {Array.isArray(output.keyPoints) ? (
                    <ul>
                      {output.keyPoints
                        .filter((point): point is string => typeof point === 'string')
                        .map((point, index) => (
                          <li key={index}>{point}</li>
                        ))}
                    </ul>
                  ) : null}
                  {typeof output.verdict === 'string' ? (
                    <h4>Assessment: {output.verdict.replaceAll('-', ' ')}</h4>
                  ) : null}
                  {Array.isArray(output.checks)
                    ? output.checks.map((check, index) => {
                        if (!check || typeof check !== 'object') return null;
                        const item = check as Record<string, unknown>;
                        return (
                          <div className="model-check" key={index}>
                            <strong>{String(item.claim ?? '')}</strong>
                            <p>
                              {String(item.assessment ?? '')}: {String(item.reason ?? '')}
                            </p>
                            {typeof item.supportingQuote === 'string' && item.supportingQuote ? (
                              <blockquote>{item.supportingQuote}</blockquote>
                            ) : null}
                          </div>
                        );
                      })
                    : null}
                  {Array.isArray(output.sourceQuotes)
                    ? output.sourceQuotes
                        .filter((quote): quote is string => typeof quote === 'string')
                        .map((quote, index) => <blockquote key={index}>{quote}</blockquote>)
                    : null}
                  {Array.isArray(output.limitations) ? (
                    <p className="field-note">
                      {output.limitations
                        .filter((item): item is string => typeof item === 'string')
                        .join(' ')}
                    </p>
                  ) : null}
                  <p className="field-note">
                    The AI model's own assessment of the text it was given. Its cost is not tracked.
                  </p>
                </div>
              ) : null}
              {modelResult ? (
                <details>
                  <summary>Raw data</summary>
                  <pre aria-label={`${title} raw data`}>{JSON.stringify(job.output, null, 2)}</pre>
                </details>
              ) : (
                <ReadableData data={job.output} label={title} />
              )}
            </>
          ) : (
            <p>{job.error ?? 'No result yet.'}</p>
          )}
        </>
      )}
    </article>
  );
}
