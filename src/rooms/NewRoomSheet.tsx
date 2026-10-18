import { useEffect, useRef, useState } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { agentSearchOf, withRoomDeadline, type Agent, type Room, type RoomsClient } from './api';
import { useAgentPicker } from '../agents/useAgentPicker';
import { RoomTemplatePicker } from './RoomTemplates';
import { BLANK_ROOM_TEMPLATE_ID } from '../../shared/room-templates';
import { describe } from './useRoomThread';
import { useDialogFocus } from './useDialogFocus';
import { PanelHead, SwitchRow } from './PanelV3';
import { Avatar } from './Avatar';

/**
 * A room name and topic at their longest (server/rooms/contract.ts roomNameSchema and
 * roomTopicSchema).
 */
const ROOM_NAME_MAX = 80;
const ROOM_TOPIC_MAX = 280;

/** `text` cut to `max` UTF-16 units (as the server and maxLength count), never mid-character. */
function cutTo(text: string, max: number) {
  let cut = '';
  for (const char of text) {
    if (cut.length + char.length > max) break;
    cut += char;
  }
  return cut;
}

/**
 * "New room" (Workspace v3 sheet, docs/design/NEW_ROOM.md, mockup new-room.html): the room name
 * the person types, "Start from" (Blank or a built-in template that sets its topic; never tasks or
 * the name), the "New members can read earlier messages" switch (on by default) and the host
 * under a collapsed Host row (the agents as radio rows). With no agent yet, its name is asked for
 * instead: it hosts the room. Another page may fill in the name and a topic (a Feed request's
 * "Start a room"); the person still edits, creates and invites, and nobody joins by itself.
 */
export function NewRoomSheet({
  client,
  initialName = '',
  initialTopic = '',
  onCreated,
  onClose,
}: {
  client: RoomsClient;
  /** The name it starts with, cut to the longest a room name may be. */
  initialName?: string;
  /** A topic it starts with: shown as its own field, and it replaces a template's topic. */
  initialTopic?: string;
  onCreated: (room: Room) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [name, setName] = useState(() => cutTo(initialName.trim(), ROOM_NAME_MAX).trim());
  const [topic, setTopic] = useState(() => cutTo(initialTopic.trim(), ROOM_TOPIC_MAX));
  // "Start from": Blank, or a built-in template that adds its topic (no tasks, never the name).
  const [templateId, setTemplateId] = useState(BLANK_ROOM_TEMPLATE_ID);
  // Default on: an AI invited later reads the conversation instead of asking for it again.
  const [full, setFull] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const created = useRef<Agent | null>(null);
  const sheet = useRef<HTMLFormElement>(null);
  useDialogFocus(sheet, onClose);
  // A paged workspace lists its newest agents; any other host is found with the search.
  const hosts = useAgentPicker(agents, agentSearchOf(client), [agentId], {
    label: 'Search all your agents',
  });
  // Reading your agents failed: Create stays off (no host yet) and "Try again" reads them again,
  // keeping what was typed.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    withRoomDeadline(client.listAgents())
      .then((list) => {
        if (!active) return;
        setAgents(list);
        setAgentId(list[0]?.id ?? '');
      })
      .catch((err) => {
        if (!active) return;
        setError(describe(err));
        setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, attempt]);
  /** Switch template: it decides the topic and suggested roles, never the name people type. */
  function pickTemplate(id: string) {
    setTemplateId(id);
    key.current = crypto.randomUUID();
  }
  async function submit() {
    setBusy(true);
    setError('');
    try {
      let host = agentId;
      if (!host) {
        // No agent yet: create one to host (kept across a retry of the room creation).
        created.current ??= await withRoomDeadline(client.createAgent({ name: agentName.trim() }));
        host = created.current.id;
      }
      const room = await withRoomDeadline(
        client.create({
          agent_id: host,
          name: name.trim(),
          idempotency_key: key.current,
          history: full ? 'full' : 'from_join',
          ...(topic.trim() ? { topic: topic.trim() } : {}),
          ...(templateId !== BLANK_ROOM_TEMPLATE_ID ? { room_template_id: templateId } : {}),
        }),
      );
      onCreated(room);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="rm-backdrop rm-v3-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        ref={sheet}
        className="rm-sheet rm-v3-sheet rm-new-room"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-new-title"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PanelHead closeLabel="Close" onClose={onClose}>
          <h2 id="rm-new-title">New room</h2>
          <p className="rm-v2-subtitle">Name it. You invite who joins next.</p>
        </PanelHead>
        <label className="rm-field rm-new-room-name">
          <span>Room name</span>
          <input
            className="rm-input"
            autoFocus
            placeholder="e.g. Launch week"
            value={name}
            maxLength={ROOM_NAME_MAX}
            onChange={(event) => {
              setName(event.target.value);
              key.current = crypto.randomUUID();
            }}
          />
        </label>
        {initialTopic ? (
          <label className="rm-field rm-new-room-name rm-new-room-topic">
            <span>Topic</span>
            <textarea
              className="rm-input"
              rows={3}
              value={topic}
              maxLength={ROOM_TOPIC_MAX}
              onChange={(event) => {
                setTopic(event.target.value);
                key.current = crypto.randomUUID();
              }}
            />
          </label>
        ) : null}
        <RoomTemplatePicker value={templateId} onChange={pickTemplate} />
        <SwitchRow
          label="New members can read earlier messages"
          hint="People and AIs who join later see the whole conversation."
          checked={full}
          onChange={(checked) => {
            setFull(checked);
            key.current = crypto.randomUUID();
          }}
        />
        {agents !== null && !agents.length ? (
          // No agent yet: its name is required, so it is asked for in place of Host.
          <div className="rm-new-room-agent-field">
            <label className="rm-field rm-new-room-agent">
              <span>Your AI's name</span>
              <input
                className="rm-input"
                placeholder="e.g. Scout"
                value={agentName}
                maxLength={64}
                aria-describedby="rm-new-agent-hint"
                onChange={(event) => setAgentName(event.target.value)}
              />
            </label>
            <small id="rm-new-agent-hint" className="rm-new-room-hint">
              It hosts the room. You can rename it in My agents.
            </small>
          </div>
        ) : null}
        {agents?.length ? (
          <details className="rm-disclosure rm-new-room-settings">
            <summary>
              <ChevronRight size={16} aria-hidden="true" />
              Host
              <span className="rm-new-room-host-now">{hosts.known.get(agentId)?.name}</span>
            </summary>
            {hosts.field}
            <div className="rm-new-room-hosts" role="radiogroup" aria-label="Host agent">
              {(hosts.agents ?? agents).map((agent) => (
                <label key={agent.id} className="rm-new-room-host">
                  <input
                    type="radio"
                    name="rm-new-room-host"
                    value={agent.id}
                    checked={agentId === agent.id}
                    onChange={() => {
                      setAgentId(agent.id);
                      key.current = crypto.randomUUID();
                    }}
                  />
                  <Avatar name={agent.name} kind="agent" size="xs" />
                  <span className="rm-new-room-host-name">{agent.name}</span>
                  <span className="rm-new-room-host-dot" aria-hidden="true" />
                </label>
              ))}
            </div>
          </details>
        ) : null}
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {loadFailed ? (
          <button
            type="button"
            className="rm-v3-btn rm-v3-btn-ghost"
            onClick={() => {
              setError('');
              setLoadFailed(false);
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </button>
        ) : null}
        <div className="rm-v3-sheet-actions">
          <button type="button" className="rm-v3-btn rm-v3-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="rm-v3-btn rm-v3-btn-primary rm-new-room-create"
            aria-busy={busy || undefined}
            disabled={
              busy || !name.trim() || agents === null || (!agents.length && !agentName.trim())
            }
          >
            {busy ? (
              <>
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
                Creating room…
              </>
            ) : (
              'Create room'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
