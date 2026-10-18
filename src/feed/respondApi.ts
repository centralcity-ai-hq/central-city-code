import { useEffect, useState } from 'react';
import {
  FEED_REQUEST_ID,
  FEED_RESPOND_LIMITS,
  FEED_RESPOND_PATHS,
  type FeedRespond,
  type FeedResponseCount,
  type FeedResponseSent,
  type PublicFeedRequest,
} from '../../shared/feed';
import type { Agent } from '../../shared/types';
import { api, selectedWorkspaceId } from '../api';
import { getElricStatus } from '../rooms/api';
import { isPagedWorkspace, noteSnapshotPaging, snapshotPage } from '../agents/agentPages';
import { searchLiveAgents } from '../agents/ownAgents';
import type { AgentsPageInfo } from '../../shared/types';
import { call, FeedFailure, withId, type Fetcher } from './feedApi';
import { codePoints, plain } from './feedFormat';

/*
 * Feed Respond on the responder's side (docs/FEED_RESPOND.md, shared/feed.ts FEED_RESPOND_PATHS):
 * a response is a room invitation addressed to a signed-in request. The responder picks one of
 * the rooms it hosts (or a new room named after the request), one of its agents in that room and
 * a short note; the poster accepts or declines in Messages. The poster alone sees how many
 * responses its request has. Every call goes through the Feed's data layer (feedApi call): the
 * console's request header on writes, one quiet retry for reads, failures as FeedFailure.
 */

type Options = { signal?: AbortSignal; fetcher?: Fetcher; retryDelayMs?: number };

const badId = () => Promise.reject(new FeedFailure(404, 'request_not_found', false));

export function sendResponse(id: string, body: FeedRespond, options: Options = {}) {
  if (!FEED_REQUEST_ID.test(id)) return badId();
  return call<FeedResponseSent>(withId(FEED_RESPOND_PATHS.respond, id), {
    ...options,
    method: 'POST',
    body,
  });
}

/** The caller's own responses to this request, newest first ("Already sent", Withdraw). */
export async function getMyResponses(id: string, options: Options = {}) {
  if (!FEED_REQUEST_ID.test(id)) return badId();
  const { responses } = await call<{ responses: FeedResponseSent[] }>(
    withId(FEED_RESPOND_PATHS.mine, id),
    options,
  );
  return responses;
}

export function withdrawResponse(responseId: string, options: Options = {}) {
  return call<FeedResponseSent>(withId(FEED_RESPOND_PATHS.withdraw, responseId), {
    ...options,
    method: 'POST',
    body: {},
  });
}

/** The poster's own count; anyone else hears 404 request_not_found (as for an unknown id). */
export function getResponseCount(id: string, options: Options = {}) {
  if (!FEED_REQUEST_ID.test(id)) return badId();
  return call<FeedResponseCount>(withId(FEED_RESPOND_PATHS.count, id), options);
}

/** "3 responses": open and accepted together; null while the count is unknown. */
export function responsesText(count: FeedResponseCount | null): string | null {
  if (!count) return null;
  const total = count.open + count.accepted;
  if (!total) return 'No responses yet';
  return `${total} ${total === 1 ? 'response' : 'responses'}`;
}

/** A request posted signed out has no inbox: Respond keeps the reply-handle guide. */
export const canInvite = (request: Pick<PublicFeedRequest, 'postedBy'>) =>
  request.postedBy.kind !== 'anonymous';

// ---------------------------------------------------------------------------------------------
// The note, as the server stores and counts it

/**
 * Letters and symbols that render as a blank (the Hangul fillers, the blank Braille pattern): a
 * space, as server/feed/policy.ts BLANK_LOOKING.
 */
const BLANK_LOOKING = /[\u115f\u1160\u2800\u3164\uffa0]/gu;
/**
 * What the server drops from a text of several lines (policy.ts DROP_MULTI_LINE): control and
 * format characters (newline and tab stay), the line and paragraph separators, every
 * default-ignorable code point and the other invisible marks.
 */
const DROP_MULTI_LINE =
  /(?![\n\t])[\p{Cc}\p{Cf}\u2028\u2029\p{Default_Ignorable_Code_Point}\u034f\u17b4\u17b5]/gu;

/**
 * The note as the server cleans it before it counts and stores it (server/feed/policy.ts
 * cleanText, which server/feed/respond.ts checkNote applies): NFC, line breaks as \n, blank
 * looking letters a space, invisible characters dropped, spaces collapsed and trimmed per line,
 * at most one empty line in a row, trimmed. The form counts and sends exactly this.
 */
export function cleanNote(note: string): string {
  return note
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(BLANK_LOOKING, ' ')
    .replace(DROP_MULTI_LINE, '')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The note's length as the server counts it: code points of the cleaned text. */
export const noteLength = (note: string) => codePoints(cleanNote(note));

export const noteTooLong = (note: string) => noteLength(note) > FEED_RESPOND_LIMITS.noteMax;

// ---------------------------------------------------------------------------------------------
// The responder's rooms and agents (the console's own routes)

export interface HostedRoom {
  id: string;
  name: string;
}

export interface OwnAgent {
  id: string;
  name: string;
}

/** The value of the Room field that stands for "New room" (never a room id). */
export const NEW_ROOM = 'new';

/** One room as GET /api/rooms lists it (server/rooms/contract.ts RoomView), the fields used. */
export interface ListedRoom {
  id: string;
  name: string;
  role: string;
  /** null while open; the time it closed otherwise. */
  closed_at: string | null;
  closed?: boolean;
  private_agent_id?: string;
}

/**
 * The rooms Respond can invite into: hosted by the caller, open (closed_at null: a closed room
 * answers 409 room_closed), and not a private chat with one of its agents.
 */
export function invitableRooms(rooms: readonly ListedRoom[]): HostedRoom[] {
  return rooms
    .filter(
      (room) =>
        room.role === 'host' &&
        room.closed_at === null &&
        room.closed !== true &&
        !room.private_agent_id,
    )
    .map((room) => ({ id: room.id, name: plain(room.name) || 'Untitled room' }));
}

/** The rooms the caller hosts and could invite into (invitableRooms). */
export async function hostedRooms(signal?: AbortSignal): Promise<HostedRoom[]> {
  const { rooms } = await api<{ rooms: ListedRoom[] }>('/api/rooms', undefined, 'GET', signal);
  return invitableRooms(rooms);
}

/** The caller's own agents in this room (never its person member): one of them responds. */
export async function roomAgents(roomId: string, signal?: AbortSignal): Promise<OwnAgent[]> {
  const { members } = await api<{
    members: Array<{ id: string; name: string; kind?: string; own?: boolean }>;
  }>(`/api/rooms/${encodeURIComponent(roomId)}/members?limit=1000`, undefined, 'GET', signal);
  return members
    .filter((member) => member.own && member.kind !== 'person')
    .map((member) => ({ id: member.id, name: member.name }));
}

/** Who can host a new room, and why nobody can when the list is empty. */
export interface NewRoomAgents {
  agents: OwnAgent[];
  /** Live agents left out because they are paused (the server refuses a paused host). */
  paused: number;
  /** The whole workspace is paused: no room can be made (409 workspace_paused). */
  workspacePaused: boolean;
}

type SnapshotAgent = Pick<Agent, 'id' | 'name' | 'revokedAt' | 'pausedAt'> & { status?: string };

/**
 * The agents that may host a new room: live (not revoked), not paused, never Elric's own agent
 * (as rooms/api.ts listOwnAgents), and none while the workspace is paused.
 */
export function newRoomHosts(
  snapshot: { paused?: boolean; agents: readonly SnapshotAgent[] },
  elricId: string | null = null,
): NewRoomAgents {
  const live = snapshot.agents.filter(
    (agent) => !agent.revokedAt && agent.status !== 'revoked' && agent.id !== elricId,
  );
  const workspacePaused = snapshot.paused === true;
  const ready = workspacePaused ? [] : live.filter((agent) => !agent.pausedAt);
  return {
    agents: ready.map(({ id, name }) => ({ id, name })),
    paused: workspacePaused ? 0 : live.length - ready.length,
    workspacePaused,
  };
}

/**
 * The new room's possible hosts. In a paged workspace (src/agents/agentPages.ts) these come from
 * the snapshot's page of the newest agents; newRoomHostSearch finds the others.
 */
export async function newRoomAgents(signal?: AbortSignal): Promise<NewRoomAgents> {
  const workspace = selectedWorkspaceId();
  const [snapshot, elric] = await Promise.all([
    api<{ paused?: boolean; agents: SnapshotAgent[]; agentsPage?: AgentsPageInfo }>(
      '/api/snapshot',
      undefined,
      'GET',
      signal,
    ),
    getElricStatus(signal),
  ]);
  noteSnapshotPaging(workspace, snapshot);
  return newRoomHosts(
    { paused: snapshot.paused, agents: snapshotPage(snapshot) },
    elric?.agent_id ?? null,
  );
}

/**
 * The hosts of a new room that match `q`, over the whole workspace (GET /api/agents): only in a
 * paged workspace, where newRoomAgents lists the newest page; null elsewhere. `workspacePaused`
 * is the answer newRoomAgents gave: then nobody may host.
 */
export function newRoomHostSearch(
  workspacePaused: boolean,
): ((q: string, signal: AbortSignal) => Promise<OwnAgent[]>) | null {
  if (!isPagedWorkspace(selectedWorkspaceId())) return null;
  return async (q, signal) => {
    if (workspacePaused) return [];
    const [found, elric] = await Promise.all([searchLiveAgents(q, signal), getElricStatus(signal)]);
    return newRoomHosts({ agents: found }, elric?.agent_id ?? null).agents;
  };
}

/** The Respond as choice that stays valid: the one chosen while it is offered, else the first. */
export function keptAgent(agents: readonly OwnAgent[] | null, chosen: string): string {
  if (!agents?.length) return '';
  return agents.some((agent) => agent.id === chosen) ? chosen : agents[0]!.id;
}

/** The open response this room already sent to this request ("Already sent"), if any. */
export function openFromRoom(
  sent: readonly FeedResponseSent[] | null,
  roomId: string,
): FeedResponseSent | null {
  if (!sent || !roomId || roomId === NEW_ROOM) return null;
  return sent.find((item) => item.roomId === roomId && item.state === 'open') ?? null;
}

// ---------------------------------------------------------------------------------------------
// Words

/** "about 2 minutes" from a Retry-After; null without one. */
export function waitWords(ms: number | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes === 1) return 'about a minute';
  if (minutes < 90) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

/**
 * A refusal's sentence when it is written for people: the note rules (too long, contact details,
 * keys, held words) are, said of the note (the server checks a note as a request's description).
 * Field names and request shapes ("fromAgentId must ...", "Send either roomId or newRoom: true.")
 * are not, and are never shown.
 */
export function noteSentence(said: string | undefined): string | undefined {
  if (!said) return undefined;
  if (/\b[a-z]+[A-Z]\w*|\bSend\b|:\s*(?:true|false)\b/.test(said)) return undefined;
  if (/^The text is public: leave out email addresses and phone numbers\./.test(said))
    return 'Leave out email addresses and phone numbers. Agree on how to reach each other in the room.';
  return said.replace(/^The description\b/, 'The note');
}

/** Plain words for a refused response (no codes, no server text but the note rules). */
export function respondErrorCopy(error: unknown): string {
  const failure = error instanceof FeedFailure ? error : null;
  const code = failure?.code ?? (error instanceof TypeError ? 'network' : 'unknown');
  switch (code) {
    case 'response_open':
      return 'Already sent from this room. You can send from another room.';
    case 'own_request':
      return 'This is your own request.';
    case 'request_not_found':
      return 'This request isn’t open any more.';
    case 'not_room_host':
      return 'Only the room’s host can respond from it. Pick another room.';
    case 'room_not_found':
    case 'room_closed':
      return 'This room isn’t open any more. Pick another room.';
    case 'room_full':
      return 'This room is full. Pick another room.';
    case 'agent_not_found':
      return 'That agent isn’t in your workspace any more. Pick another one.';
    case 'idempotency_conflict':
      return 'This response changed while it was being sent. Send it again.';
    case 'invalid_request': {
      const said = noteSentence(failure?.said);
      if (said) return said;
      return /fromAgentId/.test(failure?.said ?? '')
        ? 'Respond as one of your agents in this room. Pick the room again.'
        : 'Something in the note isn’t right. Check it and try again.';
    }
    case 'rate_limited': {
      const wait = waitWords(failure?.retryAfterMs);
      return wait
        ? `Too many responses right now. Try again in ${wait}.`
        : 'Too many responses right now. Try again later.';
    }
    case 'signed_out':
      return 'You’re signed out. Sign in to respond.';
    case 'network':
      return 'We couldn’t reach Central City. Check your connection and try again.';
    case 'timeout':
      return 'Central City is taking too long to answer. Try again in a moment.';
    case 'busy':
    case 'server':
      return 'Central City is busy right now. Try again in a moment.';
    case 'not_found':
      return 'Responding isn’t available right now. Try again later.';
    case 'invitation_closed':
    case 'invitation_not_found':
      return 'This response is no longer open.';
    default:
      return 'That didn’t go through. Try again in a moment.';
  }
}

/**
 * The poster's count for this request, read once while `enabled`: null while unknown, for anyone
 * but the poster (404), signed out, or when it could not be read. Its answer also tells the page
 * the viewer posted this request (in an earlier visit too).
 */
export function useResponseCount(id: string, enabled: boolean): FeedResponseCount | null {
  const [count, setCount] = useState<{ id: string; value: FeedResponseCount } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    getResponseCount(id, { signal: controller.signal }).then(
      (value) => setCount({ id, value }),
      () => undefined,
    );
    return () => controller.abort();
  }, [id, enabled]);
  return enabled && count?.id === id ? count.value : null;
}
