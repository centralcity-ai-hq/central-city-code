import { useCallback, useEffect, useRef, useState } from 'react';
import { getAddress } from 'viem';
import { ApiError } from '../api';
import type { OwnerMode } from './baseRegistrationController';
import { signedInPerson } from './signedInPerson';
import { readVault, unlockVault, VaultCryptoError } from './vault';
import { heldOwnerKeys } from './vault/keyPin';
import { expectedWallet } from './wallet/derive';

/*
 * Registering an agent on Base with the person's own wallet key (decision A, one wallet): the Base
 * ID goes into the wallet that key makes for the agent, which is also its money wallet. While the
 * wallet routes are off (the vault answers 404) the address field stays exactly as before.
 *
 * The owner is never typed and never taken from an answer: the server takes it from the person's
 * vault, and this browser sends only the wallet it derived itself from the key it held (made,
 * unlocked or restored here; keyPin.ts). Without a held key, the screen unlocks it first.
 */

export type RegisterKey =
  | { k: 'loading' }
  /** Wallets are off: the typed owner address, as before. */
  | { k: 'address' }
  | { k: 'nokey' }
  | { k: 'backup' }
  | { k: 'unlock' }
  | { k: 'ready'; owner: `0x${string}`; expectedWallet: `0x${string}` }
  /** Something here doesn't fit the person's own key: nothing is registered. */
  | { k: 'refused'; message: string }
  | { k: 'error'; message: string };

export const NOT_THIS_ACCOUNT =
  'This wallet key isn’t your account’s, so nothing is registered here. Reload the page and try again.';
export const OTHER_KEY_HELD =
  'This browser held another wallet key for your account, so nothing is registered here.';

const message = (error: unknown) =>
  error instanceof VaultCryptoError || error instanceof ApiError || error instanceof Error
    ? error.message
    : 'Something went wrong. Try again.';

async function readKey(agentId: string): Promise<RegisterKey> {
  let vault;
  try {
    vault = await readVault();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { k: 'address' };
    return { k: 'error', message: message(error) };
  }
  if (!vault.exists || !vault.ownerAddress) return { k: 'nokey' };
  if (vault.backupConfirmedAt === null) return { k: 'backup' };
  // The key is held per signed-in person, never per an id the vault names (keyPin.ts).
  if (vault.accountId !== signedInPerson()) return { k: 'refused', message: NOT_THIS_ACCOUNT };
  const owner = getAddress(vault.ownerAddress);
  const held = heldOwnerKeys();
  if (held.some((key) => key !== owner)) return { k: 'refused', message: OTHER_KEY_HELD };
  if (!held.length) return { k: 'unlock' };
  return { k: 'ready', owner, expectedWallet: expectedWallet(owner, agentId) };
}

/** Where the person's wallet key stands for registering `agentId`, and its unlock. */
export function useRegisterWithKey(agentId: string, idle = false) {
  const [state, setState] = useState<RegisterKey>({ k: 'loading' });
  const run = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++run.current;
    const next = await readKey(agentId);
    if (run.current === mine) setState(next);
    return next;
  }, [agentId]);
  useEffect(() => {
    if (idle) return;
    void reload();
    return () => {
      run.current += 1;
    };
  }, [reload, idle]);
  /** Opens the key with the password (it is dropped at once); the key is held here from then on. */
  const unlock = useCallback(
    async (password: string) => {
      await unlockVault(password);
      return reload();
    },
    [reload],
  );
  return { state, reload, unlock };
}

/** Hands the key's state to a registration controller as its owner mode, once it is known. */
export function useOwnerModeFromKey(setMode: (mode: OwnerMode) => void, state: RegisterKey) {
  useEffect(() => {
    if (state.k === 'loading') return;
    if (state.k === 'address') setMode({ kind: 'address' });
    else
      setMode({
        kind: 'key',
        key:
          state.k === 'ready' ? { owner: state.owner, expectedWallet: state.expectedWallet } : null,
      });
  }, [state, setMode]);
}

/** Wallets are on: the owner is the person's wallet key, never a typed address. */
export const isKeyMode = (state: RegisterKey) => state.k !== 'address' && state.k !== 'loading';

/**
 * The agent's wallet address as a screen may show it. With wallets on it is also the money wallet,
 * so (as on Add funds) it is shown only when it is exactly the wallet the key held here makes for
 * the agent; otherwise there is no address and nothing to copy. While it isn't known yet whether
 * wallets are on, nothing is shown. With wallets off, as before.
 */
export function walletAddressShown(
  state: RegisterKey,
  address: string | null,
): { address: string | null; note: string | null } {
  if (!address) return { address: null, note: null };
  // Not known yet whether wallets are on: nothing is shown until it is (fails closed).
  if (state.k === 'loading') return { address: null, note: null };
  if (!isKeyMode(state)) return { address, note: null };
  if (state.k !== 'ready') return { address: null, note: 'Shown once your key is unlocked here' };
  if (address.toLowerCase() === state.expectedWallet.toLowerCase()) return { address, note: null };
  return { address: null, note: 'Not the wallet your key makes, so not shown' };
}
