import type { ConnectionRequest } from '../../../shared/assistant';
import type { Agent, Snapshot } from '../../../shared/types';
import { ApiError } from '../../api';
import { KEY_CHECK_TIMEOUT_MS, ResponderError, type ResponderClient } from '../../responder/api';
import type { SheetSend } from '../../responder/AutoReply';
import type {
  ModelOption,
  ResponderKeyView,
  ResponderSettingsView,
} from '../../responder/contract';
import { withoutKey, type PermissionRow } from './settingsActionsModel';
import { snapshotPath } from '../agentPages';
import {
  SETTINGS_READ_DEADLINE_MS,
  StaleRunError,
  isStale,
  type SettingsLifecycle,
  type SettingsRun,
} from './settingsLifecycle';

/*
 * What the v4 settings screens read and send, on the shared lifecycle (settingsLifecycle.ts):
 * every request goes through the screen's run, so it is sent for the run's own agent and
 * workspace and stops once the screen has moved on. No React here.
 */

/* ---------- Reads ---------- */

/**
 * The owner's snapshot (GET /api/snapshot): agents with their key hint, lineage and connections.
 * A paged workspace (src/agents/agentPages.ts) is asked to include the run's agent.
 */
export const readSnapshot = (run: SettingsRun) =>
  run.api<Snapshot>(snapshotPath(run.workspace, [run.agentId]), undefined, 'GET');

/** Rotate key and Connect an agent read the snapshot only. */
export const SNAPSHOT_READS = { snapshot: readSnapshot } as const;

const CROSS = '/api/v2/connections/requests';
/** Pages of 100 per direction; stops here so a read always ends. */
const MAX_PAGES = 20;

export type PermissionsData = { snapshot: Snapshot; cross: ConnectionRequest[] };

/** Every approved connection with other owners, both directions, all pages. */
async function readCross(run: SettingsRun): Promise<ConnectionRequest[]> {
  const all: ConnectionRequest[] = [];
  for (const direction of ['incoming', 'outgoing'] as const) {
    let before: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ direction, status: 'approved', limit: '100' });
      if (before) query.set('before', before);
      const result: {
        incoming?: ConnectionRequest[];
        outgoing?: ConnectionRequest[];
        next_before: string | null;
      } = await run.api(`${CROSS}?${query}`, undefined, 'GET');
      all.push(...(result[direction] ?? []));
      before = result.next_before;
      if (!before) break;
    }
  }
  return all;
}

export async function readPermissions(run: SettingsRun): Promise<PermissionsData> {
  const [snapshot, cross] = await Promise.all([readSnapshot(run), readCross(run)]);
  return { snapshot, cross };
}

export const PERMISSIONS_READS = { permissions: readPermissions } as const;

export type AutoReplyData = {
  settings: ResponderSettingsView | null;
  notFound: boolean;
  /** What the setup sheet offers (GET /api/responder/models); none where auto-reply isn't. */
  models: ModelOption[];
};

/** The responder settings route of the run's agent (docs/RESPONDER.md). */
const responderPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/responder`;

export async function readAutoReply(run: SettingsRun): Promise<AutoReplyData> {
  let settings: ResponderSettingsView;
  try {
    settings = await run.api<ResponderSettingsView>(responderPath(run.agentId), undefined, 'GET');
  } catch (error) {
    // The routes exist only where auto-reply is offered.
    if (error instanceof ApiError && error.status === 404)
      return { settings: null, notFound: true, models: [] };
    throw error;
  }
  const { models } = await run.api<{ models: ModelOption[] }>(
    '/api/responder/models',
    undefined,
    'GET',
  );
  return { settings, notFound: false, models: models ?? [] };
}

export const AUTO_REPLY_READS = { autoReply: readAutoReply } as const;

/** A failed responder request in plain words (its fixed codes; server text is never shown). */
export function responderFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'This took too long.';
  if (error instanceof ApiError) {
    // The key is set up on this screen now, never in the agent's settings.
    if (error.code === 'key_required') return 'Set up auto-reply with a working key first.';
    if (error.code === 'model_not_allowed') return 'Choose one of the listed models.';
    if (error.code === 'human_required') return 'Only the owner, signed in, can change auto-reply.';
    if (error.code === 'rate_limited' || error.status === 429)
      return 'Too many attempts. Wait a while, then try again.';
    if (error.code === 'responder_unavailable')
      return 'Auto-reply isn’t available right now. Try again later.';
    return 'Something went wrong. Try again.';
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return 'You’re offline. Check your connection, then try again.';
  return 'Something went wrong. Try again.';
}

/* ---------- Actions (each one the screen's one action at a time) ---------- */

/** POST /api/agents/:id/rotate-credential; the new key is shown once, on this run only. */
export function rotateKey(controller: SettingsLifecycle, generation: number): Promise<void> {
  return controller.act(
    'rotate',
    async (run) => {
      const result = await run.api<{ agent: Agent; token: string }>(
        `/api/agents/${encodeURIComponent(run.agentId)}/rotate-credential`,
        {},
      );
      controller.reveal(run, result.token);
    },
    generation,
  );
}

/** PUT /api/agents/:id/responder {enabled}; the answer replaces what the switch shows. */
export function setAutoReply(
  controller: SettingsLifecycle,
  enabled: boolean,
  generation: number,
): Promise<void> {
  return controller.act(
    'save',
    async (run) => {
      const settings = await run.api<ResponderSettingsView>(
        responderPath(run.agentId),
        { enabled },
        'PUT',
      );
      controller.updateLoad<AutoReplyData>(run, 'autoReply', (data) => ({
        ...data,
        settings,
        notFound: false,
      }));
    },
    generation,
  );
}

/**
 * After a change, the settings as the server has them now (GET), in the same run. A re-read that
 * fails or takes too long keeps what the change's own answer showed, which the server confirmed.
 */
async function rereadSettings(controller: SettingsLifecycle, run: SettingsRun): Promise<void> {
  try {
    const settings = await run.api<ResponderSettingsView>(
      responderPath(run.agentId),
      undefined,
      'GET',
      { timeoutMs: SETTINGS_READ_DEADLINE_MS },
    );
    controller.updateLoad<AutoReplyData>(run, 'autoReply', (data) => ({ ...data, settings }));
  } catch (error) {
    if (isStale(error)) throw error;
  }
}

/** A responder request's failure as the sheet reads it: the code only (src/responder/api.ts). */
async function responderCall<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (isStale(error)) throw error;
    if (error instanceof ApiError)
      throw new ResponderError(
        error.code ?? (error.status === 429 ? 'rate_limited' : ''),
        error.status,
      );
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new ResponderError('timeout', 0);
    throw new ResponderError(
      typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'network',
      0,
    );
  }
}

/**
 * The setup sheet's requests as requests of one run: for the run's agent only, in the run's
 * workspace (X-City-Workspace, apiInWorkspace), the key check given up after
 * KEY_CHECK_TIMEOUT_MS like the agent settings' own client. `steps.key` says the server took a key.
 */
function responderClientOf(run: SettingsRun, steps: { key: boolean }): ResponderClient {
  const path = (agentId: string) => {
    // The sheet belongs to the run's generation, so it names the run's agent; anything else is
    // refused before it is sent.
    if (agentId !== run.agentId) throw new StaleRunError();
    return responderPath(agentId);
  };
  return {
    saveKey: async (agentId, body) => {
      const saved = await responderCall(() =>
        run.api<{ key: ResponderKeyView }>(`${path(agentId)}/key`, body, 'POST', {
          timeoutMs: KEY_CHECK_TIMEOUT_MS,
        }),
      );
      steps.key = true;
      return saved;
    },
    updateSettings: (agentId, body) =>
      responderCall(() => run.api<ResponderSettingsView>(path(agentId), body, 'PUT')),
  };
}

/**
 * The setup sheet (AutoReplySheet: Set up auto-reply, Change key) as the screen's one action. Its
 * requests (the key, then the settings) go through one run: for the screen's agent, in the
 * workspace the action started in, and none of them is sent once the screen has moved on (another
 * agent or workspace, also coming back to this one, or closed). What was saved replaces what the
 * screen shows, which then reads the settings again. A failure goes back to the sheet, which says
 * it in its own words (when the key was taken but the settings step failed, the screen reads the
 * settings again first, so it shows the saved key behind the sheet); a late answer is dropped.
 * Resolves to null when the action did not start (another one is on its way, or the sheet belongs
 * to an older generation) or did not finish here: the sheet hears of a save or a failure only
 * while the run is still live once its last request (the re-read included) has ended.
 */
export function autoReplySheetSend(controller: SettingsLifecycle, generation: number): SheetSend {
  return async (work, done) => {
    const result: { saved?: ResponderSettingsView; failed?: boolean; failure?: unknown } = {};
    // Whether the action's run is still live; never, when the action did not start.
    let liveAtEnd = () => false;
    await controller.act(
      'sheet',
      async (run) => {
        liveAtEnd = () => run.live();
        const steps = { key: false };
        let saved: ResponderSettingsView;
        try {
          saved = await work(responderClientOf(run, steps));
        } catch (failure) {
          // Nothing of a run that ended is said.
          if (isStale(failure) || !run.live()) return;
          if (steps.key) await rereadSettings(controller, run);
          result.failed = true;
          result.failure = failure;
          return;
        }
        const landed = controller.updateLoad<AutoReplyData>(run, 'autoReply', (data) => ({
          ...data,
          settings: saved,
          notFound: false,
        }));
        if (!landed) return;
        result.saved = saved;
        controller.notify(run, done);
        await rereadSettings(controller, run);
      },
      generation,
    );
    // The screen moved on while the re-read was on its way (closed, another workspace, also
    // A to B to A): the sheet's run is over, so it hears nothing more, neither the save nor a
    // failure.
    if (!liveAtEnd()) return null;
    if (result.failed) throw result.failure;
    return result.saved ?? null;
  };
}

/**
 * Remove key: DELETE /api/agents/:id/responder/key, then the settings read again, both for the
 * run's agent and workspace. The DELETE's answer already means auto-reply is off with no key, so
 * the screen shows that at once and keeps it when the re-read fails. The DELETE carries a JSON
 * body, as the console's other DELETEs do, so it has the request-protection header. `done` (close
 * the confirmation) runs only while the screen is still on it.
 */
export function removeAutoReplyKey(
  controller: SettingsLifecycle,
  generation: number,
  done: () => void,
): Promise<void> {
  return controller.act(
    'remove',
    async (run) => {
      await run.api(`${responderPath(run.agentId)}/key`, {}, 'DELETE');
      controller.updateLoad<AutoReplyData>(run, 'autoReply', (data) => ({
        ...data,
        settings: data.settings && withoutKey(data.settings),
      }));
      run.commit(done);
      controller.notify(run, 'Key removed. Auto-reply is off.');
      await rereadSettings(controller, run);
    },
    generation,
  );
}

/**
 * Turning a permission row off (owner decision G7) removes its connections one by one: DELETE
 * /api/connections/:id, then POST /api/v2/connections/requests/:id/revoke. All of them go for the
 * workspace the row was shown in; once the screen moves on (another agent or workspace, or closed)
 * the rest are not sent. Whatever ended is gone from the list, also when a later request failed.
 */
export function turnOffPermission(
  controller: SettingsLifecycle,
  row: PermissionRow,
  generation: number,
): Promise<void> {
  return controller.act(
    row.key,
    async (run) => {
      const gone = new Set<string>();
      try {
        for (const id of row.local) {
          await run.api(`/api/connections/${encodeURIComponent(id)}`, {}, 'DELETE');
          gone.add(id);
        }
        for (const id of row.cross) {
          await run.api(`${CROSS}/${encodeURIComponent(id)}/revoke`, {});
          gone.add(id);
        }
        controller.notify(run, `${row.name} removed`);
      } finally {
        if (gone.size)
          controller.updateLoad<PermissionsData>(run, 'permissions', (data) => ({
            snapshot: {
              ...data.snapshot,
              connections: data.snapshot.connections.filter((item) => !gone.has(item.id)),
            },
            cross: data.cross.filter((item) => !gone.has(item.id)),
          }));
      }
    },
    generation,
  );
}

/**
 * "Connect an agent": lets your agent `fromAgentId` ask the run's agent for work (POST
 * /api/connections). `done` (back to Permissions) runs only while the screen is still on it.
 */
export function connectAgent(
  controller: SettingsLifecycle,
  fromAgentId: string,
  generation: number,
  done: () => void,
): Promise<void> {
  return controller.act(
    fromAgentId,
    async (run) => {
      await run.api('/api/connections', { fromAgentId, toAgentId: run.agentId });
      run.commit(done);
    },
    generation,
  );
}
