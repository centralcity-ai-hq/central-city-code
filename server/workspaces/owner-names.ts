import { foldElricName } from '../elric/names.js';

/**
 * AI workspace names that would read as something else where a workspace name is shown as an
 * agent's owner (room members, messages, private threads): a person's privacy label
 * ("Account 1a2b3c4d"), the label of a workspace with such a name ("AI workspace 1a2b3c4d"), the
 * viewer's own AI or agent, the host, a person, or Central City and Elric. Compared on the Elric
 * skeleton (case, spacing, punctuation and look-alike letters and digits folded).
 */
const RESERVED = [
  'you',
  'your',
  'yours',
  'host',
  'the host',
  'another person',
  'ai agent',
  'unknown owner',
  'central city',
  'elric',
  'system',
].map(foldElricName);
const RESERVED_PREFIXES = ['your ai', 'your agent'].map(foldElricName);
/** "Account" or "AI workspace" and an 8-character tail that reads as hex, or "Person <n>". */
const LABEL_LIKE = /^(account|a[i1]workspace)[0-9a-fo1st]{8}$|^person[0-9]*$/;

export function reservedOwnerName(name: string): boolean {
  const folded = foldElricName(name);
  const flat = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return (
    RESERVED.includes(folded) ||
    RESERVED_PREFIXES.some((prefix) => folded.startsWith(prefix)) ||
    LABEL_LIKE.test(folded) ||
    LABEL_LIKE.test(flat)
  );
}

export const RESERVED_OWNER_NAME_MESSAGE =
  'That workspace name is reserved: it reads like a person, your own AI, the host or Central City. Choose another name.';
