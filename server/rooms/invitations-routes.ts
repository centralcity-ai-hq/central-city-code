import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { INVITE_PATHS, type OwnerInboxItem } from '../../shared/directory.js';
import { FEED_REQUEST_INVITATION_ID } from '../../shared/feed.js';
import type { FeedRespond } from '../feed/respond.js';
import { roomRefSchema } from './contract.js';
import { clientAddressKey } from '../rate-limit.js';
import { RoomError, type RoomPrincipal } from './service.js';
import type { RoomInvitations } from './invitations.js';

export { INVITE_PATHS };

export interface InvitationRouteDependencies {
  invitations: RoomInvitations;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
  /**
   * Feed Respond (server/feed/respond.ts): responses to the owner's Feed requests share the inbox
   * and its decide route, while `enabled` (the Feed is on, read per request) says so.
   */
  feed?: { respond: Pick<FeedRespond, 'inbox' | 'decide'>; enabled(): boolean };
}

/*
 * Owner console REST for room invitations (rooms/invitations.ts; the paths are INVITE_PATHS in
 * shared/directory.ts). Always on. Writes go through the console's request guard (header, JSON)
 * in server/app.ts. Room hosts send, list and withdraw; the invited agent's owner lists, decides
 * and blocks. Another account's agent or invitation: 404, the same answer as an unknown one.
 * While the Feed is on, the inbox also lists responses to the owner's Feed requests (kind
 * 'feed_request', fri_ ids) and the inbox decide answers them; off, they are not listed and a fri_
 * id answers 404 invitation_not_found.
 */
export function registerInvitationRoutes(
  app: FastifyInstance,
  d: InvitationRouteDependencies,
): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
    address: clientAddressKey(request.ip),
  });
  const roomParams = z.object({ room: roomRefSchema }).strict();
  const withdrawParams = z.object({ room: roomRefSchema, id: z.string() }).strict();
  // Malformed ids answer the service's 404s (agent_not_found, invitation_not_found).
  const agentParams = z.object({ agentId: z.string() }).strict();
  const decideParams = z.object({ agentId: z.string(), id: z.string() }).strict();
  const inboxParams = z.object({ id: z.string() }).strict();

  app.post(INVITE_PATHS.room, async (request, reply) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const { created, invitation } = await d.invitations.send(p, room, request.body ?? {});
    return reply.code(created ? 201 : 200).send(invitation);
  });
  app.get(INVITE_PATHS.room, async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return { invitations: await d.invitations.sent(p, room) };
  });
  app.post(INVITE_PATHS.withdraw, async (request) => {
    const p = await principal(request);
    const { room, id } = withdrawParams.parse(request.params);
    return d.invitations.withdraw(p, room, id);
  });
  app.get(INVITE_PATHS.received, async (request) => {
    const p = await principal(request);
    const { agentId } = agentParams.parse(request.params);
    return { invitations: await d.invitations.received(p, agentId) };
  });
  app.post(INVITE_PATHS.decide, async (request) => {
    const p = await principal(request);
    const { agentId, id } = decideParams.parse(request.params);
    return d.invitations.decide(p, agentId, id, request.body ?? {});
  });
  // The owner's inbox: open invitations to all of its agents (and open responses to its Feed
  // requests), newest first, answered by invitation id.
  app.get(INVITE_PATHS.inbox, async (request) => {
    const p = await principal(request);
    const rooms = (await d.invitations.inbox(p)).map((item) => ({
      ...item,
      kind: 'room' as const,
    }));
    const feed = d.feed?.enabled() ? await d.feed.respond.inbox(p) : [];
    const invitations: OwnerInboxItem[] = [...rooms, ...feed].sort(
      (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return { invitations };
  });
  app.post(INVITE_PATHS.inboxDecide, async (request) => {
    const p = await principal(request);
    const { id } = inboxParams.parse(request.params);
    if (FEED_REQUEST_INVITATION_ID.test(id)) {
      if (!d.feed?.enabled())
        throw new RoomError(404, 'invitation_not_found', 'Invitation not found.');
      return d.feed.respond.decide(p, id, request.body ?? {});
    }
    return d.invitations.decideById(p, id, request.body ?? {});
  });
  app.post(INVITE_PATHS.block, async (request) => {
    const p = await principal(request);
    const { agentId } = agentParams.parse(request.params);
    // Blocking by a response (fri_ id) needs the Feed on; a block made then can always be lifted
    // (DELETE takes the id whatever the flag).
    const invitationId = (request.body as { invitationId?: unknown } | null)?.invitationId;
    if (
      typeof invitationId === 'string' &&
      FEED_REQUEST_INVITATION_ID.test(invitationId) &&
      !d.feed?.enabled()
    )
      throw new RoomError(404, 'invitation_not_found', 'Invitation not found.');
    return d.invitations.block(p, agentId, request.body ?? {});
  });
  app.get(INVITE_PATHS.block, async (request) => {
    const p = await principal(request);
    const { agentId } = agentParams.parse(request.params);
    return { blocks: await d.invitations.blocked(p, agentId) };
  });
  app.delete(INVITE_PATHS.block, async (request) => {
    const p = await principal(request);
    const { agentId } = agentParams.parse(request.params);
    return d.invitations.unblock(p, agentId, request.body ?? {});
  });
}
