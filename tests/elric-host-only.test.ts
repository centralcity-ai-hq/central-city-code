import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { elricFixture } from './elric-fixture.js';
import { ELRIC_HOST_ONLY_CODE, ELRIC_HOST_ONLY_MESSAGE } from '../shared/elric-copy.js';

/**
 * Only the room's host may have their Elric in a room (at most one Elric per room). A member's
 * Elric is refused on every join path; the host's Elric and a member's own non-Elric AI are not.
 * Synthetic names only.
 */
async function setup(t: Parameters<typeof elricFixture>[0]) {
  const f = await elricFixture(t);
  const host = await f.account('Hana host');
  await f.verify(host);
  const hostAgent = await f.agent(host, 'Hana desk');
  const r = await f.room(host, hostAgent, 'Host only room');
  const member = await f.account('Milo member');
  await f.verify(member);
  const memberElric = await f.addElric(member);
  await f.joinPerson(member, r, 'Milo');
  const join = (who: { cookie: string }, body: object, url = `/api/rooms/${r.slug}/join`) =>
    f.call(who.cookie, 'POST', url, { idempotency_key: randomUUID(), ...body });
  const refused = (res: { statusCode: number; body: string; json(): unknown }) => {
    assert.equal(res.statusCode, 403, res.body);
    const body = res.json() as { code: string; error?: string; message?: string };
    assert.equal(body.code, ELRIC_HOST_ONLY_CODE);
    assert.ok(res.body.includes(ELRIC_HOST_ONLY_MESSAGE), res.body);
  };
  const elricIn = async () =>
    (
      await f.db.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM room_members m JOIN elric_agents e ON e.agent_id=m.agent_id
          WHERE m.room_id=$1 AND m.removed_at IS NULL`,
        [r.id],
      )
    ).rows[0]!.n;
  return { f, host, r, member, memberElric, join, refused, elricIn };
}

test("a member's Elric is refused with the room's invite link", async (t) => {
  const s = await setup(t);
  s.refused(await s.join(s.member, { token: s.r.token, agent_id: s.memberElric }));
  assert.equal(Number(await s.elricIn()), 0);
});

test("a member's Elric is refused by Add my AI (room id alone)", async (t) => {
  const s = await setup(t);
  s.refused(await s.join(s.member, { agent_id: s.memberElric }, `/api/rooms/${s.r.id}/join`));
  assert.equal(Number(await s.elricIn()), 0);
});

test("a member's Elric is refused even after it was paused and resumed (status does not matter)", async (t) => {
  const s = await setup(t);
  await s.f.call(s.member.cookie, 'POST', '/api/elric/pause');
  await s.f.call(s.member.cookie, 'POST', '/api/elric/resume');
  s.refused(await s.join(s.member, { token: s.r.token, agent_id: s.memberElric }));
});

test("the host's Elric joins; a member's non-Elric AI still joins", async (t) => {
  const s = await setup(t);
  const hostElric = await s.f.addElric(s.host);
  const hostJoin = await s.join(s.host, { agent_id: hostElric }, `/api/rooms/${s.r.id}/join`);
  assert.equal(hostJoin.statusCode, 200, hostJoin.body);
  assert.equal(Number(await s.elricIn()), 1);
  const own = await s.f.agent(s.member, 'Milo helper');
  const byLink = await s.join(s.member, { token: s.r.token, agent_id: own });
  assert.equal(byLink.statusCode, 200, byLink.body);
  const other = await s.f.agent(s.member, 'Milo second');
  const byRoom = await s.join(s.member, { agent_id: other }, `/api/rooms/${s.r.id}/join`);
  assert.equal(byRoom.statusCode, 200, byRoom.body);
});

test("a member's Elric already in a room stays; a new one is still refused", async (t) => {
  const s = await setup(t);
  // A room from before the rule: kept as is (never deleted by the server).
  await s.f.legacyElricMember(s.member, s.r, s.memberElric);
  assert.equal(Number(await s.elricIn()), 1);
  const other = await s.f.account('Nia member');
  await s.f.verify(other);
  const otherElric = await s.f.addElric(other);
  await s.f.joinPerson(other, s.r, 'Nia');
  s.refused(await s.join(other, { token: s.r.token, agent_id: otherElric }));
  assert.equal(Number(await s.elricIn()), 1);
});
