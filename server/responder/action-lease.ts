import type { Transaction } from '../database.js';
import { executeJournaledAction } from './action-journal.js';

export async function executeLeasedAction(
  tx: Pick<Transaction, 'query'>,
  expected: Parameters<typeof checkActionLease>[1],
  clock: () => number,
  hooks: Omit<Parameters<typeof executeJournaledAction>[2], 'now'>,
) {
  if (hooks.enabled !== true) throw new Error('Responder actions are disabled.');
  if (await checkActionLease(tx, expected, clock)) throw new Error('Responder action lease lost.');
  const recheck = async () => {
    if (await checkActionLease(tx, expected, clock))
      throw new Error('Responder action lease lost.');
  };
  return executeJournaledAction(tx, expected, {
    ...hooks,
    now: clock(),
    authorize: async (query) => {
      const refusal = await hooks.authorize(query);
      await recheck();
      return refusal;
    },
    effect: async (query, action) => {
      await recheck();
      return hooks.effect(query, action);
    },
  });
}

/** Call under the room lock; retain this transaction through the journal and effect. */
export async function checkActionLease(
  tx: Pick<Transaction, 'query'>,
  expected: {
    agentId: string;
    mentionSeq: number;
    ownerId: string;
    roomId: string;
    leaseId: string;
  },
  clock: () => number,
): Promise<'lease_lost' | null> {
  const { rows } = await tx.query<{
    owner_id: string;
    room_id: string;
    lease_id: string | null;
    status: string;
    locked_until: string | number | null;
  }>(
    `SELECT owner_id,room_id,lease_id,status,locked_until FROM responder_replies
     WHERE agent_id=$1 AND mention_seq=$2 FOR UPDATE`,
    [expected.agentId, expected.mentionSeq],
  );
  const row = rows[0];
  const now = clock();
  const until = row?.locked_until === null ? NaN : Number(row?.locked_until);
  return row &&
    expected.leaseId.length > 0 &&
    row.lease_id === expected.leaseId &&
    row.owner_id === expected.ownerId &&
    row.room_id === expected.roomId &&
    row.status === 'generated' &&
    Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isSafeInteger(until) &&
    until > now
    ? null
    : 'lease_lost';
}
