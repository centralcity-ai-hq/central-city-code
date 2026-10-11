import { useEffect, useState } from 'react';
import { readWallet, usdcNumber } from './api';

/**
 * The Wallet row's value on an agent's pane: its USDC balance, "Set up" when it has none, "In your
 * own wallet" when its Base ID is held by a wallet the owner's own outside wallet controls, or
 * null when wallets aren't offered here (the row is then not shown). Read once per agent.
 */
export function useWalletRow(agentId: string | null): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    setValue(null);
    if (!agentId) return;
    let live = true;
    readWallet(agentId).then(
      (read) => {
        if (!live) return;
        if (read.kind === 'off') setValue(null);
        else if (read.kind === 'wallet')
          setValue(`${(Math.round(usdcNumber(read.wallet.usdc) * 100) / 100).toFixed(2)} USDC`);
        else if (read.kind === 'none') setValue('Set up');
        else if (read.kind === 'registered_elsewhere') setValue('In your own wallet');
        else setValue('Base isn’t answering');
      },
      () => live && setValue(null),
    );
    return () => {
      live = false;
    };
  }, [agentId]);
  return value;
}
