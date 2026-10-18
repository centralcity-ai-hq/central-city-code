import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgresDatabase, type Database } from '../server/database.js';
import type { InvitationPausePoint } from '../server/rooms/invitations.js';
import { DIRECTORY_PATHS, INVITE_PATHS } from '../shared/directory.js';
import { fixture } from './room-invitations-fixture.js';

/*
 * Room invitations under real concurrency (the postgres-races CI job): a block of the inviting
 * owner and a send or an accept that is already under way. Each test pauses one transaction at a
 * named point (RoomInvitationDependencies.pause), commits the block on another connection, then
 * lets the paused transaction go on. Needs CITY_TEST_POSTGRES_URL (a role that may create
 * databases): each test runs on a fresh database with a real pool. On PGlite (one connection) the
 * paused transaction would hold the only connection, so these are skipped without it. Synthetic
 * data only.
 */
const POSTGRES = process.env.CITY_TEST_POSTGRES_URL;
const options = { skip: POSTGRES ? false : 'CITY_TEST_POSTGRES_URL not set', timeout: 60_000 };

async function database(t: TestContext): Promise<Database> {
  const name = `city_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: POSTGRES, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(POSTGRES!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 });
  // The test owns the pool: it ends it before the drop (see invite-join-concurrency.test.ts).
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  return { ...postgresDatabase(pool), close: async () => {} };
}

/** One pause point, armed once: `reached` resolves when a transaction stops there. */
function barrier(point: InvitationPausePoint) {
  let armed = false;
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    arm: () => (armed = true),
    reached,
    release,
    pause: async (at: InvitationPausePoint) => {
      if (!armed || at !== point) return;
      armed = false;
      reach();
      await released;
    },
  };
}

test(
  'a block that commits while a send is past its first block check: no open invitation',
  options,
  async (t) => {
    const gate = barrier('send:resolved');
    const f = await fixture(t, { database: await database(t), pause: gate.pause });
    const guest = await f.account('Race guest');
    const baseId = await f.baseAgent(guest);
    // A first invitation, so the guest's owner can block this host by it.
    const first = await f.invite(baseId);
    assert.equal(first.statusCode, 201, first.body);
    const other = await f.send('POST', '/api/rooms', f.host.cookie, {
      name: 'Second room',
      agent_id: f.host.agentId,
      idempotency_key: randomUUID(),
    });
    assert.equal(other.statusCode, 201, other.body);
    const roomB = other.json().room.id as string;

    gate.arm();
    const sending = f.invite(baseId, {}, f.host, roomB);
    await gate.reached;
    // The send has resolved the agent (not blocked yet) and holds its transaction open.
    const blocked = await f.send(
      'POST',
      INVITE_PATHS.block.replace(':agentId', guest.agentId),
      guest.cookie,
      { invitationId: first.json().id },
    );
    assert.equal(blocked.statusCode, 200, blocked.body);
    gate.release();
    const sent = await sending;
    assert.equal(sent.statusCode, 404, sent.body);
    assert.equal(sent.json().code, 'agent_not_found');
    const open = await f.db.query(
      "SELECT 1 FROM room_invitations WHERE invited_agent_id=$1 AND state='open'",
      [guest.agentId],
    );
    assert.equal(open.rows.length, 0);
  },
);

test(
  'an accept paused before its recheck while a block commits: refused, never a member',
  options,
  async (t) => {
    const gate = barrier('accept:recheck');
    const f = await fixture(t, { database: await database(t), pause: gate.pause });
    const guest = await f.account('Race accept');
    const id = (await f.invite(await f.baseAgent(guest))).json().id as string;

    gate.arm();
    const accepting = f.decide(guest, id, 'accept');
    await gate.reached;
    // The accept holds the room row and the workspaces, not yet the invitation or the owner lock.
    const blocked = await f.send(
      'POST',
      INVITE_PATHS.block.replace(':agentId', guest.agentId),
      guest.cookie,
      { invitationId: id },
    );
    assert.equal(blocked.statusCode, 200, blocked.body);
    gate.release();
    const accepted = await accepting;
    assert.equal(accepted.statusCode, 409, accepted.body);
    assert.equal(accepted.json().code, 'invitation_closed');
    const member = await f.db.query(
      'SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2 AND removed_at IS NULL',
      [f.roomId, guest.agentId],
    );
    assert.equal(member.rows.length, 0);
    assert.equal((await f.messages(guest)).statusCode, 404);
  },
);

/** Several one-shot barriers behind the fixture's one pause hook. */
function gates() {
  const all: Array<ReturnType<typeof barrier>> = [];
  return {
    add(point: InvitationPausePoint) {
      const gate = barrier(point);
      all.push(gate);
      return gate;
    },
    pause: async (at: InvitationPausePoint) => {
      for (const gate of all) await gate.pause(at);
    },
  };
}

test(
  'an opt-out (invitations never) committed while an accept is paused: refused',
  options,
  async (t) => {
    const g = gates();
    const f = await fixture(t, { database: await database(t), pause: g.pause });
    for (const change of [{ invitations: 'never' }, { listed: false, invitations: 'never' }]) {
      const guest = await f.account(`Opt out ${Object.keys(change).join(' ')}`);
      const id = (await f.invite(await f.baseAgent(guest))).json().id as string;
      const gate = g.add('accept:recheck');
      gate.arm();
      const accepting = f.decide(guest, id, 'accept');
      await gate.reached;
      const saved = await f.send(
        'PATCH',
        DIRECTORY_PATHS.settings.replace(':agentId', guest.agentId),
        guest.cookie,
        change,
      );
      assert.equal(saved.statusCode, 200, saved.body);
      gate.release();
      const accepted = await accepting;
      assert.equal(accepted.statusCode, 409, accepted.body);
      assert.equal(accepted.json().code, 'invitation_closed');
      assert.equal((await f.messages(guest)).statusCode, 404);
    }
  },
);

test(
  'a settings save waits for an accept that already passed its checks (the row is held FOR SHARE)',
  options,
  async (t) => {
    const g = gates();
    const f = await fixture(t, { database: await database(t), pause: g.pause });
    const guest = await f.account('Checked');
    const id = (await f.invite(await f.baseAgent(guest))).json().id as string;
    const gate = g.add('accept:checked');
    gate.arm();
    const accepting = f.decide(guest, id, 'accept');
    await gate.reached;
    let saveDone = false;
    const saving = f
      .send('PATCH', DIRECTORY_PATHS.settings.replace(':agentId', guest.agentId), guest.cookie, {
        invitations: 'never',
      })
      .then((response) => {
        saveDone = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(saveDone, false, 'the save waits for the accept');
    gate.release();
    const accepted = await accepting;
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().state, 'accepted');
    const saved = await saving;
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().invitations, 'never');
  },
);
