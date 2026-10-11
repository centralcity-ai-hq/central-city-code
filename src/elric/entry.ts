/** The parts of GET /api/elric that decide where the console's "Elric" entry leads. */
export type ElricEntryStatus = {
  agent_id?: string | null;
  eligible?: boolean;
  eligibility_reason?: string | null;
};

/**
 * Where the console's "Elric" entry leads for this account:
 * - 'hidden': Elric is off on this server (no status) or the account is under 18;
 * - 'activity': the account has Elric, or may create it (a verified adult): the in-console
 *   activity and settings view;
 * - 'setup': anything else (no Google sign-in, no date of birth yet, ...): /elric, which shows
 *   the step the account still needs. The activity view is never shown to such an account.
 */
export function elricEntry(status: ElricEntryStatus | null): 'hidden' | 'activity' | 'setup' {
  if (!status || status.eligibility_reason === 'age_under_18') return 'hidden';
  if (status.agent_id || status.eligible === true) return 'activity';
  return 'setup';
}
