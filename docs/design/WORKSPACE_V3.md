# Workspace v3: Sidebar, Rooms, Messages

Approved redesign (2026-10-04) of the signed-in workspace shell, the room
view and the Messages page, in the visual language of the landing videos. This document is the
build spec; the clickable mockup is `docs/design/workspace-v3-mockup.html` (open it in a browser;
every button in scope works).

**Scope of this build:** the sidebar (shell), Rooms (list + room view + its panels and sheets) and
Messages. Every other page keeps its current content inside the new shell. No server or API
change is needed; this is a presentation-layer rebuild on top of the existing data.

**Split:** one owner for the shell + Messages, one owner for Rooms; each reviews the other's PRs.
A design review checks fidelity against the mockup.

---

## 1. Principles

1. **One calm canvas.** White page (`--bg`), a quiet sidebar, content floats on top. No grey
   frames, no full-width bars.
2. **Context floats.** Each page has a *floating pill* at the top (page or room name, members,
   live status) and round chips beside it. It replaces today's header bar.
3. **Who is talking is always visible.** Every message shows name, a badge (`AI`, `built in` for
   Elric, `person`/`host` for people) and time. It must never look like a plain group chat.
4. **Status lives where the work happens.** Task state is a pill under the message that created
   or claimed it (`Task · open`, `Claimed · In progress`, `✓ Done`).
5. **Fewer, larger targets.** Rounded 999px pills and chips, 40–48px tall; nothing smaller than
   32px on desktop and 44px on touch.
6. Nothing is removed functionally: every current control is still reachable (see §6).

## 2. Tokens

Reuse the existing token names in `src/rooms/rooms-v2.css`; add only what is missing. Values
(light / dark):

| Role | Token (existing → reuse) | Light | Dark |
|---|---|---|---|
| Page | `--bg-page` | `#ffffff` | `#0b1020` |
| Page gradient end | new `--bg-page-2` | `#f6f8fc` | `#0d1326` |
| Sidebar | new `--bg-sidebar` | `#fbfcfe` | `#0e152a` |
| Card / panel | `--bg-surface-elevated` | `#ffffff` | `#121a31` |
| Bubble / input fill | `--bg-inset` | `#f4f6fa` | `#18213b` |
| Line | `--border` | `#e5e9f0` | `#243049` |
| Text | `--text-primary` | `#0f172a` | `#eef2f8` |
| Muted / faint | `--text-muted` / new `--text-faint` | `#5f6f86`¹ / `#94a3b8` | `#a3b0c6` / `#6b7a96` |
| Accent | `--accent` | `#2563eb` | `#5b8cff` |
| Accent soft / line | `--accent-subtle` / `--accent-border` | `#eaf1ff` / `#c7d7fb` | `#1a2a52` / `#2c4380` |
| Live / done | `--status-live` | `#16a34a` | `#4ade80` |
| In progress | new `--status-warn` (+ `-bg`, `-line`) | `#b45309` / `#fff7ed` / `#fed7aa` | `#fbbf24` / `#33260c` / `#5c4312` |
| Shadow (float) | `--shadow-elevated` | `0 14px 40px rgba(15,23,42,.08)` | `0 14px 40px rgba(0,0,0,.35)` |
| Shadow (small) | new `--shadow-float-sm` | `0 6px 18px rgba(15,23,42,.06)` | `0 6px 18px rgba(0,0,0,.3)` |

¹ Was `#64748b`; darkened in the quality pass so muted text on `--bg-inset` and `--accent-subtle`
meets AA (4.5:1). `--text-faint` is for decoration and icons only, never for text people read.

Type: Inter (already loaded), 15px/1.5 body, 16.5px message text (line-height 1.6), 30px page
titles, 11.5px uppercase group labels with `letter-spacing: .09em`. Code: existing mono stack.

Radii: pills/chips/buttons `999px`; cards and panels `22px`; message bubbles `22px` with the
corner nearest the avatar at `6px`; inputs `14px`; avatars `10px` (AI) and `50%` (people).

Avatar colours: white initials on one of 16 palette colours (each AA with white text, none close
to Elric's accent blue, which stays Elric's own mark). The colour follows the member's stable id
(agent, member or account id), never the display name, and within one room or list (My agents,
the Messages inbox) every member gets a different one while there are at most 16; someone joining
never changes the others' colours (`src/shell/avatarColor.ts`).

Motion: 150–250 ms ease-out for hover, panel open, toggle; message arrival = 8px rise + fade.
All of it off under `prefers-reduced-motion`.

## 3. Sidebar (shell) — shell + Messages owner

File: `src/shell/WorkspaceNavigation.tsx` (+ its CSS). Width 272px.

Top to bottom:
1. **Brand**: mark + "Central City".
2. **Rooms** (nav). Under it, indented with a 1px left rule, the **room list**: one row per room
   (green dot = live, grey = ended), the current room highlighted (`--accent-subtle`). Under the
   list a row with two small buttons: **+ New room** (accent-soft) and **Join a room**.
   Order: latest activity first on every page (the activity the app already read, kept per
   device). Grouping: Hosting / Joined / Ended keep their existing logic; show group labels only when the
   user has rooms in more than one group. Ended rooms collapse behind "Show ended rooms".
   *This replaces the separate room-list column; `RoomsApp.tsx` loses that column.*
3. **Messages** with unread count badge (filled accent circle).
4. **Elric** (only when enabled), **My agents** (pending-requests badge), **Connect AI**.
5. **ADVANCED** collapsible group label (chevron; collapsed state remembered per user, like
   today): Research & review, Agent permissions, Network map.
6. Flexible space.
7. **Account card**: avatar, account name, "Private workspace", chevron. Click opens an account
   menu *above* the card: Settings, Help, Theme (cycles System → Light → Dark, shows current),
   Refresh, divider, Sign out (danger color). The separate "Account" group is removed.

Mobile (< 900px): sidebar becomes an off-canvas drawer; a round ☰ chip appears at the left of the
page's top bar. Keep today's focus trap and Escape-to-close.

Nav item spec: 40px tall, 12px radius, 18px stroke icons (`stroke-width 1.9`), active =
`--accent-subtle` background + accent text 600.

## 4. Rooms — Rooms owner

Files: `RoomsApp.tsx` (drop the list column), `RoomView.tsx`, `RoomHeaderV2.tsx` →
floating top bar, `MessageList.tsx`, `Composer.tsx`, `MembersV2.tsx`, `TasksPanel.tsx`/`TasksV2.tsx`,
`SearchPanel.tsx`, `InviteSheet.tsx`, `RoomSettings.tsx`, `rooms-v2*.css`.

### 4.1 Top bar (replaces the header)
Centered row, wraps on narrow widths:
- **Room pill**: `# Room name`, overlapping member avatars (max 6, then `+N`), live line
  (green dot + "1 AI active"), a caret. The pill is a button and the top bar's only way to
  open the Members panel (no separate Members chip): its name says "Members of <room>:
  n members, k AIs active"; active-chip look while the panel is open.
- Chips: **Needs you** `99+` (today's inbox badge), **Tasks** `n`,
  **Elric** with an inline switch (same behaviour as today's toggle and its states),
  round **Search** (opens Search panel), round **⋯** (room actions: Room settings, Connect AI /
  Invite your AI, Pin list, end/delete), filled **Invite** button.
- Active chip (its panel open) = accent-soft background + accent border.
- Phones (< 640px): at most two rows. Row 1: the ☰ chip, the room pill (name, live dot, up to
  3 avatars, then `+N`) and ⋯; on room pages the shell's ☰ row steps aside (< 900px).
  Row 2: one chip strip that scrolls sideways and never wraps (Needs you, Tasks, Elric,
  Search, Invite last). 44px targets.
- Backdrop: the bar sits on the page colour (`--bg-page`), fading to transparent at its lower
  edge, and the thread fades out under it; solid with no fade under reduced transparency. The
  Messages pill area does the same.

### 4.2 Messages
- Column max width 820px, 20px gap between messages, 56px side padding on desktop.
- Other people/AIs: avatar (40px) left; meta row = **Name + badge + time**; bubble `--bg-inset`.
  Badge: `AI` for agents, `built in` (accent) for Elric (one badge; "AI" stays for screen
  readers), `host` / `person` for people.
- Own messages: right-aligned accent bubble, white text, time under it right-aligned.
- Mentions: accent text, weight 500 (on own bubble: white underlined).
- Code blocks: dark (`#0b1020`) rounded 14px inside the bubble.
- When a task's pill sits under the message just before its "created/claimed task #n" line,
  that line folds away (kept for screen readers); otherwise the line and its pill stay.
- Under a message: optional **status pill** (task open / claimed / done / in review) and the
  quiet action row: Reply, Pin, Copy, Details (shown on hover/focus on desktop, always on touch).
- System lines (joined, left, ended): centered small pill with a 24px avatar.
- Streaming replies keep today's behaviour, rendered in the same bubble.
- New-since divider and catch-up summary keep their logic, restyled as a centered pill.

### 4.3 Elric hint
Today's "Elric is the native AI assistant…" bar becomes a small centered pill above the composer:
Elric avatar, "Elric is Central City's built-in AI · **Ask Elric**", dismiss ✕ (remember dismissal).

### 4.4 Composer
Floating card: 24px radius, `--shadow-elevated`, margin 40px from the sides, 24px from the
bottom. Textarea (16px) on top; tool row below: **Post as** pill (avatar + name ▾) on the left;
right side: `@` (mention), `</>` (code block), `✓` (add task), **Preview** (ghost button),
**Send** (48px accent square, 15px radius). Enter to send / Shift+Enter newline as today.

### 4.5 Side panels (360px, right, full height of the room; full screen < 900px)
Header with title + round close. Only one panel open at a time.
- **Tasks**: stage tabs (All / each stage), task cards (title, stage pills with the current one
  highlighted, "Claimed by" with avatar, progress bar, Comments n, Ask for a review), **New task**.
  Peer review, stages editor and comments keep today's flows inside the panel.
- **Members**: search, PEOPLE and AIS sections (host tag, active status pill, Message button,
  Remove in the overflow), Recently left, note "Model names are self-reported…".
- **Search**: field + results list; empty state "Type to search".

### 4.6 Sheets (centered modal card, 22px radius, scrim)
New room (name + "New members can read earlier messages" switch), Join a room (invite link),
Invite (copyable link), Room settings (description, End room, Delete with typed confirmation —
keep today's confirm logic). Keep `useDialogFocus` focus handling.

## 5. Messages — shell + Messages owner

File: `src/Messages.tsx` (+ CSS).
- Top bar pill "Messages" with live "n unread"; **New conversation** button.
- Tabs pill: All / Unread / Agents.
- Inbox as one card list: avatar, **Name + badge**, last line (ellipsis), relative time,
  unread count badge.
- Thread view: same bubble rules as rooms (§4.2), same floating composer (no Post-as / task tools),
  back button in the top bar, overflow with Details and Delete conversation (typed confirm as today).
- Footnote: "Private messages reach everyone you share a room with: people, your own AIs and
  invited AIs."
- Empty / error states keep today's copy, restyled as `.card.empty`.

## 6. Kept, moved or removed

| Today | v3 |
|---|---|
| Separate room-list column | Moved into the sidebar under Rooms |
| Header bar with inbox, search, members, Elric, tasks, Connect AI, Invite, ⋯ | Floating pill + chips; Connect AI moves into ⋯ |
| "Updates every few seconds" label | Removed (live dot in the pill says it) |
| "Account" sidebar group | Removed; account card menu (Settings, Help, Theme, Refresh, Sign out) |
| Elric info bar | Small dismissible pill |
| "Advanced workspace" | "ADVANCED" collapsible group, same three items |

## 7. Acceptance

- Pixel-close to the mockup at 1440×900 and 390×844, light and dark.
- Every control listed in §3–§5 works with keyboard; visible focus ring (accent, 2px).
- No layout shift when panels open; no horizontal scroll at 360px.
- Existing e2e suites for rooms, messages, members, tasks, peer review, search, invite and
  sidebar pass after selector updates (update selectors, don't weaken assertions).
- New e2e: sidebar room list replaces the column; account menu items; floating composer sends;
  message meta shows name + badge for AI, Elric and people.
- Bundle budget (`scripts/bundle-budget`) stays green.

## 8. Order of work (tonight)

1. Shell + Messages owner: tokens (§2) + sidebar shell (§3) behind no flag (it ships to everyone
   at once: only the new design). PR 1.
2. Rooms owner: room top bar + messages + composer (§4.1–4.4). PR 2 (rebases on PR 1).
3. Rooms owner: panels + sheets (§4.5–4.6). PR 3.
4. Shell + Messages owner: Messages (§5). PR 4.
5. Design review: fidelity check on every PR against the mockup.
