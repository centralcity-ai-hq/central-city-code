import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { RegistrationRow } from '../baseRegistrationModel';
import { raterOf, type Rater } from '../../agents/v4/rateScreenModel';

/*
 * Whether an agent may rate others (Operation Rating R2): its own registration on Base, read once
 * per agent. Only a Central City agent on Base with a final Base ID and a passport rates; until
 * that is known, or when it can't be read, there is no Rate.
 */

/** Ratings answered 404 in this page: they aren't switched on here, so Rate isn't offered. */
let off = false;
export const markRatingsOff = () => {
  off = true;
};
export const ratingsOff = () => off;

export async function readRater(agentId: string): Promise<Rater | null> {
  try {
    const read = await api<{ identities?: RegistrationRow[] }>(
      `/api/base/agents/${encodeURIComponent(agentId)}/registration`,
      undefined,
      'GET',
    );
    return raterOf(read?.identities);
  } catch {
    return null;
  }
}

/** The agent as a rater, or null (not one, not known yet, or ratings are off). */
export function useRater(agentId: string | null): Rater | null {
  const [rater, setRater] = useState<Rater | null>(null);
  useEffect(() => {
    setRater(null);
    if (!agentId || off) return;
    let live = true;
    void readRater(agentId).then((value) => {
      if (live) setRater(value);
    });
    return () => {
      live = false;
    };
  }, [agentId]);
  return off ? null : rater;
}
