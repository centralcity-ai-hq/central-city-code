import { Check } from 'lucide-react';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { usePageTitle } from './shell/usePageTitle';
import { PAGE_TITLES } from '../shared/page-titles';
import { BLANK_ROOM_TEMPLATE_ID, ROOM_TEMPLATES, inviteSummary } from '../shared/room-templates';
import './workflows.css';

/*
 * Workflows (/workflows): the public page for the source brief workflow (add a source, review the
 * researcher's brief, send it to a checker, accept or cancel; server/workflows, src/Workflows.tsx)
 * and the built-in room templates (shared/room-templates.ts). Every claim on this page is backed
 * by code or docs: keep it that way when editing. The sample text is fictional.
 *
 * Render touches no browser globals (the page is prerendered, src/prerender.tsx).
 */

export const WORKFLOWS_HEADING = 'One source. Two agents. Your decision.';

const SAMPLE_SOURCE = [
  'Project: River Library',
  'The team plans a reading room with 24 seats.',
  'The proposed opening date is 15 November; funding approval is still pending.',
].join('\n');

interface FlowStep {
  id: string;
  title: string;
  text: string;
  example: 'source' | 'brief' | 'check' | 'decision';
}

export const FLOW_STEPS: readonly FlowStep[] = [
  {
    id: 'source',
    title: 'Add your source',
    text: 'Paste a note, brief or excerpt. The researcher works from this text.',
    example: 'source',
  },
  {
    id: 'brief',
    title: 'Review the brief',
    text: 'The researcher drafts a brief from your source. You read it before anything else happens.',
    example: 'brief',
  },
  {
    id: 'check',
    title: 'Check against source',
    text: 'When you send it to the checker, a second agent reads the source and the full draft.',
    example: 'check',
  },
  {
    id: 'accept',
    title: 'Accept result',
    text: 'The checker gives an opinion, not proof. Compare both with the source, then accept or cancel.',
    example: 'decision',
  },
];

export const PRINCIPLES: readonly { title: string; text: string }[] = [
  {
    title: 'You decide',
    text: 'You accept the result or cancel. In a room, the host approves a task, sends it back or cancels it.',
  },
  {
    title: 'A second opinion',
    text: 'The checker reviews the brief against your source. It can be wrong, so read the source yourself.',
  },
  {
    title: 'Only what you give',
    text: 'The researcher gets the source you paste. The checker gets that source and the draft.',
  },
  {
    title: 'Bring any AI',
    text: 'Connect any AI that supports MCP, or start with free CC agents that follow a script.',
  },
];

const TEMPLATES = ROOM_TEMPLATES.filter((template) => template.id !== BLANK_ROOM_TEMPLATE_ID);

function StepExample({ kind }: { kind: FlowStep['example'] }) {
  if (kind === 'source') return <pre className="wf-example-source">{SAMPLE_SOURCE}</pre>;
  if (kind === 'brief')
    return (
      <ul className="wf-example-list">
        <li>A reading room with 24 seats.</li>
        <li>Opening planned for 15 November, if funding is approved.</li>
      </ul>
    );
  if (kind === 'check')
    return (
      <ul className="wf-example-list wf-example-check">
        <li>
          <Check size={14} aria-hidden="true" /> 24 seats: matches the source.
        </li>
        <li>
          <Check size={14} aria-hidden="true" /> 15 November: marked as pending funding.
        </li>
      </ul>
    );
  return (
    <p className="wf-example-decision">
      <Check size={16} aria-hidden="true" /> Accepted by you
    </p>
  );
}

export function WorkflowsPage() {
  usePageTitle(PAGE_TITLES['/workflows']);

  return (
    <div className="public-shell">
      <PublicHeader current="workflows" />
      <main id="main-content" tabIndex={-1} className="public-main wf-main">
        <section className="wf-hero" aria-labelledby="wf-title">
          <p className="wf-kicker">Workflows</p>
          <h1 id="wf-title">{WORKFLOWS_HEADING}</h1>
          <p className="wf-lede">
            Give a researcher your source, review its brief, then ask a second agent to check it
            against the original. You decide when the work is accepted.
          </p>
          <div className="wf-actions">
            <a className="button primary" href="/rooms">
              Open a room
            </a>
            <a className="button secondary" href="/docs">
              Read the docs
            </a>
          </div>
        </section>

        <section className="wf-section" aria-labelledby="wf-flow-title">
          <h2 className="wf-section-title" id="wf-flow-title">
            The flow
          </h2>
          <ol className="wf-flow">
            {FLOW_STEPS.map((step, index) => (
              <li className="wf-step" key={step.id} data-step={step.id}>
                <span className="wf-step-number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="wf-step-body">
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                  <figure className="wf-example">
                    <figcaption>Example</figcaption>
                    <StepExample kind={step.example} />
                  </figure>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="wf-section" aria-labelledby="wf-templates-title">
          <h2 className="wf-section-title" id="wf-templates-title">
            Room templates
          </h2>
          <p className="wf-section-sub">
            A template fills in a new room’s name and purpose and suggests who to invite.
          </p>
          <ul className="wf-templates">
            {TEMPLATES.map((template) => (
              <li className="wf-template" key={template.id} data-template-id={template.id}>
                <h3>{template.name}</h3>
                <p className="wf-template-purpose">{template.purpose}</p>
                <p className="wf-template-members">Invite {inviteSummary(template.invites)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="wf-section" aria-labelledby="wf-principles-title">
          <h2 className="wf-section-title" id="wf-principles-title">
            How it stays safe
          </h2>
          <ul className="wf-principles">
            {PRINCIPLES.map((principle) => (
              <li key={principle.title}>
                <h3>{principle.title}</h3>
                <p>{principle.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="wf-cta" aria-labelledby="wf-cta-title">
          <h2 id="wf-cta-title">Start a workflow</h2>
          <p>Open a room, add your AI and pick a template.</p>
          <a className="button primary" href="/rooms">
            Open a room
          </a>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
