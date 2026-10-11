/**
 * Built-in room task templates (docs/ROOM_TASKS.md "Templates"). A template only prefills a
 * normal task: a title prefix, a Markdown body with sections, and an acceptance-criteria
 * checklist. Templates live in code, not in the database. A template version is immutable:
 * changing the wording means publishing a new version, so a task's recorded
 * `template: {id, version}` always points at the same text. Shared by the server (REST and MCP)
 * and the room's task form.
 */

export interface TaskTemplateSection {
  heading: string;
  /** One line under the heading that says what belongs there. */
  hint: string;
}

export interface TaskTemplate {
  /** Lowercase letters, digits and hyphens. */
  id: string;
  /** Semantic version; content never changes within a version. */
  version: string;
  name: string;
  /** One line: what the template is for. */
  purpose: string;
  /** Prefixed to the task title (the default title is the name). */
  title_prefix: string;
  sections: TaskTemplateSection[];
  /** Rendered as a Markdown checklist under "Acceptance criteria". */
  criteria: string[];
}

export const TASK_TEMPLATE_CATALOG_VERSION = '1.0.0';

const SOURCES: TaskTemplate[] = [
  {
    id: 'code-review',
    version: '1.0.0',
    name: 'Code review',
    purpose: 'Review a change and report findings with a clear verdict.',
    title_prefix: 'Code review: ',
    sections: [
      { heading: 'Change', hint: 'Link, branch or commit to review.' },
      { heading: 'Scope', hint: 'Files or areas to focus on, and what is out of scope.' },
      { heading: 'Context', hint: 'What the change is meant to do.' },
    ],
    criteria: [
      'Every changed file in scope was read.',
      'Each finding names the file and line.',
      'Each finding is marked blocking or non-blocking.',
      'The state of tests and checks is stated.',
      'The result ends with a verdict: approve or request changes.',
    ],
  },
  {
    id: 'bug-triage',
    version: '1.0.0',
    name: 'Bug triage',
    purpose: 'Reproduce a reported bug, rate its severity and propose a next step.',
    title_prefix: 'Bug triage: ',
    sections: [
      { heading: 'Report', hint: 'What was reported, with a link if there is one.' },
      { heading: 'Steps to reproduce', hint: 'Known steps, if any.' },
      { heading: 'Expected and actual', hint: 'What should happen and what happens instead.' },
      { heading: 'Environment', hint: 'Version, platform, browser or device.' },
    ],
    criteria: [
      'The bug is reproduced, or marked not reproducible with the steps tried.',
      'Severity is set: low, medium, high or critical.',
      'Known duplicates are checked and linked.',
      'The likely affected area is named.',
      'A next step is proposed: fix, more information or close.',
    ],
  },
  {
    id: 'research-question',
    version: '1.0.0',
    name: 'Research question',
    purpose: 'Answer one question with sources and a stated confidence.',
    title_prefix: 'Research: ',
    sections: [
      { heading: 'Question', hint: 'One question, stated precisely.' },
      { heading: 'Why it matters', hint: 'The decision the answer feeds.' },
      { heading: 'Scope', hint: 'Time frame, regions, sources to include or exclude.' },
    ],
    criteria: [
      'The first paragraph answers the question directly.',
      'Every factual claim links a source.',
      'A confidence level is stated: low, medium or high.',
      'Open questions and gaps are listed.',
      'The answer stays within the stated scope.',
    ],
  },
  {
    id: 'writing-draft',
    version: '1.0.0',
    name: 'Writing draft',
    purpose: 'Draft a text for a stated audience, length and format.',
    title_prefix: 'Draft: ',
    sections: [
      { heading: 'Purpose', hint: 'What the text should achieve.' },
      { heading: 'Audience', hint: 'Who reads it.' },
      { heading: 'Key points', hint: 'What it must cover.' },
      { heading: 'Length and format', hint: 'For example 300 words, Markdown, email.' },
    ],
    criteria: [
      'Every key point is covered.',
      'The length and format match the brief.',
      'Facts and figures are checked, with sources where needed.',
      'The text is proofread.',
    ],
  },
  {
    id: 'launch-checklist',
    version: '1.0.0',
    name: 'Launch checklist',
    purpose: 'Confirm a release is ready to ship and can be rolled back.',
    title_prefix: 'Launch: ',
    sections: [
      { heading: 'What launches', hint: 'Feature, version or page.' },
      { heading: 'Date', hint: 'Planned launch date and time, with time zone.' },
      { heading: 'Rollback', hint: 'How to undo the launch.' },
      { heading: 'Dependencies', hint: 'Other work that must land first.' },
    ],
    criteria: [
      'Tests and checks pass on the release build.',
      'Docs and the changelog are updated.',
      'Monitoring covers the change.',
      'Rollback steps are written down and tried.',
      'The announcement is ready.',
      'A go or no-go decision is recorded.',
    ],
  },
  {
    id: 'test-plan',
    version: '1.0.0',
    name: 'Test plan',
    purpose: 'Write and run test cases for a feature and record the results.',
    title_prefix: 'Test plan: ',
    sections: [
      { heading: 'Feature', hint: 'What is under test, with a link.' },
      { heading: 'Risks', hint: 'What is most likely to break.' },
      { heading: 'Environments', hint: 'Platforms, browsers or devices to cover.' },
    ],
    criteria: [
      'Cases cover the main path and the edge cases.',
      'Each case has steps and an expected result.',
      'Each case is recorded as pass or fail.',
      'Each failure links a bug report.',
    ],
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The catalog in display order. */
export const TASK_TEMPLATES: readonly TaskTemplate[] = deepFreeze(SOURCES);

export function findTaskTemplate(id: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((template) => template.id === id);
}

/** The Markdown body a template prefills: its sections, then the acceptance-criteria checklist. */
export function taskTemplateBody(template: TaskTemplate): string {
  const sections = template.sections.map((section) => `## ${section.heading}\n${section.hint}\n`);
  const criteria = template.criteria.map((item) => `- [ ] ${item}`).join('\n');
  return `${sections.join('\n')}\n## Acceptance criteria\n${criteria}\n`;
}

/** A template as the REST route and the MCP tool return it: the data plus the rendered body. */
export interface TaskTemplateView extends TaskTemplate {
  body: string;
}

export function taskTemplateView(template: TaskTemplate): TaskTemplateView {
  return {
    ...template,
    sections: template.sections.map((section) => ({ ...section })),
    criteria: [...template.criteria],
    body: taskTemplateBody(template),
  };
}
