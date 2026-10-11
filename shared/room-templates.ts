import { findTaskTemplate, taskTemplateBody } from './task-templates.js';

/**
 * Built-in room templates (docs/ROOMS.md "Room templates"). A template only prefills a new room:
 * its name, a one-line purpose (the room topic) and a few starter tasks, plus suggestions of who
 * to invite. It never creates agents and never invites anyone: the host uses the room's own
 * Invite and Connect AI actions. Templates live in code, not in the database. A template version
 * is immutable: changing the wording means publishing a new version, so a room's recorded
 * `template: {id, version}` always points at the same text. Shared by the server (REST and MCP)
 * and the New room dialog.
 */

/** Who to invite: an AI (Connect AI) or a person (Invite). */
export type RoomInviteKind = 'ai' | 'person';

export interface RoomTemplateInvite {
  kind: RoomInviteKind;
  /** Short label, for example "A coding AI". */
  label: string;
  /** One line: what this member does in the room. */
  reason: string;
}

export interface RoomStarterTask {
  /** 1 to 200 characters. */
  title: string;
  /**
   * A built-in task template (shared/task-templates.ts) whose body the task takes; the task
   * records it as its template. Without one, `body` is used.
   */
  task_template_id?: string;
  body?: string;
}

export interface RoomTemplate {
  /** Lowercase letters, digits and hyphens. */
  id: string;
  /** Semantic version; content never changes within a version. */
  version: string;
  name: string;
  /** One line: what the template is for. */
  purpose: string;
  /** The default room name ('' for Blank: the caller names the room). */
  room_name: string;
  /** The default room topic: one line on what the room is for ('' for Blank). */
  topic: string;
  starter_tasks: RoomStarterTask[];
  invites: RoomTemplateInvite[];
}

export const ROOM_TEMPLATE_CATALOG_VERSION = '1.0.0';

/** The template that prefills nothing (the New room dialog's default). */
export const BLANK_ROOM_TEMPLATE_ID = 'blank';

const PERSON = (reason: string): RoomTemplateInvite => ({
  kind: 'person',
  label: 'A person',
  reason,
});

const SOURCES: RoomTemplate[] = [
  {
    id: 'product-team',
    version: '1.0.0',
    name: 'Product team',
    purpose: 'Plan, build and ship product changes together.',
    room_name: 'Product team',
    topic: 'Plan, build and ship product changes together.',
    starter_tasks: [
      {
        title: 'Write the product brief',
        body: '## Problem\nWho has it and why it matters.\n\n## Goal\nWhat changes for users when this ships.\n\n## Scope\nWhat is in and what is out.\n',
      },
      { title: 'Test plan: first feature', task_template_id: 'test-plan' },
      { title: 'Launch: first release', task_template_id: 'launch-checklist' },
    ],
    invites: [
      { kind: 'ai', label: 'A coding AI', reason: 'Builds features and fixes from the tasks.' },
      { kind: 'ai', label: 'A reviewer AI', reason: 'Reviews changes before they ship.' },
      PERSON('Sets priorities and approves results.'),
    ],
  },
  {
    id: 'research-squad',
    version: '1.0.0',
    name: 'Research squad',
    purpose: 'Answer questions with sources and a stated confidence.',
    room_name: 'Research squad',
    topic: 'Answer questions with sources and a stated confidence.',
    starter_tasks: [
      { title: 'Research: first question', task_template_id: 'research-question' },
      {
        title: 'Collect sources',
        body: '## Topic\nWhat the sources should cover.\n\n## Sources\nEach source with a link and one line on what it covers.\n',
      },
      { title: 'Draft: summary of findings', task_template_id: 'writing-draft' },
    ],
    invites: [
      { kind: 'ai', label: 'A research AI', reason: 'Finds and reads sources.' },
      { kind: 'ai', label: 'A reviewer AI', reason: 'Checks claims against the sources.' },
      PERSON('Sets the questions and uses the answers.'),
    ],
  },
  {
    id: 'writing-room',
    version: '1.0.0',
    name: 'Writing room',
    purpose: 'Draft, edit and finish texts for a stated audience.',
    room_name: 'Writing room',
    topic: 'Draft, edit and finish texts for a stated audience.',
    starter_tasks: [
      {
        title: 'Outline the piece',
        body: '## Audience\nWho reads it.\n\n## Outline\nThe sections in order, one line each.\n',
      },
      { title: 'Draft: first version', task_template_id: 'writing-draft' },
      {
        title: 'Edit pass',
        body: '## Draft\nLink or task number of the draft.\n\n## Focus\nClarity, length, tone or facts.\n',
      },
    ],
    invites: [
      { kind: 'ai', label: 'A writing AI', reason: 'Drafts and revises the text.' },
      { kind: 'ai', label: 'An editing AI', reason: 'Edits for clarity and checks facts.' },
      PERSON('Writes the brief and approves the final text.'),
    ],
  },
  {
    id: 'code-review-crew',
    version: '1.0.0',
    name: 'Code review crew',
    purpose: 'Review changes and triage bugs before they ship.',
    room_name: 'Code review crew',
    topic: 'Review changes and triage bugs before they ship.',
    starter_tasks: [
      { title: 'Code review: first change', task_template_id: 'code-review' },
      { title: 'Bug triage: open reports', task_template_id: 'bug-triage' },
    ],
    invites: [
      { kind: 'ai', label: 'A coding AI', reason: 'Makes changes and fixes findings.' },
      { kind: 'ai', label: 'A reviewer AI', reason: 'Reviews each change and gives a verdict.' },
      PERSON('Owns the code and merges approved changes.'),
    ],
  },
  {
    id: BLANK_ROOM_TEMPLATE_ID,
    version: '1.0.0',
    name: 'Blank',
    purpose: 'An empty room: you name it and add tasks yourself.',
    room_name: '',
    topic: '',
    starter_tasks: [],
    invites: [],
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The catalog in display order (Blank last). */
export const ROOM_TEMPLATES: readonly RoomTemplate[] = deepFreeze(SOURCES);

export function findRoomTemplate(id: string): RoomTemplate | undefined {
  return ROOM_TEMPLATES.find((template) => template.id === id);
}

/** A starter task as it is created: its title, body and the task template it records, if any. */
export function starterTaskInput(task: RoomStarterTask): {
  title: string;
  body: string;
  template: { id: string; version: string } | null;
} {
  const template = task.task_template_id ? findTaskTemplate(task.task_template_id) : undefined;
  return {
    title: task.title,
    body: template ? taskTemplateBody(template) : (task.body ?? ''),
    template: template ? { id: template.id, version: template.version } : null,
  };
}

/** "a coding AI, a reviewer AI and a person": the invite labels as one phrase. */
export function inviteSummary(invites: readonly RoomTemplateInvite[]): string {
  const labels = invites.map(
    (invite) => invite.label.charAt(0).toLowerCase() + invite.label.slice(1),
  );
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** A template as the REST route and the MCP tool return it. */
export interface RoomTemplateView extends RoomTemplate {
  /** The starter tasks as they would be created (title, Markdown body, task template). */
  starter_tasks: Array<RoomStarterTask & { body: string }>;
}

export function roomTemplateView(template: RoomTemplate): RoomTemplateView {
  return {
    ...template,
    starter_tasks: template.starter_tasks.map((task) => ({
      ...task,
      body: starterTaskInput(task).body,
    })),
    invites: template.invites.map((invite) => ({ ...invite })),
  };
}
