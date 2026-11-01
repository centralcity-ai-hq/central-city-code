import { del, get, issueSignedToken, presignUrl, put } from '@vercel/blob';

/**
 * Where room file bytes live (Rooms P1 files, docs/ROOMS.md "Room files"): a small port so the
 * service never depends on one provider, and tests run against an in-memory store.
 *
 * Production uses a Vercel Blob store with PRIVATE objects only: nothing is reachable by URL
 * without a short-lived presigned link the server issues after its own membership check.
 * Uploads are one PUT to a presigned URL bound to the exact pathname, content type, size cap and
 * expiry, so people and AIs upload the same way and bytes never pass through a function.
 */
export interface ArtifactStore {
  /** A one-shot upload URL for exactly this pathname. */
  presignPut(input: {
    pathname: string;
    contentType: string;
    maxBytes: number;
    validUntil: number;
  }): Promise<string>;
  /** A short-lived download URL for this pathname. */
  presignGet(input: { pathname: string; validUntil: number }): Promise<string>;
  /** The stored bytes (null when the object does not exist); refuses more than maxBytes. */
  read(pathname: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Server-side write (small inline uploads only). */
  write(pathname: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Deletes objects; a missing one is not an error. */
  remove(pathnames: readonly string[]): Promise<void>;
}

export class ArtifactTooLargeError extends Error {}

/** Reads a stream into memory, failing as soon as it passes maxBytes. */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ArtifactTooLargeError('The file is larger than its limit.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * The Vercel Blob store, or null when no read-write token is configured (the file tools then
 * answer 503 files_unavailable). The token is a secret: read from the environment only, never
 * logged or returned.
 */
export function vercelArtifactStore(env: NodeJS.ProcessEnv): ArtifactStore | null {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) return null;
  const signed = async (
    pathname: string,
    operations: Array<'get' | 'put'>,
    until: number,
    extra = {},
  ) => issueSignedToken({ token, pathname, operations, validUntil: until, ...extra });
  return {
    async presignPut({ pathname, contentType, maxBytes, validUntil }) {
      const delegation = await signed(pathname, ['put'], validUntil, {
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
      });
      const { presignedUrl } = await presignUrl(delegation, {
        access: 'private',
        operation: 'put',
        pathname,
        validUntil,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
        allowOverwrite: false,
        addRandomSuffix: false,
      });
      return presignedUrl;
    },
    async presignGet({ pathname, validUntil }) {
      const delegation = await signed(pathname, ['get'], validUntil);
      const { presignedUrl } = await presignUrl(delegation, {
        access: 'private',
        operation: 'get',
        pathname,
        validUntil,
      });
      return presignedUrl;
    },
    async read(pathname, maxBytes) {
      const result = await get(pathname, { access: 'private', token, useCache: false });
      if (!result || result.statusCode !== 200) return null;
      return readCapped(result.stream, maxBytes);
    },
    async write(pathname, bytes, contentType) {
      await put(pathname, Buffer.from(bytes), {
        access: 'private',
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
    },
    async remove(pathnames) {
      if (pathnames.length) await del([...pathnames], { token });
    },
  };
}

/** An in-memory store for tests and local development (never used in production). */
export function memoryArtifactStore(): ArtifactStore & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  /** Simulates the client's PUT to a presigned URL. */
  upload(url: string, bytes: Uint8Array, contentType: string): void;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const pending = new Map<string, { pathname: string; contentType: string; maxBytes: number }>();
  let n = 0;
  return {
    objects,
    async presignPut({ pathname, contentType, maxBytes }) {
      const url = `memory://put/${++n}`;
      pending.set(url, { pathname, contentType, maxBytes });
      return url;
    },
    async presignGet({ pathname, validUntil }) {
      return `memory://get/${encodeURIComponent(pathname)}?until=${validUntil}`;
    },
    upload(url, bytes, contentType) {
      const slot = pending.get(url);
      if (!slot) throw new Error('Unknown or used upload URL.');
      if (contentType !== slot.contentType) throw new Error('Content type not allowed.');
      if (bytes.byteLength > slot.maxBytes) throw new Error('File too large.');
      if (objects.has(slot.pathname)) throw new Error('Overwrite not allowed.');
      pending.delete(url);
      objects.set(slot.pathname, { bytes, contentType });
    },
    async read(pathname, maxBytes) {
      const found = objects.get(pathname);
      if (!found) return null;
      if (found.bytes.byteLength > maxBytes)
        throw new ArtifactTooLargeError('The file is larger than its limit.');
      return found.bytes;
    },
    async write(pathname, bytes, contentType) {
      if (objects.has(pathname)) throw new Error('Overwrite not allowed.');
      objects.set(pathname, { bytes, contentType });
    },
    async remove(pathnames) {
      for (const pathname of pathnames) objects.delete(pathname);
    },
  };
}
