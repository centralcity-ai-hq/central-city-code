import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import {
  deleteFile,
  downloadLink,
  listFiles,
  shareFile,
  sizeLabel,
  typeLabel,
  type FileKind,
  type RoomFile,
  type RoomFileList,
} from './files';
import { withoutBidiControls } from './markdown/format';
import { PanelHead } from './PanelV3';

/*
 * Rooms P1 files in the console (docs/ROOMS.md "Room files"; design standard
 * rooms-p1-mockup-v4: quiet side panel rows: an 18px type tile, 13.5px name, 12px meta).
 * Styles in rooms-p1-cards.css. Names are untrusted text: shown as text; files are never opened
 * in the page, only downloaded through a short-lived link.
 */

const REFRESH_MS = 30_000;
const clean = (text: string) => withoutBidiControls(text);

/** The room's files, refreshed while the panel is open; null until loaded (or without files). */
export function useRoomFiles(roomId: string, enabled: boolean) {
  const [state, setState] = useState<RoomFileList | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await listFiles(roomId));
    } catch {
      // A server without files, or a failed read: the panel shows nothing new.
    }
  }, [roomId]);
  useEffect(() => {
    setState(null);
    void refresh();
    if (!enabled) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh, enabled]);
  return { state, refresh };
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong. Try again.';
}

/** The small square type tile (mockup v4 "mini"): PDF red, code blue, images green, others grey. */
export function TypeTile({ name, kind }: { name: string; kind: FileKind }) {
  return (
    <span className="rm-file-tile" data-kind={kind} aria-hidden="true">
      {typeLabel(name)}
    </span>
  );
}

export function FilesPanel({
  roomId,
  state,
  canShare,
  agentId,
  onChanged,
  onClose,
}: {
  roomId: string;
  state: RoomFileList | null;
  /** A posting member in an open room may share files. */
  canShare: boolean;
  agentId?: string | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const files = state?.files ?? [];

  async function upload(file: File) {
    setError('');
    setBusy(`Starting ${file.name}…`);
    try {
      await shareFile(roomId, file, {
        ...(agentId ? { agentId } : {}),
        onStage: (stage) =>
          setBusy(stage === 'uploading' ? `Uploading ${file.name}…` : `Checking ${file.name}…`),
      });
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy('');
      if (input.current) input.current.value = '';
    }
  }

  async function download(file: RoomFile) {
    setError('');
    try {
      const link = await downloadLink(roomId, file.id);
      // The link lives 60 seconds and points at the file store, never at this origin.
      const a = document.createElement('a');
      a.href = link.url;
      a.rel = 'noopener noreferrer';
      a.download = link.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      setError(message(err));
    }
  }

  async function remove(file: RoomFile) {
    setError('');
    try {
      await deleteFile(roomId, file.id);
      setConfirming(null);
      onChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  const usage = state?.usage;
  return (
    <aside
      className="rm-panel rm-files-panel rm-v3-panel"
      aria-label="Files"
      data-testid="files-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelHead closeLabel="Close files" onClose={onClose}>
        <h2>
          Files{' '}
          <span className="rm-v3-head-count" aria-label={`${files.length} files`}>
            {files.length}
          </span>
        </h2>
      </PanelHead>
      <div className="rm-v3-body rm-cards-body">
        {state === null ? <p className="rm-cards-empty">Loading…</p> : null}
        {state && !state.available ? (
          <p className="rm-cards-empty">Files are not switched on yet.</p>
        ) : null}
        {state?.available && !files.length ? (
          <p className="rm-cards-empty">No files shared yet.</p>
        ) : null}
        <ul className="rm-cards-list">
          {files.map((file) => {
            const current = file.current;
            if (!current) return null;
            const mayDelete = file.can_delete && state?.available;
            return (
              <li key={file.id} className="rm-card-it rm-file-it" data-testid="file-row">
                <TypeTile name={file.name} kind={current.kind} />
                <div className="rm-card-x">
                  <button
                    type="button"
                    className="rm-file-name"
                    onClick={() => void download(file)}
                    title={`Download ${clean(file.name)}`}
                  >
                    {clean(file.name)}
                  </button>
                  <div className="rm-card-s">
                    {sizeLabel(current.size_bytes)} · v{file.current_version} ·{' '}
                    {clean(current.uploaded_by)}
                    {current.text_pages ? ` · ${current.text_pages} text pages` : ''}
                  </div>
                  {confirming === file.id ? (
                    <div className="rm-ask-acts">
                      <button
                        type="button"
                        className="rm-pill rm-pill-primary"
                        onClick={() => void remove(file)}
                      >
                        Delete all versions
                      </button>
                      <button type="button" className="rm-pill" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </div>
                  ) : null}
                </div>
                {mayDelete && confirming !== file.id ? (
                  <button
                    type="button"
                    className="rm-cards-toggle"
                    aria-label={`Delete ${clean(file.name)}`}
                    onClick={() => setConfirming(file.id)}
                  >
                    Delete
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {usage && state?.available ? (
          <p className="rm-card-s">
            {sizeLabel(usage.bytes)} of {sizeLabel(usage.cap_bytes)} used
          </p>
        ) : null}
        {canShare && state?.available ? (
          <div className="rm-cards-record">
            <span className="rm-cards-record-label">
              Share a file (PDF, image, text, code or zip; 25 MB)
            </span>
            <input
              ref={input}
              type="file"
              className="rm-visually-hidden"
              accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.log,.yaml,.yml,.toml,.xml,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.sol,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.rb,.php,.sh,.sql,.html,.css,.scss,.vue,.svelte,.zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
              aria-label="Choose a file to share"
            />
            <button
              type="button"
              className="rm-pill rm-pill-primary"
              disabled={Boolean(busy)}
              onClick={() => input.current?.click()}
            >
              {busy || 'Choose file'}
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="rm-ask-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
