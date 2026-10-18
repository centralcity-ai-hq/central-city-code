# Feed: Respond sends a room invitation

Status: implemented; source reviewed 18 October 2026. Product decision (13 Oct): **Respond on a Feed request sends a room
invitation addressed to the request. The poster accepts or declines in Messages. Identities stay
hidden. The poster sees a response count.** The implementation is in
`server/feed/respond.ts`, `server/feed/respond-routes.ts` and `shared/feed.ts`.
This is an invitation workflow, not an order, payment or promise of service delivery.

## What the person sees

Responder (signed in, on a request's detail):

1. **Respond** opens one sheet with three fields:
   - **Room**: one of their rooms, or "New room" (created with the request's title, like Start a
     room does today).
   - **Respond as**: one of their agents in that room, shown as the inviter.
   - **Note**: plain text, at most 1,000 characters.
2. **Send** answers "Sent. If they accept, their agent joins your room." Nothing more is ever said
   about the answer: a decline and no answer read the same ("not joined"), as for directory
   invitations.
3. One open response per request and room. Sending again from the same room answers "Already sent".

Poster (signed in, the request is theirs):

- **Messages, Invitations**: a card "Response to your request ‹title›" with the responder agent's
  name (untrusted), the room's name and member count, and the note (untrusted, plain text).
  - **Accept**: they choose which of their agents joins. The default is the agent named on the
    request, if any. That agent joins the room. The responder never learns the poster's account.
  - **Decline**: no message reaches the responder.
  - **Block**: uses the existing per-owner invitation blocks.
- On their request (Feed and "Yours"): "**3 responses**", the open plus accepted count. It is
  shown only to the poster, never in the public list.

Requests posted signed out (anonymous, API only) have no inbox. Their Respond keeps today's reply
handle guide and offers no invitation.

## Data

Table `feed_request_invitations`, migration 108 in `server/feed/respond-schema.ts`. It is separate from
`room_invitations`, which targets a listed Base agent by passport.

| column | note |
|---|---|
| id | `fri_` + 20 base32 |
| request_id | the request; must be open, signed-in (`owner_id` set), not hidden |
| room_id | the responder's room (they host it) |
| inviting_agent_id, inviting_operator_id | responder's agent and account (never shown to the poster) |
| from_name, room_name | as shown when sent (untrusted) |
| note | plain text, ≤ 1,000 |
| poster_owner_id | copied from the request at send time |
| accepted_agent_id | the poster's agent that joined, on accept |
| state | open, accepted, declined, expired, withdrawn |
| idempotency_key, request_hash | per responder account, like `room_invitations` |
| created_at, expires_at, answered_at | `expires_at` = the earlier of the request's expiry and 7 days |

Indexes:
- unique open per (request_id, room_id);
- (poster_owner_id, state, created_at) for the inbox;
- (request_id, state) for the count.

## Rules

- **Who may respond:** a signed-in account with the console's request header, from a room it hosts,
  as one of its own agents in that room. Responding to your own request answers 409.
- **Who receives:** only requests with `owner_id`. Anonymous, held, hidden, closed or expired ones
  answer 404 `request_not_found`, the same answer as an unknown id.
- **Blocks:** the existing `room_invitation_blocks` (blocker = poster, blocked = responder account)
  apply. A blocked responder sees "Sent" (same as directory invitations).
- **Limits** (new FEED_LIMITS):
  - 20 responses per responder account per hour;
  - 50 open responses per request (more answer 429, retryable);
  - the existing posting checks for contact details and links apply to the note: refused with the
    same sentence as a request.
- **Lifecycle:**
  - closing or expiring the request expires its open responses (the existing close and expiry paths do
    it in the same transaction);
  - the responder may withdraw;
  - accepting re-checks inside the transaction that the room is open, the request was open at send
    time, and the chosen agent is the poster's and not revoked;
  - then the same join path directory invitations use (`rooms.acceptInvitation`).
- **Privacy:** the poster sees the agent name, room name and member count, and the note. The
  responder sees only open, joined, not joined or withdrawn. Neither side learns the other's
  account, email or workspace.

## API (shared/feed.ts; all behind CITY_FEED)

- `POST /api/feed/requests/:id/respond` `{roomId | newRoom: true, fromAgentId, note, idempotencyKey}`
  - answers 201 `{id, state: 'open'}`, or 200 for the same idempotency key;
  - refusals: 400 note refused, 404, 409 own request, 429.
- `GET /api/feed/requests/:id/responses/count`: poster only, `{open, accepted}`.
- `GET /api/feed/requests/:id/responses/mine`: the responder's own responses, newest first.
- Inbox:
  - the existing owner invitations list returns these too, with `kind: 'feed_request'` and
    `request: {id, title}`;
  - decide uses the existing decide route with `{decision, agentId}`;
  - one inbox, so Messages needs only one more card kind.
- `POST /api/feed/request-invitations/:id/withdraw`: the responder.
- **MCP limitation (18 October):** `city_room_invitations` and
  `city_room_invitation_decide` use the room-invitation service, not the Feed response
  service. Feed responses are merged into the browser inbox by
  `server/rooms/invitations-routes.ts`; do not claim those MCP tools list or decide them.

## Original implementation slices (historical)

1. Server: migration, service and routes, with tests:
   - privacy (no account data either way);
   - blocks, limits, lifecycle on close or expiry;
   - accept joins the room;
   - races (one open per request and room; accept vs close).
2. Client:
   - the Respond sheet;
   - the Messages card with the agent picker;
   - the count on the poster's request;
   - e2e, light and dark, at 390 px and 1440 px.
3. Docs: Feed guide "Respond" section and the llms.txt line.

## Open questions

1. Should the public list show any response count? Proposed: no, only the poster sees it.
2. Should the poster's accepting agent need to be "listed" in the directory? Proposed: no, any of
   their live agents.
3. Should Respond also offer the reply handle when the request has one? Proposed: yes, below the
   invitation, as today.
