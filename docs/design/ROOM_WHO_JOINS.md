# New room: "Who should join?"

Approved 2026-10-05. Replaces the "Suggested for this room" card and its flows in
a new room. Clickable mockup: `docs/design/room-who-joins.html`. Same Workspace v3 tokens and
components (`WORKSPACE_V3.md`).

## 1. New rooms start empty
- **No default tasks.** Today a new room gets three template tasks (#1 Write the product brief,
  #2 Test plan, #3 Launch). Remove them: a new room has no tasks and no "Today" feed until
  someone posts.
- Drop the template wording everywhere ("From the Product team template." is removed).

## 2. The card
- Title **Who should join?**, subline "Nobody joins until you invite them.", round ✕ to hide
  (hidden state remembered per room; bring it back from the room's ⋯ menu).
- Two equal tiles side by side (one column under 520px):
  - **An AI** — "Builds, reviews or helps" — dashed robot glyph, blue `+`.
  - **A person** — "Decides and approves" — dashed person glyph (round), blue `+`.
- Whole tile is the button; hover = accent-soft background + accent border.
- Card, tiles and sheets are rendered **10% smaller** than the base v3 scale (mockup uses
  `zoom: .9`; implement with the matching sizes, not zoom).

## 3. "An AI" sheet (one flow for every AI)
- Header: glyph, **Add an AI**, "Pick your AI app. It joins this room only.", ✕.
- Label WHICH AI? and a grid of app tiles (3 columns, 2 on phone): Claude, ChatGPT, Gemini
  CLI, Claude Code, Codex, Cursor, Other. Selected tile = accent border + accent-soft.
- Instructions block (sunken, 18px radius) with **a fixed height so the sheet never changes
  size between apps**:
  1. one line ("Open X with Central City ready:" / "Add this address to X:" /
     "Run this in your terminal:");
  2. **one action row of identical size for every app**: a white row with the text on the
     left and a small accent button on the right — `Open` for apps with a deep link (Claude,
     Cursor), `Copy` for an address or command (ChatGPT, Gemini CLI, Claude Code, Codex,
     Other). No large blue full-width button;
  3. one short line per app (e.g. "In Claude, choose Add and sign in.",
     "Run /mcp and choose Authenticate.", "Run: codex mcp login central-city");
  4. "Then paste the room invite into X." and a full-width ghost **Copy room invite for your
     AI** pinned to the bottom of the block.
- Under the block: pulsing dot + "Waiting for your AI to join…"; when it joins, close the sheet
  and show the usual joined system line.
- No role choice (builds/reviews/helps was dropped: any AI can join).
- Commands and addresses are today's real ones (Connect AI sheet); keep them in one source.

## 4. "A person" sheet
- Header: round person glyph, **Invite a person**, "Share the link or the code.", ✕.
- **Copy invite link**: full-width accent button, correctly aligned inside the sheet (fixes
  today's off-center button in a grey container).
- The room code (e.g. `2FWH-JE1Z`) centered, mono 600 **19px**, with a small round copy button;
  caption "or join with this code at centralcity.ai".
- Collapsed **Room access** (disclosure, chevron) containing only:
  - four switches with short labels: Can read earlier messages · People join as themselves ·
    Members can bring their AI · Private messages;
  - Member limit with a −/+ stepper (no free number field, no separate Save; save on change);
  - one quiet footer line: "Link valid until 6 Oct, 10:10 · New link · Revoke" (Revoke in danger
    color, typed confirm as today).
- Removed: the long explanations, "Still waiting. Paste the link…", the app list text, the
  "Something in this form isn't right" error placement next to Save.

## 5. Acceptance
- Matches the mockup (light/dark, 1440 and 390 wide).
- Switching apps in the AI sheet never changes the sheet height (e2e: measure the dialog).
- New room has zero tasks (e2e + unit on room creation).
- Keyboard: tiles, app grid, switches, stepper and disclosure reachable; Escape closes.
