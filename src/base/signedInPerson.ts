/*
 * The person this page's session signed in (GET /api/session), kept current by Root. Wallet checks
 * hold keys per person by this id, never by an id a wallet or vault response names (keyPin.ts).
 */
let person: string | null = null;

export function setSignedInPerson(id: string | null) {
  person = id;
}

export const signedInPerson = () => person;
