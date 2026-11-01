import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountErasureError,
  ERASED_LABEL,
  RETAINED,
  accountHash,
  eraseAccount,
  ledgerLine,
  parseErasureArgs,
  parseLedger,
  reapplyAccountErasures,
} from '../server/account/erase.js';
import { appendDurably, runAccountErasure } from '../server/account/erase-ledger.js';
import type { Database } from '../server/database.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Erasing a person's account: one transaction removes its data, deletes the rooms it hosts, keeps
 * what it wrote in other people's rooms under a pseudonym, and leaves its id only in the
 * documented retained tables. Synthetic data.
 */

/** Every table and text, JSON or array column of the schema. */
async function textColumns(db: Database) {
  return (
    await db.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'jsonb', 'json', 'ARRAY', 'character varying')
        ORDER BY 1, 2`,
    )
  ).rows;
}

/** Every table.column holding `needle` anywhere in its text. */
async function holders(db: Database, needle: string) {
  const found: string[] = [];
  for (const { table_name: table, column_name: column } of await textColumns(db)) {
    const n = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE strpos("${column}"::text, $1) > 0`,
        [needle],
      )
    ).rows[0]!.n;
    if (n) found.push(`${table}.${column}`);
  }
  return found;
}

async function rowCounts(db: Database) {
  const tables = [...new Set((await textColumns(db)).map((row) => row.table_name))];
  const counts: Record<string, number> = {};
  for (const table of tables)
    counts[table] = (
      await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)
    ).rows[0]!.n;
  return counts;
}

async function scene(t: Parameters<typeof elricFixture>[0]) {
  const f = await elricFixture(t);
  // Hana hosts a room; Zed (Google-verified, with a date of birth and Elric) is a member there.
  const s = await f.scene('Shared room');
  const zed = s.owner;
  f.small.push({ text: 'An answer.' });
  await f.say(zed, s.room, '@Elric what is next?', s.person);
  await f.elric.drain();
  await f.say(zed, s.room, 'A note from Zed that stays for the room', s.person);
  await f.say(s.host, s.room, 'A reply from the host', s.hostAgent);
  // Zed hosts a room of his own, where Hana's agent posts too.
  const desk = await f.agent(zed, 'Zed desk');
  const own = await f.room(zed, desk, 'Zed room');
  await f.joinAgent(s.host, own, s.hostAgent);
  await f.say(zed, own, 'Inside Zed room', desk);
  await f.say(s.host, own, 'Hana inside Zed room', s.hostAgent);
  // A direct message from Zed's agent to Hana's.
  await f.db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,
       parts,created_at) VALUES ($1,1,$2,$3,$4,$5,'ctx-erase',$6,1)`,
    [
      s.hostAgent,
      randomUUID(),
      desk,
      zed.operatorId,
      s.host.operatorId,
      JSON.stringify([{ kind: 'text', text: 'A direct message from Zed' }]),
    ],
  );
  // A direct message between two of Zed's own agents, in their pair's conversation.
  const scout = await f.agent(zed, 'Zed scout');
  await f.db.query(
    `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,
       parts,created_at) VALUES ($1,1,$2,$3,$4,$4,'ctx-own',$5,2)`,
    [
      scout,
      randomUUID(),
      desk,
      zed.operatorId,
      JSON.stringify([{ kind: 'text', text: 'Between Zed agents only' }]),
    ],
  );
  const [low, high] = [desk, scout].sort();
  await f.db.query(
    "INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES ($1,$2,'ctx-own',2)",
    [low, high],
  );
  return { f, s, zed, desk, own };
}

test('an erased account leaves its id only in the retained tables; others keep the room', async (t) => {
  const { f, s, zed, own } = await scene(t);
  const email = `${zed.name.toLowerCase()}@example.com`;
  assert.ok((await holders(f.db, zed.operatorId)).length > 10);

  // A dry run answers the counts and writes nothing.
  const before = await rowCounts(f.db);
  const dry = await eraseAccount(f.db, zed.operatorId, { now: Date.now(), confirm: false });
  assert.equal(dry.applied, false);
  assert.equal(dry.hosted_rooms, 1);
  assert.deepEqual(await rowCounts(f.db), before);

  const result = await eraseAccount(f.db, zed.operatorId, { now: Date.now(), confirm: true });
  assert.equal(result.applied, true);
  assert.equal(result.account, 'deleted');
  assert.equal(result.account_sha256, accountHash(zed.operatorId));
  assert.deepEqual({ ...result, erased_at: '' }, { ...dry, applied: true, erased_at: '' });

  // The id stays only where RETAINED says, and the name and email nowhere at all.
  const allowed = new Set(
    Object.entries(RETAINED).flatMap(([table, columns]) => columns.map((c) => `${table}.${c}`)),
  );
  const left = await holders(f.db, zed.operatorId);
  assert.deepEqual(
    left.filter((column) => !allowed.has(column)),
    [],
  );
  assert.deepEqual(await holders(f.db, zed.name), []);
  assert.deepEqual(await holders(f.db, email), []);
  assert.deepEqual(await holders(f.db, 'sub-Owner Shared room'), []);

  // Zed's room is gone with everything in it, Hana's post there too.
  assert.equal((await f.db.query('SELECT 1 FROM rooms WHERE id=$1', [own.id])).rows.length, 0);
  assert.deepEqual(await holders(f.db, 'Hana inside Zed room'), []);
  // Hana's room keeps Zed's post under the pseudonym and the neutral name.
  const kept = (
    await f.db.query<{ sender_owner_id: string; sender_owner_label: string; sender_name: string }>(
      `SELECT sender_owner_id, sender_owner_label, sender_name FROM room_messages
        WHERE room_id=$1 AND parts::text LIKE '%stays for the room%'`,
      [s.room.id],
    )
  ).rows;
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.sender_owner_id, /^erased:[0-9a-f-]{36}$/);
  assert.equal(kept[0]!.sender_owner_label, ERASED_LABEL);
  assert.equal(kept[0]!.sender_name, ERASED_LABEL);
  // The direct message stays for Hana, from the same pseudonym.
  const dm = (
    await f.db.query<{ sender_owner_id: string }>(
      "SELECT sender_owner_id FROM messages WHERE context_id='ctx-erase'",
    )
  ).rows;
  assert.deepEqual(dm, [{ sender_owner_id: kept[0]!.sender_owner_id }]);
  // The one between Zed's own agents had no other reader: gone, with its pair's conversation.
  assert.deepEqual(await holders(f.db, 'Between Zed agents only'), []);
  assert.deepEqual(await holders(f.db, 'ctx-own'), []);
  assert.equal(result.deleted.messages, 1);
  // Hana's room still reads, for Hana.
  const read = await f.call(s.host.cookie, 'GET', `/api/rooms/${s.room.id}/messages`);
  assert.equal(read.statusCode, 200, read.body);
  assert.ok(read.body.includes('A note from Zed that stays for the room'));
  // Zed can no longer sign in, and a second run finds nothing.
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: JSON.stringify({ name: zed.name, password: `Synthetic elric password ${zed.name}` }),
  });
  assert.ok(login.statusCode >= 400, login.body);
  await assert.rejects(
    eraseAccount(f.db, zed.operatorId, { now: Date.now(), confirm: true }),
    (error) => error instanceof AccountErasureError && error.code === 'not_found',
  );
});

test('a retained financial record keeps a tombstone row; a restore is erased again from the ledger', async (t) => {
  const f = await elricFixture(t);
  const ivy = await f.account('Ivy Erase');
  await f.agent(ivy, 'Ivy desk');
  await f.db.query(
    `INSERT INTO base_pay_lookups(lookup_id,account_id,chain_id,registry_address,agent_id,base_id,
       short_id,wallet,block,block_hash,issued_at,expires_at)
     VALUES ($1,$2,8453,$3,'1',1,'abc123',$3,1,$4,1,2)`,
    [`pl_${'a'.repeat(32)}`, ivy.operatorId, `0x${'1'.repeat(40)}`, `0x${'2'.repeat(64)}`],
  );
  const result = await eraseAccount(f.db, ivy.operatorId, { now: Date.now(), confirm: true });
  assert.equal(result.account, 'tombstone');
  // The lookup holds a foreign key to the row; the terms history and the count log keep the id.
  assert.deepEqual(result.retained, {
    account_terms_acceptance_history: 1,
    base_pay_lookups: 1,
    count_log_pending: 1,
    operators: 1,
  });
  const row = (
    await f.db.query<{ name: string; name_key: string; password_hash: string; kind: string }>(
      'SELECT name, name_key, password_hash, kind FROM operators WHERE id=$1',
      [ivy.operatorId],
    )
  ).rows[0]!;
  assert.deepEqual(row, {
    name: 'Deleted account',
    name_key: `erased:${accountHash(ivy.operatorId)}`,
    password_hash: '!',
    kind: 'owner',
  });
  assert.deepEqual(await holders(f.db, 'Ivy Erase'), []);
  await assert.rejects(
    eraseAccount(f.db, ivy.operatorId, { now: Date.now(), confirm: true }),
    (error) => error instanceof AccountErasureError && error.code === 'already_erased',
  );

  // After a restore the account is back: the ledger line erases it again; others are untouched.
  const back = await f.account('Restored Rui');
  const other = await f.account('Other Ola');
  const reapplied = await reapplyAccountErasures(f.db, [accountHash(back.operatorId)], {
    now: Date.now(),
    confirm: true,
  });
  assert.equal(reapplied.length, 1);
  assert.deepEqual(await holders(f.db, 'Restored Rui'), []);
  assert.ok((await holders(f.db, 'Other Ola')).length > 0);
  void other;
});

test('only person accounts are erased this way', async (t) => {
  const f = await elricFixture(t);
  const id = randomUUID();
  await f.db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt,kind) VALUES($1,'AI ws',$2,'!','!','ai')",
    [id, `ai:${id}`],
  );
  await assert.rejects(
    eraseAccount(f.db, id, { now: Date.now(), confirm: true }),
    (error) => error instanceof AccountErasureError && error.code === 'not_a_person',
  );
});

test('the operator script: dry run unless --confirm, and the ledger names no one', () => {
  const id = randomUUID();
  assert.deepEqual(parseErasureArgs(['--', 'erase', '--account', id]), {
    command: 'erase',
    account: id,
    confirm: false,
    ledger: null,
  });
  assert.deepEqual(parseErasureArgs(['reapply', '--ledger', 'l.jsonl', '--confirm']), {
    command: 'reapply',
    ledger: 'l.jsonl',
    confirm: true,
  });
  for (const argv of [
    ['erase'],
    ['erase', '--account', 'Zed'],
    ['erase', '--account', id, '--force'],
    // A confirmed erase is never run without a ledger to write first.
    ['erase', '--account', id, '--confirm'],
    ['erase', '--confirm', '--account', id],
    ['reapply'],
    ['drop'],
  ])
    assert.throws(() => parseErasureArgs(argv), /Usage|needs|Unknown/, argv.join(' '));
  assert.deepEqual(
    parseErasureArgs(['erase', '--account', id, '--ledger', 'l.jsonl', '--confirm']),
    {
      command: 'erase',
      account: id,
      confirm: true,
      ledger: 'l.jsonl',
    },
  );
  const entry = { account_sha256: accountHash(id), erased_at: '2026-10-25T00:00:00.000Z' };
  const op = randomUUID();
  const line = ledgerLine(entry, 'done', op);
  assert.ok(!line.includes(id));
  assert.deepEqual(parseLedger(`${line}\n\n${line}\n`), [accountHash(id)]);
  assert.throws(() => parseLedger('{"x":1}'), /account_sha256/);
  // An older ledger's line (no state) still erases again.
  assert.deepEqual(parseLedger(JSON.stringify(entry)), [accountHash(id)]);
  // An intent without a done line erases again; an aborted run's intent does not.
  assert.deepEqual(parseLedger(ledgerLine(entry, 'intent', op)), [accountHash(id)]);
  assert.deepEqual(
    parseLedger(`${ledgerLine(entry, 'intent', op)}\n${ledgerLine(entry, 'aborted', op)}\n`),
    [],
  );
  assert.throws(() => parseLedger(JSON.stringify({ ...entry, state: 'intent' })), /operation id/);
  assert.throws(() => parseLedger(JSON.stringify({ ...entry, state: 'maybe' })), /state/);
});

test('an aborted run cancels only its own intent, never a done line, whatever the times', () => {
  const entry = {
    account_sha256: accountHash(randomUUID()),
    erased_at: '2026-10-25T00:00:00.000Z',
  };
  const kept = [entry.account_sha256];
  const [first, second] = [randomUUID(), randomUUID()];
  const ledger = (...lines: Array<[Parameters<typeof ledgerLine>[1], string]>) =>
    lines.map(([state, op]) => ledgerLine(entry, state, op)).join('\n');
  // A committed run, then a later refused run in the same millisecond.
  assert.deepEqual(
    parseLedger(
      ledger(['intent', first], ['done', first], ['intent', second], ['aborted', second]),
    ),
    kept,
  );
  // A done line is never cancelled, not even by an aborted line of its own run.
  assert.deepEqual(parseLedger(ledger(['done', first], ['aborted', first])), kept);
  // Same time, different runs: one run's abort leaves the other run's intent standing.
  assert.deepEqual(
    parseLedger(ledger(['intent', first], ['intent', second], ['aborted', second])),
    kept,
  );
  assert.deepEqual(
    parseLedger(ledger(['intent', first], ['aborted', second], ['intent', second])),
    kept,
  );
  // Both runs aborted: nothing to erase again.
  assert.deepEqual(
    parseLedger(
      ledger(['intent', first], ['aborted', first], ['intent', second], ['aborted', second]),
    ),
    [],
  );
  // An older ledger's line (no state, no id) is a done line.
  assert.deepEqual(
    parseLedger(`${JSON.stringify(entry)}\n${ledger(['intent', second], ['aborted', second])}`),
    kept,
  );
});

/** A ledger directory of the test's own, removed after it. */
async function ledgerDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-erase-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const states = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { state?: string }).state);

const nameOf = async (db: Database, id: string) =>
  (await db.query<{ name: string }>('SELECT name FROM operators WHERE id=$1', [id])).rows[0]?.name;

test('a confirmed erase writes its intent line to disk before it commits, and its done line after', async (t) => {
  const f = await elricFixture(t);
  const pia = await f.account('Pia Ledger');
  await f.agent(pia, 'Pia desk');
  const ledger = join(await ledgerDir(t), 'erasures.jsonl');
  const seen: Array<{ state: string | undefined; name: string | undefined }> = [];
  const run = await runAccountErasure(
    f.db,
    { command: 'erase', account: pia.operatorId, confirm: true, ledger },
    {
      now: Date.now(),
      readLedger: (path) => readFile(path, 'utf8'),
      append: async (path, line) => {
        // What the database holds at the moment each line is written.
        seen.push({
          state: (JSON.parse(line) as { state?: string }).state,
          name: await nameOf(f.db, pia.operatorId),
        });
        await appendDurably(path, line);
      },
    },
  );
  assert.equal(run.exitCode, 0, JSON.stringify(run.output));
  assert.equal(run.output.applied, true);
  assert.deepEqual(seen, [
    { state: 'intent', name: 'Pia Ledger' },
    { state: 'done', name: undefined },
  ]);
  const text = await readFile(ledger, 'utf8');
  assert.deepEqual(states(text), ['intent', 'done']);
  const ops = text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { op: string }).op);
  assert.equal(new Set(ops).size, 1);
  assert.ok(!text.includes(pia.operatorId));
  assert.deepEqual(parseLedger(text), [accountHash(pia.operatorId)]);
  assert.deepEqual(await holders(f.db, 'Pia Ledger'), []);
});

test('a ledger that cannot be written leaves the account untouched', async (t) => {
  const f = await elricFixture(t);
  const rex = await f.account('Rex Unwritten');
  await f.agent(rex, 'Rex desk');
  const before = await rowCounts(f.db);
  // The ledger's directory does not exist: the intent line cannot be written.
  const ledger = join(await ledgerDir(t), 'missing', 'erasures.jsonl');
  const run = await runAccountErasure(
    f.db,
    { command: 'erase', account: rex.operatorId, confirm: true, ledger },
    { now: Date.now(), readLedger: (path) => readFile(path, 'utf8') },
  );
  assert.equal(run.exitCode, 1);
  assert.equal(run.output.intent, 'failed');
  assert.equal(run.output.erasure, 'not committed');
  assert.match(String(run.output.error), /nothing was erased/);
  assert.equal(await nameOf(f.db, rex.operatorId), 'Rex Unwritten');
  assert.deepEqual(await rowCounts(f.db), before);
});

test('a run stopped after the commit is erased again from the ledger after a restore', async (t) => {
  const f = await elricFixture(t);
  const sol = await f.account('Sol Restored');
  await f.agent(sol, 'Sol desk');
  const ledger = join(await ledgerDir(t), 'erasures.jsonl');
  const readLedger = (path: string) => readFile(path, 'utf8');
  let writes = 0;
  // The intent line is written; the process stops before the done line (here: its write fails).
  const run = await runAccountErasure(
    f.db,
    { command: 'erase', account: sol.operatorId, confirm: true, ledger },
    {
      now: Date.now(),
      readLedger,
      append: async (path, line) => {
        if (writes++) throw new Error('disk full');
        await appendDurably(path, line);
      },
    },
  );
  assert.equal(run.exitCode, 1);
  assert.equal(run.output.intent, 'written');
  assert.equal(run.output.erasure, 'committed');
  assert.equal(run.output.done, 'failed');
  assert.equal((run.output.result as { applied: boolean }).applied, true);
  assert.equal(await nameOf(f.db, sol.operatorId), undefined);
  assert.deepEqual(states(await readFile(ledger, 'utf8')), ['intent']);

  // A backup from before the erasure is restored: the account is back.
  await f.db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt,kind) VALUES($1,'Sol Restored',$2,'!','!','owner')",
    [sol.operatorId, 'sol restored'],
  );
  const other = await f.account('Other Una');
  const reapplied = await runAccountErasure(
    f.db,
    { command: 'reapply', ledger, confirm: true },
    { now: Date.now(), readLedger },
  );
  assert.equal(reapplied.exitCode, 0);
  assert.equal((reapplied.output.results as unknown[]).length, 1);
  assert.deepEqual(await holders(f.db, 'Sol Restored'), []);
  assert.equal(await nameOf(f.db, other.operatorId), 'Other Una');
  // Reapplying again is safe: nothing is left to erase.
  const again = await runAccountErasure(
    f.db,
    { command: 'reapply', ledger, confirm: true },
    { now: Date.now(), readLedger },
  );
  assert.deepEqual(again.output.results, []);
});

test('a run stopped between the intent line and the commit is finished from the ledger', async (t) => {
  const f = await elricFixture(t);
  const tia = await f.account('Tia Halfway');
  const ledger = join(await ledgerDir(t), 'erasures.jsonl');
  const readLedger = (path: string) => readFile(path, 'utf8');
  const run = await runAccountErasure(
    f.db,
    { command: 'erase', account: tia.operatorId, confirm: true, ledger },
    {
      now: Date.now(),
      readLedger,
      erase: async () => {
        throw new Error('connection lost');
      },
    },
  );
  assert.equal(run.exitCode, 1);
  assert.equal(run.output.intent, 'written');
  assert.equal(run.output.erasure, 'unknown');
  assert.match(String(run.output.next), /reapply/);
  assert.equal(await nameOf(f.db, tia.operatorId), 'Tia Halfway');
  const reapplied = await runAccountErasure(
    f.db,
    { command: 'reapply', ledger, confirm: true },
    { now: Date.now(), readLedger },
  );
  assert.equal((reapplied.output.results as unknown[]).length, 1);
  assert.equal(await nameOf(f.db, tia.operatorId), undefined);
});

test('a refused erase cancels its intent line', async (t) => {
  const f = await elricFixture(t);
  const ledger = join(await ledgerDir(t), 'erasures.jsonl');
  const run = await runAccountErasure(
    f.db,
    { command: 'erase', account: randomUUID(), confirm: true, ledger },
    { now: Date.now(), readLedger: (path) => readFile(path, 'utf8') },
  );
  assert.equal(run.exitCode, 1);
  assert.equal(run.output.erasure, 'not committed');
  assert.equal(run.output.aborted, 'written');
  assert.match(String(run.output.error), /not_found/);
  const text = await readFile(ledger, 'utf8');
  assert.deepEqual(states(text), ['intent', 'aborted']);
  assert.deepEqual(
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { op: string }).op),
    [run.output.op, run.output.op],
  );
  assert.deepEqual(parseLedger(text), []);
});

test('the ledger write always flushes the file; the directory flush is skipped only on Windows', async (t) => {
  const path = join(await ledgerDir(t), 'erasures.jsonl');
  const synced: string[] = [];
  const syncDir = async (dir: string) => {
    synced.push(dir);
  };
  await appendDurably(path, '{"a":1}', { platform: 'win32', syncDir });
  assert.deepEqual(synced, [], 'Windows cannot flush a directory handle');
  assert.equal(await readFile(path, 'utf8'), '{"a":1}\n');
  await appendDurably(path, '{"a":2}', { platform: 'linux', syncDir });
  await appendDurably(path, '{"a":3}', { platform: 'darwin', syncDir });
  assert.equal(synced.length, 2);
  const eperm = Object.assign(new Error('EPERM: operation not permitted, fsync'), {
    code: 'EPERM',
  });
  await assert.rejects(
    appendDurably(path, '{"a":4}', {
      platform: 'linux',
      syncDir: async () => {
        throw eperm;
      },
    }),
    /EPERM/,
    'a directory flush failure elsewhere refuses the write',
  );
});
