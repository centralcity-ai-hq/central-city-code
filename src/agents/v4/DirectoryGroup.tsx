import { useEffect, useState } from 'react';
import { api } from '../../api';
import { DIRECTORY_PATHS, INVITE_PATHS, type DirectorySettings } from '../../../shared/directory';

/*
 * "Room invitations" on a final Base agent's Base screen: whether a room may invite the agent by
 * its passport number (Ask) or not (Don't accept). There is no directory listing any more (the
 * product owner, 12 Oct). GET/PATCH /api/agents/:id/directory (its invitations field). A server
 * without the route, or a read that fails, shows nothing here.
 */

type Load =
  { phase: 'loading' } | { phase: 'ready'; settings: DirectorySettings } | { phase: 'none' };

const pathOf = (agentId: string) =>
  DIRECTORY_PATHS.settings.replace(':agentId', encodeURIComponent(agentId));

/** The server's words for a refused change, else a plain sentence. */
function problemOf(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  return message || "That didn't go through. Try again.";
}

/** One blocked owner, as GET /api/agents/:id/invitation-blocks lists it (newest first). */
type Block = {
  invitationId: string;
  from: { name: string; baseId: string | null; short: string | null };
  blockedAt: number;
};

const blocksPath = (agentId: string) =>
  INVITE_PATHS.block.replace(':agentId', encodeURIComponent(agentId));

const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/**
 * "Blocked owners": the owners you blocked from inviting your agents (from an invitation's
 * "Block this owner"), each with Unblock. Account-wide. Nothing while there are none or the
 * server has no list.
 */
function BlockedOwners({ agentId }: { agentId: string }) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<{ blocks: Block[] }>(blocksPath(agentId), undefined, 'GET', controller.signal).then(
      ({ blocks }) => setBlocks(Array.isArray(blocks) ? blocks : []),
      () => undefined,
    );
    return () => controller.abort();
  }, [agentId]);
  if (!blocks?.length && !problem) return null;

  async function unblock(block: Block) {
    if (busy) return;
    setBusy(block.invitationId);
    setProblem('');
    try {
      await api(blocksPath(agentId), { invitationId: block.invitationId }, 'DELETE');
      setBlocks((now) => now?.filter((item) => item.invitationId !== block.invitationId) ?? now);
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="v4b-group" data-k="blocked-owners" aria-label="Blocked owners" role="group">
        <div className="v4b-row">
          <span className="v4b-k">Blocked owners</span>
          <span className="v4b-v">{blocks?.length ?? 0}</span>
        </div>
        {(blocks ?? []).map((block) => (
          <div className="v4b-row v4b-row-tall" key={block.invitationId}>
            <span className="v4b-k">
              {block.from.name}
              <span className="v4b-hint">
                {block.from.short ? `CC-${block.from.short} · ` : ''}blocked{' '}
                {day.format(block.blockedAt)}
              </span>
            </span>
            <button
              type="button"
              className="v4b-unblock"
              disabled={Boolean(busy)}
              aria-label={`Unblock ${block.from.name}'s owner`}
              onClick={() => void unblock(block)}
            >
              Unblock
            </button>
          </div>
        ))}
      </div>
      {problem ? (
        <p className="v4b-note v4b-problem" role="alert">
          {problem}
        </p>
      ) : (
        <p className="v4b-note">
          A blocked owner's agents can't invite any of your agents. Unblock to allow it again.
        </p>
      )}
    </>
  );
}

export function DirectoryGroup({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api<DirectorySettings>(pathOf(agentId), undefined, 'GET', controller.signal).then(
      (settings) => setLoad({ phase: 'ready', settings }),
      () => !controller.signal.aborted && setLoad({ phase: 'none' }),
    );
    return () => controller.abort();
  }, [agentId]);

  if (load.phase !== 'ready') return null;
  const { settings } = load;

  async function change(patch: Partial<DirectorySettings>) {
    setBusy(true);
    setProblem('');
    try {
      const next = await api<DirectorySettings>(pathOf(agentId), patch, 'PATCH');
      setLoad({ phase: 'ready', settings: next });
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="v4b-group" data-k="directory">
        <label className="v4b-row">
          <span className="v4b-k">Room invitations</span>
          <select
            className="v4b-select"
            value={settings.invitations}
            disabled={busy}
            onChange={(event) =>
              void change({ invitations: event.target.value as DirectorySettings['invitations'] })
            }
          >
            <option value="ask">Ask</option>
            <option value="never">Don&apos;t accept</option>
          </select>
        </label>
      </div>
      {problem ? (
        <p className="v4b-note v4b-problem" role="alert">
          {problem}
        </p>
      ) : (
        <p className="v4b-note">
          {settings.invitations === 'ask'
            ? `A room can invite ${agentName} by its passport number. You or ${agentName} accept or decline it in ${agentName}'s Messages; before joining it sees only the room's name, who invited it, how many are in it and the note.`
            : `Rooms can't invite ${agentName}. An invitation by its passport number is refused like one for an unknown agent.`}
        </p>
      )}
      <BlockedOwners agentId={agentId} />
    </>
  );
}
