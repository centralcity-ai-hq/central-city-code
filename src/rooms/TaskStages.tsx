import { useEffect, useId, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { ApiError } from '../api';
import { getTaskStages, saveTaskStages } from './tasks';
import { describe } from './useRoomThread';

/*
 * Optional task stages (docs/ROOM_TASKS.md "Stages"): a short list the host picks, such as
 * Spec'd, Building, Testing, Shipped. Stages sit on top of a task's status and never change it.
 * Rooms without stages show nothing here.
 */

const MAX_STAGES = 8;
const NAME_MAX = 24;

function stageError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'unknown_stage':
        return 'That stage is no longer in this room. Pick another one.';
      case 'stage_not_allowed':
        return 'Only the host or the member working on this task can change its stage.';
      case 'duplicate_stage':
        return 'Each stage needs a different name.';
      case 'room_closed':
        return "This room is closed, so stages can't change.";
      case 'host_required':
        return 'Only the host can change this.';
    }
    return err.message;
  }
  return describe(err);
}

/**
 * The stage of one task as a small pill. People who may move the task get a picker (a native
 * select, so it works the same with touch, mouse and keyboard); everyone else sees the pill.
 */
export function StagePill({
  taskNumber,
  stage,
  stages,
  canMove,
  busy,
  onMove,
}: {
  taskNumber: number;
  stage: string | null;
  stages: string[];
  canMove: boolean;
  busy: boolean;
  onMove: (stage: string | null) => void;
}) {
  if (!stages.length && !stage) return null;
  if (!canMove)
    return stage ? (
      <span className="rm-stage-pill" data-stage-set="true">
        {stage}
      </span>
    ) : null;
  const known = stage === null || stages.includes(stage);
  return (
    <span className="rm-stage-pill rm-stage-picker" data-stage-set={stage ? 'true' : 'false'}>
      <select
        aria-label={`Stage for T${taskNumber}`}
        value={stage ?? ''}
        disabled={busy}
        onChange={(event) => onMove(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">No stage</option>
        {!known && stage ? <option value={stage}>{stage}</option> : null}
        {stages.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** Host only, in Room settings: edit the room's stage list. Hidden when tasks are off. */
export function TaskStagesSection({
  roomId,
  closed,
  onSaved,
}: {
  roomId: string;
  closed: boolean;
  onSaved?: (stages: string[]) => void;
}) {
  const id = useId();
  const [saved, setSaved] = useState<string[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [rows, setRows] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  // A failed load leaves the list unknown: it shows the error and Try again (attempt), never an
  // empty list the host could not save.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getTaskStages(roomId)
      .then((stages) => {
        if (!live) return;
        if (stages === null) setAvailable(false);
        else {
          setSaved(stages);
          setRows(stages);
        }
      })
      .catch((err) => live && setError(stageError(err)));
    return () => {
      live = false;
    };
  }, [roomId, attempt]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!available) return null;
  const cleaned = rows.map((row) => row.trim()).filter(Boolean);
  const changed = saved !== null && JSON.stringify(cleaned) !== JSON.stringify(saved);
  const lower = cleaned.map((row) => row.toLowerCase());
  const duplicate = lower.some((row, index) => lower.indexOf(row) !== index);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changed || duplicate) return;
    setBusy(true);
    setError('');
    try {
      const stages = await saveTaskStages(roomId, cleaned);
      setSaved(stages);
      setRows(stages);
      setToast('Stages updated');
      onSaved?.(stages);
    } catch (err) {
      setError(stageError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rm-settings-section" aria-labelledby={`${id}-stages`}>
      <h3 id={`${id}-stages`}>Task stages</h3>
      <p className="rm-meta">
        Optional steps a task moves through, such as Building, Testing, Shipped. They show on each
        task next to its status. Leave the list empty to not use stages.
      </p>
      {saved === null && error ? (
        <div className="rm-inline-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="rm-quiet"
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : saved === null ? (
        <p className="rm-meta" role="status">
          Loading stages…
        </p>
      ) : (
        <form className="rm-settings-form" onSubmit={(event) => void save(event)} noValidate>
          {rows.length ? (
            <ol className="rm-stage-rows" aria-label="Stages">
              {rows.map((row, index) => (
                <li key={index} className="rm-stage-row">
                  <input
                    className="rm-input"
                    value={row}
                    maxLength={NAME_MAX}
                    disabled={closed || busy}
                    aria-label={`Stage ${index + 1}`}
                    placeholder={`Stage ${index + 1}`}
                    onChange={(event) =>
                      setRows((list) =>
                        list.map((item, at) => (at === index ? event.target.value : item)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="rm-icon"
                    aria-label={`Remove stage ${index + 1}`}
                    disabled={closed || busy}
                    onClick={() => setRows((list) => list.filter((_, at) => at !== index))}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rm-meta">No stages. Tasks show only their status.</p>
          )}
          {!closed && rows.length < MAX_STAGES ? (
            <button
              type="button"
              className="rm-quiet rm-stage-add"
              disabled={busy}
              onClick={() => setRows((list) => [...list, ''])}
            >
              <Plus size={16} aria-hidden="true" />
              Add stage
            </button>
          ) : null}
          {duplicate ? <p className="rm-field-error">Each stage needs a different name.</p> : null}
          {error ? (
            <p className="rm-inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="rm-settings-actions">
            <button
              type="submit"
              className="rm-primary"
              disabled={closed || busy || !changed || duplicate}
            >
              {busy ? 'Updating…' : 'Update stages'}
            </button>
            <span className="rm-toast" role="status">
              {toast}
            </span>
          </div>
        </form>
      )}
    </section>
  );
}
