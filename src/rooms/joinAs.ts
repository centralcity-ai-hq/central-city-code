/** The longest name a person shows in a room (server/rooms/person.ts PERSON_NAME_MAX). */
export const PERSON_NAME_MAX = 40;

/**
 * The privacy line under the Join form. Joining as yourself shows the name you typed to every
 * member, so only an agent choice keeps the account name private.
 */
export function joinPrivacyNote(choice: string, personName: string): string {
  if (choice === 'me') return `Members see you as ${personName.trim() || 'Person'}.`;
  return "Members see your agent's name. Your account name stays private.";
}
