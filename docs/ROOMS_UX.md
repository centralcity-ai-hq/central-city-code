# Rooms UI

The Rooms experience in the console: a sidebar of your rooms, the open room as a chat, the host's
Invite sheet and the `/r/<slug>#<code>` join flow. It follows DESIGN_SYSTEM §2.3–2.7 and
§3.3–3.4 (ops), decisions E1–E7, and REDESIGN §8 (minimal, no illustrations).

Code: `src/rooms/`. Tests: `e2e/rooms.spec.ts` (screenshots with `SCREENSHOTS=1`). Server: [ROOMS.md](ROOMS.md),
[JOIN_LINKS.md](JOIN_LINKS.md).

Credit: the `RoomsClient` contract, `withRoomDeadline`, the "never put the invite in a URL"
rule and several e2e cases come from an earlier rooms UX pull request, which this
supersedes (E5).

## Mounting it (app shell)

```tsx
// src/main.tsx, before createRoot(...).render(...): the code leaves the URL before any render.
import { capturePendingJoin } from './rooms';
capturePendingJoin();

// Router: /rooms, /rooms/:id and /r/:slug render
<RoomsApp
  client={roomsClient} // createHttpRoomsClient(), created once
  signedIn={Boolean(operator)}
  workspaceId={activeWorkspace.id} // unread marks are per workspace
  accountName={operator?.name ?? ''}
  onSignIn={(next) => navigate(`/signin?next=${encodeURIComponent(next)}`)}
  nav={<SidebarLinks />} // optional: Agents, Settings, account menu
/>;
// /signin: after success, go to safeNext(params.get('next')).
```

`RoomsApp` reads `location.pathname` itself and navigates with `history.pushState` inside
`/rooms`. On `popstate` it follows the address. Mount it with a `key` of the workspace id, so
switching workspaces starts clean. `api()` keeps `X-City-Workspace`.

Until the shell mounts it, `src/rooms/harness.html` (development only) mounts the same component
against the live API. `e2e/rooms.spec.ts` serves it with Vite and proxies `/api` to its own API server (the same command as the Playwright web server), so its traffic never shares the per-address request budget with the rest of the suite.

## Join flow (§3.3)

1. **Capture.** `capturePendingJoin()` reads `/r/<slug>#<secret>` and stores
   `{kind:'room', slug, secret, at}` in `sessionStorage['cc.pendingJoin']` (30 min TTL). It then
   calls `history.replaceState(…, '/r/<slug>')`. It strips the fragment even when storage fails.
2. **Signed out.** The page offers "Sign in to join", which goes to `/signin?next=/r/<slug>`.
   `next` never carries the secret, and `safeNext` accepts room paths only.
3. **Signed in.** An existing member (or the host) goes straight to the room. Otherwise the page
   shows "Join as": an existing agent, or "A new agent named `{account}'s agent`" (join with
   `create`, atomic and idempotent). Then `POST /api/rooms/<slug>/join` runs with the secret in
   the body and a fresh `idempotency_key`.
4. **On success,** storage is cleared and `/rooms/<id>` replaces the entry. On 404 the page shows
   "This invite link is invalid or has expired. Ask the host for a new link.", and storage is
   cleared.

The e2e test asserts the guarantee from capture onwards:

- the address bar, every navigation, the history entries, `next`, and every request URL and
  `Referer` are free of the code;
- storage is empty after the join.

**Limits (stated in §3.3):**

- `sessionStorage` survives the same tab and a sign-in round trip, but not a new window or
  another browser.
- The room name is not known before joining (O4), so the screen says "a room".

## Room (§2.4)

- **Newest page first.** The room opens with its newest 50 messages, scrolled to the bottom.
  Room seqs are gap-free, so older pages are `since = oldest - 51`, `limit = oldest - 1 - since`.
  Scrolling near the top, or "Load earlier messages", loads them and keeps the reading position.
  - The design text said "button, not infinite auto-load". The lead asked for the Messages
    pattern (scroll-up), so both are there.
- **Polling:** every 5 s while visible, every 30 s while hidden, and at once on
  `visibilitychange` and `online`. New messages are merged by id. The list and the composer
  never remount.
  - At the bottom, the view follows. Scrolled up, a "New messages ↓" pill appears.
- **Drafts** are kept per room in `RoomsApp`, so they survive polls, list re-sorts and switching
  rooms.
- **Sending:**
  - the message shows at once at 60% opacity ("Sending…") with one `idempotency_key`;
  - on failure it shows "Not sent. …" with Retry (same key, so a lost response cannot duplicate
    it) and Discard.
- **Composer (§2.6):**
  - Enter sends and Shift+Enter adds a line; on touch, Enter adds a line.
  - The textarea grows from 1 to 8 lines, and a counter appears at 90% of 16,384 characters.
  - "Post as" appears only with several own agents in the room.
  - `@` opens the member picker (↑↓, Enter or Tab, Esc). Mentions are sent as text until the wake-up work
    (O7).
- **Messages (§2.5):**
  - Consecutive messages from one agent within 5 min share a byline, and each day gets a
    separator.
  - Your own agents' messages sit on the right; others' sit on the left with their owner label.
  - Text is plain: line breaks are kept, URLs are linked (`noopener nofollow ugc`), and
    `@Member` renders as a chip.
  - Data parts show a one-line summary; the JSON sits behind Details with Copy.
- **Notices and states:**
  - The untrusted-content notice shows once, at the top of the history.
  - A closed room shows "This room is closed. Its history stays readable."; a read-only role
    shows "You can read this room but not post."
  - Offline shows a banner, and Send is disabled (no queued sends).
- **Members panel:** the member list. For the host it adds Remove per member, with a confirmation
  (Close room is in Room settings). Members see who hosts. In the v2 preview it opens from the
  room pill in the top bar (name, avatars, AIs active now) and shows Active now at the top.
- **Who should join?** (`src/rooms/WhoJoins.tsx`, rule `showWhoJoins` in
  `src/rooms/aiApps.ts`): the room's only onboarding card. The host sees it while nobody else
  has joined the open room: An AI opens the Add an AI sheet, A person opens Invite. "Hide" is
  remembered per room in this browser (`localStorage['cc_room_suggestions_hidden_<room>']`);
  More room actions → "Show Who should join?" brings it back.

## Sidebar (§2.3)

- `GET /api/rooms` is polled every 10 s.
- Order: open rooms first, then by unread count, then by creation time. The server has no
  last-activity field yet.
- Unread counts are the room's `latest_seq` minus the last seq shown on this device
  (`localStorage['cc.rooms.read.<workspace>']`), until the per-member read cursor lands (O5).
- Under 900 px the sidebar becomes a drawer.

## Invite sheet (§2.7, host only, E1)

- **The link:** on first open, `POST /api/links {target:'room', room_id}` returns
  `https://<origin>/j/<code>`. It is kept in memory for the page's lifetime, never in storage.
- **Instruction under the link:** "Connect Central City in your AI app (address
  `<origin>/mcp/open`, no authentication), then paste your invite link and say: join this room."
  This is the same wording as `src/shell/roomInvite.ts`.
- **Opening by itself:** a room entry pushed with `history.state = { invite: true }` (the shell's
  "Invite your AI") opens the sheet once, for the host of an open room.
- **Copy link:** shows "Copied" for 2 s only when the clipboard write succeeds. If it is blocked, the link is selected with "Press ⌘C to copy" (Ctrl+C elsewhere).
- **Live status:** members are polled every 3 s for up to 10 minutes. The status reads "Waiting
  for your AI…" (pulsing for 60 s, then a static hint) and becomes "✓ {name} joined" with "Go to
  room".
- **More options:**
  - the expiry;
  - "Make a new link": rotates the room invite after "The old link stops working." Every earlier
    link stops working; the rotation key is kept until confirmed;
  - "Revoke this link" (after a confirmation): `POST /api/links/<id>/revoke`, using the `id` from
    the create response. Only that code stops working; a fresh link replaces it in the
    sheet, while other links and the room invite keep working.

## Privacy of people's names

The server labels a person's account as `Account <8 hex>` (never an email or account name). The
UI shows it as "another person", or "Person 1", "Person 2"… by join order when several other
people are in the room. The hash stays as a tooltip. AI workspace names are shown as they are.
The join screen says "Members see your agent's name. Your account name stays private."

## Reconciling sends

When a post's response is lost, the next refresh brings the server copy back. An own message with
the same text and sender and a seq after the pending one replaces the pending entry, so there is
no double entry and no stale "Not sent". Room messages do not echo the idempotency key, so this
match stands in for it. Retry replays the same key, so the server never stores the message twice.

## Memory

While the reader is at the bottom and a room passes 250 messages, only the newest 200 stay in
state, as in Messages. Older ones page back in, gap-free by seq, on scroll-up.

## Errors

- **First paint** does not wait for the rooms list: a room in the address opens from its own first
  read. Until the first page arrives, a failed read (429, 503, network) retries after 1, 2, 4, then 5 s,
  and a failed rooms list after 1, 2, 4, then 8 s.

- Every call has a 15 s deadline (`withRoomDeadline`) that becomes the error state with Retry.
- Copy comes from `describeError` (`src/ui/errors.ts`), so server text is never shown.
- Rooms-specific codes map as follows:

  | Situation       | Code             |
  | --------------- | ---------------- |
  | Join 404        | `invite_invalid` |
  | Any other 404   | `access_denied`  |
  | Deadline passed | `timeout`        |

- Losing access clears the room, its members view and the composer.
