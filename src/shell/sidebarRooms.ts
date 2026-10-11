import { useSyncExternalStore } from 'react';

/*
 * The workspace sidebar holds the room list under Rooms (docs/design/WORKSPACE_V3.md §3).
 * The list's data and its sheets (New room, Join a room) stay in RoomsApp, which renders the
 * list into the sidebar's slot through a portal while a room page is open. On other pages the
 * sidebar draws the same list from its own read (src/shell/SidebarRoomList.tsx).
 *
 * This module is the meeting point: the sidebar registers its slot element and a close callback
 * (the phone drawer), and RoomsApp claims the slot while it draws into it.
 */

type State = { slot: HTMLElement | null; owners: number };
let state: State = { slot: null, owners: 0 };
let close: () => void = () => {};
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The sidebar's slot element (null while no workspace sidebar is mounted). */
export function setSidebarRoomsSlot(slot: HTMLElement | null) {
  if (slot !== state.slot) set({ slot });
}

/**
 * Opens the phone drawer. On a room page the room's top bar carries the ☰ chip (WORKSPACE_V3.md
 * §3: one top bar on phones), so the shell registers how to open its drawer here.
 */
let open: (() => void) | null = null;
export function setSidebarOpen(fn: (() => void) | null) {
  open = fn;
}
export function openSidebar() {
  open?.();
}

/** Closes the phone drawer after a room row or a room action is used. */
export function setSidebarClose(fn: () => void) {
  close = fn;
}
export function closeSidebar() {
  close();
}

/** RoomsApp draws the list: the sidebar skips its own read. Returns the release. */
export function claimSidebarRooms() {
  set({ owners: state.owners + 1 });
  return () => set({ owners: Math.max(0, state.owners - 1) });
}

export function useSidebarRoomsSlot() {
  return useSyncExternalStore(
    subscribe,
    () => state.slot,
    () => null,
  );
}

export function useSidebarRoomsClaimed() {
  return useSyncExternalStore(
    subscribe,
    () => state.owners > 0,
    () => false,
  );
}

/** History-state key for a sheet to open once the rooms page mounts (New room, Join a room). */
export const ROOMS_SHEET_STATE = 'roomsSheet';
export type RoomsSheet = 'new' | 'join';

/** The sheet a sidebar action asked for on the way to /rooms, read once and then cleared. */
export function takeRoomsSheet(): RoomsSheet | null {
  try {
    const entry = window.history.state as Record<string, unknown> | null;
    const sheet = entry?.[ROOMS_SHEET_STATE];
    if (sheet !== 'new' && sheet !== 'join') return null;
    const rest = { ...entry };
    delete rest[ROOMS_SHEET_STATE];
    window.history.replaceState(rest, '');
    return sheet;
  } catch {
    return null;
  }
}
