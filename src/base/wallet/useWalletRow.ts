import { useEffect, useRef, useState } from 'react';
import { readWallet, usdcAmountText, type WalletRead } from './api';

/** The row's value when the read failed: still shown, so the Wallet screen (with retry) opens. */
export const WALLET_ROW_UNREAD = 'Couldn’t load';

/** The Wallet row's value for one read; null only when wallets aren't offered here. */
export function walletRowValue(read: WalletRead): string | null {
  if (read.kind === 'off') return null;
  if (read.kind === 'wallet') return `${usdcAmountText(read.wallet.usdc)} USDC`;
  if (read.kind === 'none') return 'Set up';
  if (read.kind === 'registered_elsewhere') return 'In your own wallet';
  return 'Base isn’t answering';
}

/**
 * The Wallet row's value on an agent's pane: its USDC balance, "Set up" when it has none, "In your
 * own wallet" when its Base ID is held by a wallet the owner's own outside wallet controls, or
 * null when wallets aren't offered here (the row is then not shown). Read per agent and again
 * each time the pane is `active` (back on its home screen after setup, a withdrawal or a payment).
 */
export function useWalletRow(agentId: string | null, active = true): string | null {
  const [value, setValue] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    // A new agent starts empty; a re-read of the same agent keeps its value until the answer.
    if (shown.current !== agentId) setValue(null);
    shown.current = agentId;
    if (!agentId || !active) return;
    let live = true;
    readWallet(agentId).then(
      (read) => live && setValue(walletRowValue(read)),
      () => live && setValue(WALLET_ROW_UNREAD),
    );
    return () => {
      live = false;
    };
  }, [agentId, active]);
  return value;
}
