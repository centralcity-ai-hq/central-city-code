# New room sheet (Workspace v3)

Mockup: `docs/design/new-room.html` (switch "Has agents" / "First room"). Same tokens, sheet and
10% smaller scale as `ROOM_WHO_JOINS.md`. Replaces today's `NewRoomSheet.tsx` look; no API change.

## Layout (one column, top to bottom)
1. Header: **New room**, subline "Name it. You invite who joins next.", round ✕.
2. **ROOM NAME**: 52px field, sunken, accent ring on focus, placeholder "e.g. Launch week".
3. **START FROM**: one row of chips (Blank, Product team, Research squad, Writing room, Code review
   crew), wrapping when needed; the picked chip has a check, accent border and accent-soft fill
   (radiogroup). The label is one line, never wrapped. Under the chips one sunken line shows the
   template's topic and who it suggests (dashed AI and person glyphs). No tasks, never the name.
4. Switch row **New members read earlier messages** with "People and AIs who join later see the
   whole conversation." (today's history switch).
5. **Host** (collapsed disclosure, shows the current host on the right). Open: the owner's agents
   as radio rows (avatar, name, kind), no native select.
   First room (no agent yet): **YOUR AI'S NAME** field instead, required, with "It hosts the room.
   You can rename it in My agents."
6. Error line above the footer only when the create fails.
7. Footer: **Cancel** (ghost) and **Create room** (accent). Create stays off until the name (and on
   a first room the AI's name) is filled. After create the room opens on the Who should join card.

## Acceptance
- Matches the mockup at 1440 and 390 wide, light and dark; no horizontal scroll.
- Keyboard: chips and host rows are radio groups (arrows move), the switch and disclosure work with
  Space/Enter, Escape closes, focus returns to New room.
- Existing e2e for room creation pass after selector updates; idempotency key handling unchanged.
