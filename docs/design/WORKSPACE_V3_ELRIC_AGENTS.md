# Workspace v3: Elric and My agents

Second part of the Workspace v3 redesign (2026-10-05). Same language, tokens and
components as `WORKSPACE_V3.md` (sidebar, rooms, messages); read that first. Clickable mockup:
`docs/design/workspace-v3-elric-agents.html` (opens on Elric; switch with the sidebar).

Scope: `/elric` and My agents. Presentation only; no API change. Every current control stays
reachable (see the tables).

## 1. Elric (`src/elric/ElricDashboard.tsx`, `ElricActivity.tsx`, `ElricApprovalCard.tsx`, `src/rooms/elric/*`)

### Layout (top bar 10% smaller than the room top bar)
- **Top bar** (floating, as in rooms): pill with Elric's avatar (the Central City mark on blue),
  "Elric", `built in` badge and a live line "On in N rooms". Beside it: a `Chat / First visit`
  tab pill only in the mockup (to show both states), **Manage Elric** chip, **New chat** button.
- **Chats column** (250px, inside the page, left): label CHATS, one row per chat (current one
  accent-soft), footnote that chats are private. Rename and delete move into a ⋯ menu inside the
  chat (today's "Chat name / Save name" and "Delete this chat?" flows, restyled as sheets).
  Hidden under 900px (a "Chats" chip opens it as a sheet).

### Home (no chat open) — minimal (less text)
Only four things, vertically centered in the page:
1. The **Elric orb**: 52px, 16px radius (small; the logo must not dominate), accent fill with the white mark, a slow 4 s "breathing"
   halo (off under reduced motion).
2. **What can I help with?** (34px, 600).
3. If approvals are pending: one small accent-blue pill (no orange anywhere on the Elric page) "N action(s) waiting for you · **Review**"
   (opens the chat with the approval cards). Nothing when there are none.
4. Above the composer: three suggestion pills (36px, muted); then the floating composer
   ("Ask Elric…", context pill "Here ▾" for answer-here / ask-in-a-room).
No "What Elric can do" cards, no approval card, no sub-headline on Home.

### Chat
- Same bubbles as rooms. Elric's replies carry **action cards** inside the bubble:
  - done action: `✓ Done` pill + what it did + duration;
  - pending action: `Waiting for your approval` pill + the action + **Approve / Edit first /
    Decline**. Approve is the only filled button.
- Streaming keeps today's behaviour.

### First visit (gates)
Centered card instead of today's separate screens: Elric avatar, **Meet Elric**, one sentence,
then two steps with their buttons: **Link Google** and **Confirm age** (date of birth sheet).
Done steps show a green check. "Resume it in Manage Elric" stays for paused Elric.

### Manage Elric (sheet, from the top bar and My agents)
Switches: Elric in new rooms by default; daily catch-up; act without asking (read-only);
act without asking (posting, off by default). Footer: Google linked / age confirmed status and
**Pause Elric**. Map these to the existing Elric settings; don't add settings that don't exist —
mark any switch without a backing setting as "later" and leave it out of the build.

| Today | v3 |
|---|---|
| Chats list + New chat | Chats column + New chat button in top bar |
| Rename / delete chat | ⋯ menu in the chat, sheets |
| "What can I help with?" + suggestions + example | Home, suggestions grid |
| Approval cards | Approval card on Home + inline action cards in chat |
| Ask in a room | Context pill in the composer |
| Elric settings / Manage Elric | Manage Elric sheet |
| Link Google / age gates | First-visit card with two steps |

### Build status (Elric)
Built in `src/elric/` (`elric-v3.css`, `elric-tokens.css`, `ElricFirstVisit.tsx`,
`ManageElricSheet.tsx`). Not built yet: **Edit first** (no API changes a proposed action before
approval), the done action's duration, done cards for approvals made before the visit, the four
Manage Elric switches without a setting (the sheet has the existing `host_may_invoke` switch,
today's allowance and Pause / Resume), and the chats list as a centered sheet on phones (it stays a
side drawer). Home's three suggestions are questions Elric answers from its help index.

## 2. My agents (`src/agents/MyAgentsV2.tsx`, `AgentInspectionTabs.tsx`, `WorkspaceKeys.tsx`)

### Layout — a roster, not cards (no big empty white boxes)
- **Top bar**: pill "My agents" + live "N online"; round search; **Requests** chip with count;
  **Add an agent** button.
- No summary numbers above the roster (they float unanchored). The agent count
  sits inside the page pill ("My agents 4 · 3 online").
- **Filter tabs**: All / Active / Paused / Removed.
- **Roster**: one rounded container (22px), slim rows (≈60px), columns AGENT · STATUS · ROOMS ·
  LAST ACTIVE · actions. Agent = avatar + name + `AI` badge + "model · self-reported".
  Status = dot + word (green halo when active). Rooms = small grey chips, max two + `+N`.
  Actions (Pause/Resume, Open) appear on row hover/focus (always visible on touch).
  Row click opens the detail panel; the open row stays highlighted.
- **Elric pinned as the first row** with a soft accent gradient, `built in`, status "On";
  click opens Manage Elric. No "Hosted by Central City".
- **Requests**: a single small accent pill under the roster
  "N connection requests from other owners · **Review**" (opens the requests sheet).
- Phone: rows collapse to agent + actions; header row hidden.

### Agent detail panel (right, 360px, same panel component as rooms)
Header: avatar, name, badge, close. Tabs:
- **Overview**: three stat tiles (Rooms, Messages, Tasks done) and a key/value list (Model
  self-reported, Owner, Joined, Status).
- **Rooms**: the rooms it is in, each with Leave.
- **Permissions**: the same switches as Agent permissions, scoped to this agent.
- **Activity**: recent events with relative times.
- **Key**: masked key with Copy, **Rotate key** (new key, the old one stops working at once).
Footer: **Pause** (ghost) and **Remove** (danger) → confirm sheet where the user types the
agent's name. Remove = leaves every room, key stops working, messages stay.

| Today | v3 |
|---|---|
| Search, status filter | Search in top bar, filter tabs |
| Agent cards, AI agent badge | Agent cards with `AI` badge + status pill |
| Elric card "Built into Central City", Manage Elric | Elric card (no hosted line), Manage Elric sheet |
| Inspection tabs, Copy key, Remove | Detail panel tabs, Key tab, Remove with typed confirm |
| Connection requests (pending count) | Requests chip + card |
| Revoked status | Removed tab / status |

### Build status (My agents)
Built in `src/agents/` (`MyAgentsV2.tsx`, `my-agents-v3.css`, `useAgentRooms.ts`; the v3
detail panel has since been replaced by the v4 agent pane in `src/agents/v4/`). Rooms come from
`GET /api/rooms` and each open room's members; Elric's row opens the Elric page's
`ManageElricSheet`; the row's Open action and the panel's **All settings** open the existing
agent dialog (runs, auto-reply and the rest). Not built yet, for lack of an API:
**Pause / Resume** for one agent (only the workspace pause and Elric's own pause exist for the
console), the "model · self-reported" line (no model is stored), the **Messages** total and **Tasks
done** tiles (the overview shows Rooms and Messages today), the masked key and its Copy (only a
hash is stored; Rotate shows the new token once). Permissions shows the agent's connections (the
Agent permissions view has no per-agent switches).

## 3. Acceptance
- Matches the mockup at 1440×900 and 390×844, light and dark.
- Keyboard: every card, tab, switch and sheet reachable; focus returns to the trigger on close.
- Existing e2e for Elric (dashboard, approvals, gates, signed-out) and My agents (inspection,
  Elric card, requests) pass after selector updates; add e2e for the detail panel tabs and the
  typed remove confirm.
- No new API; bundle budget green.

## 4. Suggested split
- My agents owner: My agents (cards, detail panel, requests).
- Elric owner: Elric (home, chat action cards, gates, Manage Elric sheet).
- Design QA: design-fidelity review on both.
