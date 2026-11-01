import { Worker } from 'node:worker_threads';
import type { ArtifactKind } from './artifact-check.js';

/**
 * PDF text for the room file read path (docs/ROOMS.md "Room files"). The serverless pdf.js
 * build from unpdf runs in process (no worker thread, no canvas, no native code). PDFs are
 * never trusted: no script evaluation, no font loading, no network, bounded pages, time and size.
 * Encrypted or broken files give one "[no extractable text]" page instead of failing the upload.
 *
 * Real PDFs are read in a worker thread (pdf-worker.ts) with heap limits: pdf.js runs
 * synchronously for long stretches (a small file can inflate to hundreds of MB), so only
 * terminating the worker enforces the time limit, and a process memory watch ends it early.
 * The event loop stays free throughout.
 */
export const PDF_TEXT_LIMITS = {
  maxPages: 300,
  timeMs: 20_000,
  totalBytes: 10 * 1024 * 1024,
  pageBytes: 262_144,
  /** Worker heap limits and the process memory growth that ends a read early. */
  workerOldMb: 256,
  workerYoungMb: 64,
  memoryGrowthBytes: 512 * 1024 * 1024,
} as const;

export const NO_TEXT_PAGE = '[no extractable text]';
export const PAGE_CAP_NOTE = `[stopped after ${PDF_TEXT_LIMITS.maxPages} pages]`;
export const TIME_LIMIT_NOTE = '[text extraction stopped: time limit]';
export const SIZE_LIMIT_NOTE = '[text extraction stopped: size limit]';
const TRUNCATED = '[truncated]';

/** The small part of a pdf.js document the extractor uses (tests pass a stub). */
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: ReadonlyArray<{ str?: string; hasEOL?: boolean }> }>;
  }>;
  destroy(): Promise<void> | void;
}
export type PdfLoader = (bytes: Uint8Array) => Promise<PdfDocument>;

export interface PdfTextOptions {
  maxPages?: number;
  timeMs?: number;
  totalBytes?: number;
  load?: PdfLoader;
}

const defaultLoad: PdfLoader = async (bytes) => {
  const { getDocument } = await import('unpdf/pdfjs');
  const task = getDocument({
    // A copy: pdf.js may transfer (detach) the buffer it is given.
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  } as Parameters<typeof getDocument>[0]);
  const doc = (await task.promise) as unknown as Omit<PdfDocument, 'destroy'>;
  return {
    numPages: doc.numPages,
    getPage: (n) => doc.getPage(n),
    // The loading task owns the document and its in-process worker.
    destroy: () => task.destroy(),
  };
};

/** Trims a page and caps it at 256 KiB (UTF-8) with a "[truncated]" marker. */
function capPage(text: string): string {
  let page = text.trim();
  if (Buffer.byteLength(page) <= PDF_TEXT_LIMITS.pageBytes) return page;
  const room = PDF_TEXT_LIMITS.pageBytes - Buffer.byteLength(`\n${TRUNCATED}`);
  page = Buffer.from(page).subarray(0, room).toString('utf8').replace(/�+$/, '');
  return `${page}\n${TRUNCATED}`;
}

class TimeLimit extends Error {}

/** The extractor createRoomArtifacts takes as deps.extractText: PDFs only, null otherwise. */
export async function extractPdfText(
  kind: ArtifactKind,
  bytes: Uint8Array,
  options: PdfTextOptions = {},
): Promise<string[] | null> {
  if (kind !== 'pdf') return null;
  // A given loader (tests) runs in process; real PDFs go to the worker.
  return options.load ? extractInProcess(bytes, options) : extractInWorker(bytes, options);
}

/** The worker module next to this one: .ts from source, .mjs in the API bundle. */
function workerUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.mjs', here);
}

function extractInWorker(bytes: Uint8Array, options: PdfTextOptions): Promise<string[] | null> {
  const timeMs = options.timeMs ?? PDF_TEXT_LIMITS.timeMs;
  return new Promise((resolve) => {
    const pages: string[] = [];
    let settled = false;
    let worker: Worker;
    const finish = (result: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      void worker?.terminate().catch(() => {});
      resolve(result);
    };
    const soFar = (note: string) => (pages.length ? [...pages, note] : null);
    const timer = setTimeout(() => finish(soFar(TIME_LIMIT_NOTE)), timeMs);
    const baseline = process.memoryUsage.rss();
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() - baseline > PDF_TEXT_LIMITS.memoryGrowthBytes)
        finish(soFar(SIZE_LIMIT_NOTE) ?? [NO_TEXT_PAGE]);
    }, 100);
    try {
      worker = new Worker(workerUrl(), {
        workerData: {
          bytes,
          maxPages: options.maxPages ?? PDF_TEXT_LIMITS.maxPages,
          totalBytes: options.totalBytes ?? PDF_TEXT_LIMITS.totalBytes,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: PDF_TEXT_LIMITS.workerOldMb,
          maxYoungGenerationSizeMb: PDF_TEXT_LIMITS.workerYoungMb,
        },
        stdout: true,
        stderr: true,
      });
    } catch (error) {
      console.warn('pdf text worker did not start', (error as Error).message);
      return finish([NO_TEXT_PAGE]);
    }
    worker.unref();
    worker.on('message', (message: { page?: string; done?: string[] | null }) => {
      if (typeof message.page === 'string') pages.push(message.page);
      else if ('done' in message) finish(message.done ?? [NO_TEXT_PAGE]);
    });
    // Out of memory, a crash or a missing module: the pages so far, else no text.
    worker.on('error', (error: Error & { code?: string }) => {
      if (error.code !== 'ERR_WORKER_OUT_OF_MEMORY')
        console.warn('pdf text worker failed', error.code ?? error.message);
      finish(pages.length ? pages : [NO_TEXT_PAGE]);
    });
    worker.on('exit', () => finish(pages.length ? pages : [NO_TEXT_PAGE]));
  });
}

/** Extraction on this thread; the worker runs it with onPage reporting each page. */
export async function extractInProcess(
  bytes: Uint8Array,
  options: PdfTextOptions = {},
  onPage?: (page: string) => void,
): Promise<string[] | null> {
  const maxPages = options.maxPages ?? PDF_TEXT_LIMITS.maxPages;
  const timeMs = options.timeMs ?? PDF_TEXT_LIMITS.timeMs;
  const totalBytes = options.totalBytes ?? PDF_TEXT_LIMITS.totalBytes;
  const load = options.load ?? defaultLoad;
  const pages: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeLimit()), timeMs);
  });
  deadline.catch(() => {});
  const timed = <T>(work: Promise<T>) => Promise.race([work, deadline]);
  let doc: PdfDocument | undefined;
  let docPromise: Promise<PdfDocument> | undefined;
  try {
    docPromise = load(bytes);
    doc = await timed(docPromise);
    const count = Math.min(doc.numPages, maxPages);
    let used = 0;
    for (let n = 1; n <= count; n++) {
      const page = await timed(doc.getPage(n));
      const content = await timed(page.getTextContent());
      const text = capPage(
        content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(''),
      );
      used += Buffer.byteLength(text);
      if (used > totalBytes) {
        pages.push(SIZE_LIMIT_NOTE);
        return pages;
      }
      pages.push(text);
      onPage?.(text);
    }
    if (doc.numPages > maxPages) pages.push(`[stopped after ${maxPages} pages]`);
    return pages.length && pages.some((p) => p) ? pages : [NO_TEXT_PAGE];
  } catch (error) {
    if (error instanceof TimeLimit) return pages.length ? [...pages, TIME_LIMIT_NOTE] : null;
    // Encrypted, damaged or not really a PDF: the file stays downloadable.
    return pages.length ? pages : [NO_TEXT_PAGE];
  } finally {
    clearTimeout(timer);
    // Never wait on a load that may still be running after the time limit.
    if (doc) void Promise.resolve(doc.destroy()).catch(() => {});
    else void docPromise?.then((late) => late.destroy()).catch(() => {});
  }
}
