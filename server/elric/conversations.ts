import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../database.js';
import { createPrivateRoom, PRIVATE_ROOM_NAME } from '../rooms/private.js';
import { RoomError } from '../rooms/service.js';
import { dayOf } from './config.js';
import { purgeElricConversation } from './erase.js';
import type { TitleSource } from './titles.js';

/**
 * Elric conversations: several private chats per owner, like a chat history. Each conversation is
 * a private room (rooms/private.ts, `elric_private`): the owner's person hosts it and the owner's
 * Elric is its only other member, so every Elric guarantee applies unchanged. The owner's first
 * chat (GET /api/elric/chat) is one of them. Owner console session only, like every /api/elric
 * route. Erased with the account (erase.ts removes every private room of the owner).
 *
 * - `GET /api/elric/conversations`: newest activity first, with titles.
 * - `POST /api/elric/conversations` `{ title? }`: a new conversation (at most
 *   CONVERSATIONS_MAX open and CONVERSATIONS_PER_DAY new ones per owner and day, deleted ones
 *   included; the revoke + re-add churn limit does not apply).
 * - `GET /api/elric/conversations/:id[?since=<seq>]`: one conversation's poll state.
 * - `PATCH /api/elric/conversations/:id` `{ title }`: rename.
 * - `DELETE /api/elric/conversations/:id`: deletes it for good, content included.
 *
 * A conversation without a title of its own is titled from its first message (the fallback), and
 * after Elric's first reply by a short generated title (titles.ts), unless the owner renamed it.
 */
type Q = Pick<Database, 'query'>;

/** Open (not deleted) conversations per owner, and new conversations per owner and 24 hours. */
export const CONVERSATIONS_MAX = 200;
export const CONVERSATIONS_PER_DAY = 200;
const DAY_MS = 86_400_000;
/** The title of a new conversation until its first message names it. */
export const NEW_CONVERSATION_TITLE = 'New chat';
export const TITLE_MAX = 80;
const UNTITLED = [PRIVATE_ROOM_NAME, NEW_CONVERSATION_TITLE];

export interface Conversation {
  id: string;
  slug: string;
  title: string;
  person_member_id: string;
  created_at: string;
  updated_at: string;
  latest_seq: number;
  /** The Elric of this conversation was removed: history only, no new messages. */
  read_only: boolean;
  /** 'fallback' (first message), 'user' (renamed or named at create) or 'auto' (titles.ts). */
  title_source: TitleSource;
}

const refuse = (statusCode: number, errorCode: string, message: string) =>
  new RoomError(statusCode, errorCode, message);

const noControl = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
const titleSchema = z.string().trim().min(1).max(TITLE_MAX).refine(noControl);
const createBody = z.object({ title: titleSchema.optional() }).strict();
const renameBody = z.object({ title: titleSchema }).strict();
const idParams = z.object({ id: z.string().min(1).max(200) }).strict();
const pollQuery = z
  .object({ since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() })
  .strict();

/** A title from the first message: mentions dropped, one line, cut at a word, at most 60. */
export function titleFrom(text: string): string | null {
  const plain = text
    .normalize('NFKC')
    .replace(/@"[^"]*"|@\S+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  if (plain.length <= 60) return plain;
  const cut = plain.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trim()}…`;
}

type Row = {
  id: string;
  slug: string;
  name: string;
  created_at: string | number;
  next_seq: string | number;
  closed_at: string | number | null;
  person: string | null;
  last_at: string | number | null;
  first_text: string | null;
  title_source: TitleSource;
};

const SELECT = `SELECT r.id, r.slug, r.name, r.created_at, r.next_seq, r.closed_at, r.title_source,
    (SELECT m.agent_id FROM room_members m WHERE m.room_id=r.id AND m.kind='person'
       AND m.owner_id=$1 AND m.role='host' LIMIT 1) AS person,
    (SELECT max(x.created_at) FROM room_messages x WHERE x.room_id=r.id) AS last_at,
    CASE WHEN r.name = ANY($2::text[]) THEN
      (SELECT string_agg(p->>'text', ' ') FROM room_messages f
         CROSS JOIN LATERAL jsonb_array_elements(f.parts) p
        WHERE f.room_id=r.id AND f.seq = (
          SELECT min(g.seq) FROM room_messages g JOIN room_members gm
            ON gm.room_id=g.room_id AND gm.agent_id=g.sender_agent_id AND gm.kind='person'
           WHERE g.room_id=r.id))
    END AS first_text
  FROM rooms r
 WHERE r.elric_private AND r.host_owner_id=$1 AND r.deleted_at IS NULL`;

/** Names untitled conversations from their first message (stored once). */
async function titled(db: Q, row: Row): Promise<string> {
  if (!UNTITLED.includes(row.name) || !row.first_text) return row.name;
  const title = titleFrom(row.first_text);
  if (!title) return row.name;
  await db.query('UPDATE rooms SET name=$2 WHERE id=$1 AND elric_private AND name=$3', [
    row.id,
    title,
    row.name,
  ]);
  return title;
}

async function view(db: Q, row: Row): Promise<Conversation> {
  return {
    id: row.id,
    slug: row.slug,
    title: await titled(db, row),
    person_member_id: row.person ?? '',
    created_at: new Date(Number(row.created_at)).toISOString(),
    updated_at: new Date(Number(row.last_at ?? row.created_at)).toISOString(),
    latest_seq: Number(row.next_seq) - 1,
    read_only: row.closed_at !== null,
    title_source: row.title_source,
  };
}

export async function listConversations(
  db: Q,
  ownerId: string,
): Promise<{ conversations: Conversation[] }> {
  const rows = (
    await db.query<Row>(
      // An empty chat (nothing said yet) is not listed, so unused chats never clutter the history;
      // it still opens by id, and the console starts a new chat on its first message.
      `${SELECT} AND r.next_seq > 1 ORDER BY COALESCE((SELECT max(x.created_at) FROM room_messages x
         WHERE x.room_id=r.id), r.created_at) DESC, r.id LIMIT ${CONVERSATIONS_MAX}`,
      [ownerId, UNTITLED],
    )
  ).rows;
  return { conversations: await Promise.all(rows.map((row) => view(db, row))) };
}

async function one(db: Q, ownerId: string, id: string): Promise<Row> {
  const row = (await db.query<Row>(`${SELECT} AND (r.id=$3 OR r.slug=$3)`, [ownerId, UNTITLED, id]))
    .rows[0];
  // Another owner's conversation, a shared room or a deleted one: the uniform not found.
  if (!row) throw refuse(404, 'conversation_not_found', 'Conversation not found.');
  return row;
}

/**
 * The conversation caps (in the caller's transaction, under the Elric row lock): at most
 * CONVERSATIONS_MAX open, and CONVERSATIONS_PER_DAY new ones in 24 hours and per UTC day (deleted
 * ones count, so delete and re-create cannot grow storage or churn without bound). A delete purges
 * the room, so the rolling count over rooms forgets it; the per-day counter on the owner's usage
 * row (migration 220) does not. Counts this creation when it passes: call it only right before
 * creating the conversation, in the same transaction.
 */
export async function assertConversationCaps(tx: Q, ownerId: string, time: number) {
  const row = (
    await tx.query<{
      open: string | number;
      recent: string | number;
      oldest: string | number | null;
    }>(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS open,
              count(*) FILTER (WHERE created_at > $2) AS recent,
              min(created_at) FILTER (WHERE created_at > $2) AS oldest
         FROM rooms WHERE elric_private AND host_owner_id=$1`,
      [ownerId, time - DAY_MS],
    )
  ).rows[0];
  if (Number(row?.open ?? 0) >= CONVERSATIONS_MAX)
    throw refuse(
      409,
      'too_many_conversations',
      `You have ${CONVERSATIONS_MAX} conversations. Delete one to start a new one.`,
    );
  const tooMany = (retryAfterMs: number) =>
    Object.assign(
      refuse(
        429,
        'too_many_new_conversations',
        'Too many new conversations today. Try again later.',
      ),
      { retryAfterMs: Math.max(1_000, retryAfterMs) },
    );
  if (Number(row?.recent ?? 0) >= CONVERSATIONS_PER_DAY)
    throw tooMany(Number(row!.oldest) + DAY_MS - time);
  const day = dayOf(time);
  await tx.query('INSERT INTO elric_usage(owner_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    ownerId,
    day,
  ]);
  const used = (
    await tx.query<{ conversations: string | number }>(
      'SELECT conversations FROM elric_usage WHERE owner_id=$1 AND day=$2 FOR UPDATE',
      [ownerId, day],
    )
  ).rows[0];
  if (Number(used?.conversations ?? 0) >= CONVERSATIONS_PER_DAY)
    throw tooMany(Date.parse(`${day}T00:00:00Z`) + DAY_MS - time);
  await tx.query(
    'UPDATE elric_usage SET conversations=conversations+1 WHERE owner_id=$1 AND day=$2',
    [ownerId, day],
  );
}

export async function createConversation(
  db: Pick<Database, 'query' | 'transaction'>,
  ownerId: string,
  time: number,
  title?: string,
): Promise<Conversation> {
  const id = await db.transaction(async (tx) => {
    // Under the Elric row lock, like the first chat: concurrent creates are counted in order.
    const elric = (
      await tx.query<{ agent_id: string }>(
        `SELECT agent_id FROM elric_agents WHERE owner_id=$1 AND status <> 'revoked' FOR UPDATE`,
        [ownerId],
      )
    ).rows[0];
    if (!elric) throw refuse(404, 'elric_not_found', 'You have no Elric.');
    await assertConversationCaps(tx, ownerId, time);
    const room = await createPrivateRoom(tx, { ownerId, elricAgentId: elric.agent_id, time });
    await tx.query('UPDATE rooms SET name=$2, title_source=$3 WHERE id=$1', [
      room.room_id,
      title ?? NEW_CONVERSATION_TITLE,
      title === undefined ? 'fallback' : 'user',
    ]);
    return room.room_id;
  });
  return view(db, await one(db, ownerId, id));
}

export async function renameConversation(db: Q, ownerId: string, id: string, title: string) {
  const row = await one(db, ownerId, id);
  // A title the owner chose: the generated title (titles.ts) never replaces it.
  await db.query(`UPDATE rooms SET name=$2, title_source='user' WHERE id=$1 AND elric_private`, [
    row.id,
    title,
  ]);
  return view(db, { ...row, name: title, title_source: 'user' });
}

/**
 * Deletes a conversation for good: the room and everything in it (messages, members, drafts,
 * Elric turns and posts), in one transaction (erase.ts purgeElricConversation). Its cost stays
 * only in the anonymous daily totals.
 */
export async function deleteConversation(
  db: Pick<Database, 'query' | 'transaction'>,
  ownerId: string,
  id: string,
) {
  const row = await one(db, ownerId, id);
  if (!(await purgeElricConversation(db, ownerId, row.id)))
    throw refuse(404, 'conversation_not_found', 'Conversation not found.');
  return { deleted: true as const, id: row.id };
}

export function registerElricConversations(
  app: FastifyInstance,
  d: {
    db: Pick<Database, 'query' | 'transaction'>;
    clock: () => number;
    owner: (request: FastifyRequest) => Promise<string>;
  },
): void {
  app.get('/api/elric/conversations', async (request) =>
    listConversations(d.db, await d.owner(request)),
  );
  app.post('/api/elric/conversations', async (request, reply) => {
    const ownerId = await d.owner(request);
    const { title } = createBody.parse(request.body ?? {});
    return reply.code(201).send(await createConversation(d.db, ownerId, d.clock(), title));
  });
  app.get('/api/elric/conversations/:id', async (request) => {
    const ownerId = await d.owner(request);
    const { id } = idParams.parse(request.params);
    pollQuery.parse(request.query);
    return view(d.db, await one(d.db, ownerId, id));
  });
  app.patch('/api/elric/conversations/:id', async (request) => {
    const ownerId = await d.owner(request);
    const { id } = idParams.parse(request.params);
    const { title } = renameBody.parse(request.body ?? {});
    return renameConversation(d.db, ownerId, id, title);
  });
  app.delete('/api/elric/conversations/:id', async (request) => {
    const ownerId = await d.owner(request);
    const { id } = idParams.parse(request.params);
    return deleteConversation(d.db, ownerId, id);
  });
}
