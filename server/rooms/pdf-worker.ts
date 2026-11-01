import { parentPort, workerData } from 'node:worker_threads';
import { extractInProcess } from './pdf-text.js';

/**
 * Worker thread for PDF text (pdf-text.ts): reads one PDF and reports each page, then the
 * result. The parent enforces the time limit by terminating this thread.
 */
const { bytes, maxPages, totalBytes } = workerData as {
  bytes: Uint8Array;
  maxPages: number;
  totalBytes: number;
};
const pages = await extractInProcess(
  bytes,
  { maxPages, totalBytes, timeMs: 2_147_483_647 },
  (page) => parentPort!.postMessage({ page }),
);
parentPort!.postMessage({ done: pages });
