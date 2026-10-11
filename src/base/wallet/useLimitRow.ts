import { useEffect, useState } from 'react';
import { currentLimit, limitText, readLimits } from './limits';

/**
 * The Spending limit row's value on an agent's wallet: undefined while the read is out, null when
 * the server doesn't offer limits (404: the row stays as it was), else the limit in force
 * ("20.00 USDC a day"), "Revoking…" while a revoke is on its way ("Revoked · finalizing" once Base
 * shows it revoked, until final), or "None" (value null when the
 * read failed: the row still opens the screen, which says why).
 */
export function useLimitRow(agentId: string): { value: string | null } | null | undefined {
  const [row, setRow] = useState<{ value: string | null } | null | undefined>(undefined);
  useEffect(() => {
    setRow(undefined);
    let live = true;
    readLimits(agentId).then(
      (read) => {
        if (!live) return;
        if (read.kind === 'off') return setRow(null);
        const limit = currentLimit(read.view);
        setRow({
          value: !limit
            ? 'None'
            : limit.state === 'revoke_pending'
              ? limit.onchain?.revoked
                ? 'Revoked · finalizing'
                : 'Revoking…'
              : limitText(limit),
        });
      },
      () => live && setRow({ value: null }),
    );
    return () => {
      live = false;
    };
  }, [agentId]);
  return row;
}
