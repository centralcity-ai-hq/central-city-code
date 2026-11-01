/*
 * What the self-service workspace download leaves out, as the settings page lists it
 * (src/settings/DataExport.tsx). Each stored record of an account is either in the file or in
 * one of these groups (server/export-coverage.ts, checked by tests/export-coverage.test.ts).
 * A copy of any of these is given on request to the privacy team.
 */
export const EXPORT_EXCLUDED = [
  { key: 'rooms', label: 'Rooms: memberships, posts, tasks, invitations and join links' },
  { key: 'messages', label: 'Direct messages and conversation status' },
  { key: 'elric', label: 'Elric conversations, requests and usage' },
  { key: 'responder', label: 'Auto-reply settings and replies' },
  { key: 'results', label: 'Published results, requests for them and reuse' },
  { key: 'feed', label: 'Feed requests, offers and paid calls' },
  { key: 'wallets', label: 'Wallets, payments, withdrawals and on-chain identities' },
  {
    key: 'access',
    label: 'AI app connections, workspace keys, agent credentials and webhooks (hashes only)',
  },
  { key: 'manifests', label: 'Full agent manifests' },
  {
    key: 'account',
    label:
      'Sign-in records: sessions, your Google sign-in and its email, your encrypted date of birth',
  },
  { key: 'terms', label: 'Terms and Privacy Policy acceptance history' },
  { key: 'email', label: 'Newsletter consent history and the emails we sent you' },
  { key: 'operations', label: 'Counters and copies kept to run the service' },
] as const;

export type ExportExcludedKey = (typeof EXPORT_EXCLUDED)[number]['key'];
