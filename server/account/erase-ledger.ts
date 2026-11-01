import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Database } from '../database.js';
import {
  AccountErasureError,
  accountHash,
  eraseAccount,
  ledgerLine,
  parseLedger,
  reapplyAccountErasures,
  type ErasureCommand,
} from './erase.js';

/**
 * The operator script's protocol (scripts/account-erase.ts, docs/ACCOUNT_ERASURE.md). A confirmed
 * erase is made durable before it is committed:
 *
 * 1. The `intent` line is appended to the ledger and flushed to disk (file and directory). If
 *    that fails, nothing is erased.
 * 2. The erasure commits (one transaction).
 * 3. The `done` line is appended and flushed.
 *
 * Whatever stops the run after step 1 (a failed commit, a crash, a failed `done` line), the
 * ledger already names the account, and `reapply` erases it again, which is safe to repeat:
 * accounts already erased or absent are skipped. When the erasure is known not to have committed
 * (it was refused: no such account, not a person, erased already), an `aborted` line cancels the
 * intent. Every failure answers the exact state (ledger lines written, erasure committed or not)
 * and a non-zero exit code.
 */

/** Flushes a directory entry to disk. */
export async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/**
 * Appends `line` to the file and flushes the file and its directory to disk. The file write and
 * its flush are required everywhere. The directory flush is required on every platform except
 * Windows, where a directory handle cannot be flushed (EPERM): there the directory entry's
 * durability rests on the file system alone, a documented limitation (docs/ACCOUNT_ERASURE.md).
 * Any directory flush failure on other platforms refuses the write.
 */
export async function appendDurably(
  path: string,
  line: string,
  deps: { platform?: NodeJS.Platform; syncDir?: (dir: string) => Promise<void> } = {},
): Promise<void> {
  const file = await open(path, 'a', 0o600);
  try {
    await file.write(`${line}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  if ((deps.platform ?? process.platform) === 'win32') return;
  // The directory entry of a newly created ledger is durable only once the directory is flushed.
  await (deps.syncDir ?? syncDirectory)(dirname(path));
}

export interface ErasureRun {
  exitCode: 0 | 1;
  /** Printed on stdout: the result, or on failure the exact state. */
  output: Record<string, unknown>;
}

type Written = 'written' | 'not written' | 'failed';

export async function runAccountErasure(
  db: Pick<Database, 'transaction' | 'query'>,
  command: ErasureCommand,
  options: {
    now: number;
    readLedger: (path: string) => Promise<string>;
    append?: (path: string, line: string) => Promise<void>;
    erase?: typeof eraseAccount;
  },
): Promise<ErasureRun> {
  const append = options.append ?? appendDurably;
  const erase = options.erase ?? eraseAccount;
  const { now } = options;
  if (command.command === 'reapply') {
    const hashes = parseLedger(await options.readLedger(command.ledger));
    const results = await reapplyAccountErasures(db, hashes, { now, confirm: command.confirm });
    return { exitCode: 0, output: { command: 'reapply', ledger_accounts: hashes.length, results } };
  }
  if (!command.confirm) {
    const result = await erase(db, command.account, { now, confirm: false });
    return { exitCode: 0, output: result as unknown as Record<string, unknown> };
  }
  if (!command.ledger) throw new Error('A confirmed erase needs --ledger.');
  const entry = {
    account_sha256: accountHash(command.account),
    erased_at: new Date(now).toISOString(),
  };
  // One random id per run, on each of its lines: an aborted line cancels only its own intent.
  const op = randomUUID();
  const state = {
    command: 'erase',
    ok: false,
    ...entry,
    op,
    ledger: command.ledger,
    intent: 'not written' as Written,
    erasure: 'not committed' as 'not committed' | 'committed' | 'unknown',
    done: 'not written' as Written,
    aborted: 'not written' as Written,
  };
  const message = (error: unknown) =>
    error instanceof AccountErasureError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  try {
    await append(command.ledger, ledgerLine(entry, 'intent', op));
    state.intent = 'written';
  } catch (error) {
    state.intent = 'failed';
    return {
      exitCode: 1,
      output: {
        ...state,
        error: `The ledger could not be written (${message(error)}); nothing was erased.`,
      },
    };
  }

  let result;
  try {
    result = await erase(db, command.account, { now, confirm: true });
    state.erasure = 'committed';
  } catch (error) {
    if (error instanceof AccountErasureError) {
      // Refused inside the transaction: nothing committed, so the intent is cancelled.
      try {
        await append(command.ledger, ledgerLine(entry, 'aborted', op));
        state.aborted = 'written';
      } catch {
        state.aborted = 'failed';
      }
      return { exitCode: 1, output: { ...state, error: message(error) } };
    }
    state.erasure = 'unknown';
    return {
      exitCode: 1,
      output: {
        ...state,
        error: message(error),
        next: 'The intent line is in the ledger: run reapply with it to finish the erasure.',
      },
    };
  }

  try {
    await append(command.ledger, ledgerLine(entry, 'done', op));
    state.done = 'written';
  } catch (error) {
    state.done = 'failed';
    return {
      exitCode: 1,
      output: {
        ...state,
        result,
        error: `The erasure committed, but its done line could not be written (${message(error)}).`,
        next: 'The intent line is in the ledger, so reapply erases the account again after a restore.',
      },
    };
  }
  return { exitCode: 0, output: result as unknown as Record<string, unknown> };
}
