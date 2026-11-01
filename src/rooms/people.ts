import type { Member, OwnerKind } from './api';

/** The server's privacy label for a person's account (never an email or account name). */
const PERSON_LABEL = /^Account [0-9a-f]{8}$/;

/**
 * Whether an owner is a person's account: the server's owner kind decides; only an older server
 * that sends none is read by the label.
 */
export const isPersonOwner = (label: string, kind?: OwnerKind | null): boolean =>
  kind ? kind === 'person' : PERSON_LABEL.test(label);

/**
 * Friendly owner names for other people: "another person" when one other person is here, else
 * "Person 1", "Person 2"… by join order. AI workspace labels are names and stay as they are. The
 * original label (the privacy hash) is kept for a tooltip.
 */
export function ownerNames(members: Member[]): (label: string, kind?: OwnerKind | null) => string {
  const people: string[] = [];
  for (const member of [...members].sort((a, b) => a.joined_at.localeCompare(b.joined_at)))
    if (
      !member.own &&
      isPersonOwner(member.owner_label, member.owner_kind) &&
      !people.includes(member.owner_label)
    )
      people.push(member.owner_label);
  return (label, kind) => {
    if (!isPersonOwner(label, kind)) return label;
    const index = people.indexOf(label);
    return people.length > 1 && index >= 0 ? `Person ${index + 1}` : 'another person';
  };
}

/**
 * Another owner's label as shown next to its agent: never one that reads as the viewer's own
 * ("Your AI" is only ever said for the viewer's own agents).
 */
export const otherOwner = (label: string | null | undefined): string | null =>
  label && !/^\W*(your|you|yours)\b/i.test(label) ? label : null;

/** "another person's", "Person 2's" or "{workspace}'s" for the members list. */
export const possessive = (name: string) => `${name}'s`;

/** A name with case, spacing and punctuation folded, for telling two names apart. */
const nameKey = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The owner of another account's agent, by name, when the viewer can see one: the owner's own
 * person member in the room ("Ana"), or an AI workspace's label. Null for a private account (the
 * privacy hash): that agent is then just "AI agent", never "another person". The owner kind
 * decides which it is (never the label text): an AI workspace is never shown as a person's,
 * even with a label equal to that person's. Null too when an AI workspace's label reads like the
 * name of a person in the room: neither owner can then pass for the other.
 */
export function agentOwners(
  members: readonly Member[],
): (label: string, kind?: OwnerKind | null) => string | null {
  const people = new Map<string, string>();
  for (const member of members)
    if (member.kind === 'person' && !people.has(member.owner_label))
      people.set(member.owner_label, member.name);
  // An empty key (a missing name or label) matches nothing: it is never a lookalike.
  const personNames = new Set(
    [...people.values()].map((name) => nameKey(name ?? '')).filter((key) => key !== ''),
  );
  const workspaceNames = new Set(
    members
      .filter(
        (member) =>
          member.kind !== 'person' && !isPersonOwner(member.owner_label, member.owner_kind),
      )
      .map((member) => nameKey(member.owner_label ?? ''))
      .filter((key) => key !== ''),
  );
  return (label, kind) => {
    if (isPersonOwner(label, kind)) {
      const person = people.get(label);
      return person === undefined || workspaceNames.has(nameKey(person)) ? null : person;
    }
    // An AI workspace's label: shown as it is, unless it reads as a person's label or name.
    if (PERSON_LABEL.test(label)) return null;
    return personNames.has(nameKey(label)) ? null : label;
  };
}

/** An agent's label as plain text: "AI · Ana's agent", or "AI agent" without an owner name. */
export const agentLabel = (owner: string | null) =>
  owner ? `AI · ${possessive(owner)} agent` : 'AI agent';

/**
 * The room-host agent that belongs to the viewer (`own`), or undefined. Writing as one of your
 * agents never mentions it: the @ picker leaves it out and "@<own host>" is not highlighted (the
 * server records no mention either). Writing as yourself (your person member) does: your own
 * @mention wakes your own agent (Operation Agency, A3). Everyone else mentions it normally.
 */
export function ownHost(members: readonly Member[]): Member | undefined {
  return members.find(
    (member) => member.role === 'host' && member.own && (member.kind ?? 'agent') === 'agent',
  );
}

/**
 * The names a message highlights as @mentions: all members, minus the host when one of the host
 * owner's agents wrote it (its own messages, or another owner's whose label matches the host's).
 * A person's message mentions the host even when that person owns it (A3: it wakes it).
 */
export function mentionNamesFor(
  members: readonly Member[],
  message: {
    own?: boolean;
    sender_owner_label?: string;
    sender_agent_id?: string;
    sender_kind?: 'agent' | 'person' | 'system';
  },
): string[] {
  const host = members.find(
    (member) => member.role === 'host' && (member.kind ?? 'agent') === 'agent',
  );
  const names = members.map((member) => member.name);
  if (!host || message.sender_agent_id === host.id || message.sender_kind === 'person')
    return names;
  const sameOwner = message.own
    ? host.own
    : !host.own &&
      message.sender_owner_label !== undefined &&
      message.sender_owner_label === host.owner_label;
  return sameOwner ? names.filter((name) => name !== host.name) : names;
}
