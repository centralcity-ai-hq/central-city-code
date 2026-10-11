import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, LoaderCircle } from 'lucide-react';
import { RoomsApp, createHttpRoomsClient, type RoomsClient } from './rooms';
import { withRoomDeadline } from './rooms/api';
import { navigate } from './shell/navigation';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { readPendingJoin, roomSlugOf } from './rooms/pendingJoin';
import { LINKS } from './shell/links';

/*
 * The app shell's mount of the Rooms experience (docs/ROOMS_UX.md, "Mounting it"): /rooms,
 * /rooms/:id and /r/:slug. Loaded as its own chunk, so "/" carries none of the rooms code.
 *
 * Signed-in "Invite your AI" arrives as /rooms#invite: the person's newest
 * open room they host opens with its Invite sheet. With none, the person creates "My first room"
 * with one click (never on page load: any site can link here), unless the app itself just
 * signed them in for this purpose (CREATE_FIRST_ROOM_STATE).
 */

const FIRST_ROOM = 'My first room';

/** The newest open room the person hosts, or null. */
export async function findInviteRoom(client: RoomsClient) {
  const rooms = await withRoomDeadline(client.listRooms());
  return (
    rooms
      .filter((room) => room.role === 'host' && !room.closed)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

/** Creates "My first room", hosted by the person's first agent or a new "{name}'s agent". */
export async function createFirstRoom(client: RoomsClient, accountName: string, key: string) {
  const agents = await withRoomDeadline(client.listAgents());
  const host =
    agents[0] ??
    (await withRoomDeadline(client.createAgent({ name: `${accountName || 'My'}'s agent` })));
  return withRoomDeadline(
    client.create({ agent_id: host.id, name: FIRST_ROOM, idempotency_key: key }),
  );
}

/**
 * History-state flag set only by the app itself (Root, right after the person signed in from
 * "Sign in to get your link"). A cross-site link cannot set history.state, so a link to
 * /invite or /rooms#invite never creates anything by itself.
 */
export const CREATE_FIRST_ROOM_STATE = 'createFirstRoom';

/** Signed-out /rooms and /rooms/:id: the public shell, one line of context and Sign in. */
function SignedOutRooms() {
  const next = window.location.pathname;
  return (
    <div className="public-shell">
      <PublicHeader current="rooms" />
      <main id="main-content" tabIndex={-1} className="public-main rm-signed-out">
        <h1>Your rooms</h1>
        <p>Rooms are shared spaces where people and their AIs work together.</p>
        <p>Sign in to create a room and invite your AI.</p>
        <button
          type="button"
          className="button primary large"
          onClick={() => navigate(`/signin?next=${encodeURIComponent(next)}`)}
        >
          Sign in
        </button>
      </main>
      <PublicFooter />
    </div>
  );
}

/** The no-invite message on /r/:slug, signed in or out. */
const INCOMPLETE_INVITE = 'This invite link is incomplete; ask the host for a new link.';

/**
 * Signed-out /r/:slug without its invite secret (opened directly, or the secret was lost in a
 * new tab). Decided in the browser from sessionStorage alone, with no request, so the page is
 * the same for every slug and never tells whether a room exists.
 */
function IncompleteInvite({ slug }: { slug: string }) {
  return (
    <div className="public-shell">
      <PublicHeader current="rooms" />
      <main id="main-content" tabIndex={-1} className="public-main rm-signed-out">
        <h1>Open your invite link</h1>
        <p>{INCOMPLETE_INVITE}</p>
        <div className="rm-signed-out-actions">
          <button
            type="button"
            className="button primary large"
            onClick={() => navigate(`/signin?next=${encodeURIComponent(`/r/${slug}`)}`)}
          >
            Sign in
          </button>
          <a className="button secondary large" href={LINKS.home}>
            Go home
          </a>
        </div>
        <p className="rm-signed-out-note">Already in this room? Sign in to open it.</p>
      </main>
      <PublicFooter />
    </div>
  );
}

export default function RoomsShell({
  signedIn,
  embedded = false,
  workspaceId,
  accountName,
}: {
  embedded?: boolean;
  signedIn: boolean;
  workspaceId: string;
  accountName: string;
}) {
  const client = useMemo(() => createHttpRoomsClient(), []);
  const [inviting, setInviting] = useState(
    () => signedIn && window.location.pathname === '/rooms' && window.location.hash === '#invite',
  );
  const [inviteError, setInviteError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // One key for every retry, so a lost response cannot create a second first room.
  const key = useRef(crypto.randomUUID());

  // True when the person hosts no room yet: wait for their click before creating one.
  const [needsFirstRoom, setNeedsFirstRoom] = useState(false);
  const [creating, setCreating] = useState(false);

  function openWithInvite(room: { id: string }) {
    // The entry carries { invite: true }: RoomView opens its Invite sheet at once.
    window.history.replaceState({ invite: true }, '', `/rooms/${room.id}`);
    setInviting(false);
  }

  useEffect(() => {
    if (!inviting) return;
    let active = true;
    const fromApp =
      (window.history.state as Record<string, unknown> | null)?.[CREATE_FIRST_ROOM_STATE] === true;
    findInviteRoom(client)
      .then(async (room) => {
        if (!active) return;
        if (room) return openWithInvite(room);
        if (!fromApp && !creating) return setNeedsFirstRoom(true);
        const created = await createFirstRoom(client, accountName, key.current);
        if (active) openWithInvite(created);
      })
      .catch(() => {
        if (active) setInviteError("Your room couldn't be prepared.");
      });
    return () => {
      active = false;
    };
  }, [inviting, attempt, creating, client, accountName]);

  if (inviting && needsFirstRoom && !creating)
    return (
      <div className="rm-app rm-app-join">
        <main className="rm-join">
          <h1>Your first room</h1>
          <p>Create a room, then copy its link and paste it into your AI.</p>
          <button
            type="button"
            className="rm-primary"
            onClick={() => {
              setNeedsFirstRoom(false);
              setCreating(true);
            }}
          >
            Create my first room
          </button>
        </main>
      </div>
    );

  if (inviting)
    return (
      <div className="rm-app rm-app-join">
        <main className="rm-join">
          {inviteError ? (
            <>
              <p role="alert">{inviteError}</p>
              <button
                type="button"
                className="rm-primary"
                onClick={() => {
                  setInviteError('');
                  setAttempt((value) => value + 1);
                }}
              >
                Try again
              </button>
            </>
          ) : (
            <p role="status">
              <LoaderCircle className="spin" size={16} aria-hidden="true" /> Opening your room
            </p>
          )}
        </main>
      </div>
    );

  // The join page (/r/:slug) with its invite keeps RoomsApp's own signed-out flow ("Sign in to join").
  const slug = roomSlugOf(window.location.pathname);
  if (!signedIn && !slug) return <SignedOutRooms />;
  if (!signedIn && slug && !readPendingJoin(slug)) return <IncompleteInvite slug={slug} />;

  return (
    <RoomsApp
      embedded={embedded}
      shellMenu={embedded}
      key={workspaceId}
      client={client}
      signedIn={signedIn}
      workspaceId={workspaceId}
      accountName={accountName}
      onSignIn={(next) => navigate(`/signin?next=${encodeURIComponent(next)}`)}
      nav={
        signedIn && !embedded ? (
          <a
            className="rm-quiet rm-nav-link"
            href="/"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
              event.preventDefault();
              navigate('/');
            }}
          >
            <LayoutGrid size={16} aria-hidden="true" />
            Workspace
          </a>
        ) : null
      }
    />
  );
}
