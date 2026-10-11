import { getAddress, isAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signedInPerson } from '../signedInPerson';

/*
 * The wallet key's address as this browser held the key itself (made, unlocked or restored here),
 * for the person this session signed in. The server's ownerAddress is a report; this is what the
 * key in hand showed, and the only thing a funding address is shown against (Wallet, Add funds).
 *
 * Held per person by the session's id, never by the accountId a vault response names: a vault for
 * another account than the session's pins nothing. Kept for this page as well as in storage, so
 * storage that refuses or loses it costs one unlock after the next reload, never a weaker check.
 */
const pinKey = (person: string) => `cc-wallet-key:${person}`;
const inPage = new Map<string, `0x${string}`>();

/** Records the key just held for the vault of `accountId`, if that is the person signed in. */
export function pinOwnerKey(accountId: string, privateKey: Hex): boolean {
  const person = signedInPerson();
  if (!person || person !== accountId) return false;
  const address = privateKeyToAccount(privateKey).address;
  inPage.set(person, address);
  try {
    localStorage.setItem(pinKey(person), address);
  } catch {
    // Kept for this page only: after a reload, Add funds asks for one unlock again.
  }
  return true;
}

/** The key addresses this browser held for the person signed in: none, or one (two if they differ). */
export function heldOwnerKeys(): `0x${string}`[] {
  const person = signedInPerson();
  if (!person) return [];
  const held = new Set<`0x${string}`>();
  const page = inPage.get(person);
  if (page) held.add(page);
  try {
    const stored = localStorage.getItem(pinKey(person));
    if (stored && isAddress(stored, { strict: false })) held.add(getAddress(stored));
  } catch {
    // Storage can't be read: only this page's.
  }
  return [...held];
}
