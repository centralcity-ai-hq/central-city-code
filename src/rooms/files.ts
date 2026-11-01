import { api } from '../api';

/*
 * Room files over the console REST routes (docs/ROOMS.md "Room files"). The browser uploads the
 * bytes straight to the one-shot URL the start answer carries, then finalizes. File names and
 * contents are untrusted data from other people and their AIs: shown as text, never run.
 */

export type FileKind = 'pdf' | 'image' | 'text' | 'code' | 'zip';

export type RoomFileVersion = {
  version: number;
  status: 'pending' | 'ready' | 'refused' | 'purged';
  size_bytes: number;
  sha256: string | null;
  kind: FileKind;
  content_type: string;
  uploaded_by: string;
  own: boolean;
  created_at: string;
  ready_at: string | null;
  superseded_at: string | null;
  refused_reason: string | null;
  text_pages: number;
};

export type RoomFile = {
  id: string;
  room_id: string;
  name: string;
  current_version: number;
  current: RoomFileVersion | null;
  versions: number;
  created_at: string;
  /** The server's answer: this person may delete it (its creator's owner or the host). */
  can_delete: boolean;
};

export type RoomFileList = {
  room_id: string;
  files: RoomFile[];
  usage: { bytes: number; cap_bytes: number };
  available: boolean;
};

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/files`;

export async function listFiles(roomId: string): Promise<RoomFileList> {
  return api(base(roomId), undefined, 'GET');
}

/**
 * Shares one file: reserve a version, PUT the bytes to the presigned URL, finalize. `onStage`
 * reports progress for the panel. Throws with the server's reason when the file is refused.
 */
export async function shareFile(
  roomId: string,
  file: File,
  options: { agentId?: string; onStage?: (stage: 'uploading' | 'checking') => void } = {},
): Promise<RoomFile> {
  const started = await api<{
    file_id: string;
    version: number;
    upload: { method: 'PUT'; url: string; headers: { 'content-type': string } };
  }>(`${base(roomId)}/uploads`, {
    name: file.name,
    size_bytes: file.size,
    ...(options.agentId ? { agent_id: options.agentId } : {}),
  });
  options.onStage?.('uploading');
  const put = await fetch(started.upload.url, {
    method: 'PUT',
    headers: started.upload.headers,
    body: file,
  });
  if (!put.ok) throw new Error('The upload did not go through. Try again.');
  options.onStage?.('checking');
  const done = await api<{ file: RoomFile }>(
    `${base(roomId)}/${encodeURIComponent(started.file_id)}/versions/${started.version}/finalize`,
    options.agentId ? { agent_id: options.agentId } : {},
  );
  return done.file;
}

/** A short-lived download link for the current (or a given) version. */
export async function downloadLink(
  roomId: string,
  fileId: string,
  version?: number,
): Promise<{ url: string; name: string; sha256: string | null }> {
  const query = version ? `?version=${version}` : '';
  return api(`${base(roomId)}/${encodeURIComponent(fileId)}/download${query}`, undefined, 'GET');
}

/** Console only: deletes a file and all its versions (the sharer's owner or the host). */
export async function deleteFile(roomId: string, fileId: string): Promise<void> {
  await api(`${base(roomId)}/${encodeURIComponent(fileId)}`, {}, 'DELETE');
}

/** "412 KB", "3.4 MB", "980 B", in units of 1024 like the limits (25 MB, 250 MB). */
export function sizeLabel(bytes: number): string {
  const KB = 1024;
  const MB = KB * KB;
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** The short label on a file's type tile (PDF, TS, PNG, ZIP, TXT…). */
export function typeLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
  return ext.slice(0, 4) || 'FILE';
}
