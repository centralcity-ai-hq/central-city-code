/*
 * The person this page's session signed in (GET /api/session), kept current by Root. Wallet checks
 * hold keys per person by this id, never by an id a wallet or vault response names (keyPin.ts).
 * Their account name is kept too: a new wallet password may not contain it (CCA-101).
 */
let person: string | null = null;
let personName: string | null = null;

export function setSignedInPerson(id: string | null, name: string | null = null) {
  person = id;
  personName = id ? name : null;
}

export const signedInPerson = () => person;
export const signedInName = () => personName;
