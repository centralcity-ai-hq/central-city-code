/*
 * Short agent ids for ERC-8004 registrations (docs/base/ARCHITECTURE.md §11.6). The on-chain
 * agent URI is `https://centralcity.ai/a/<6 base62 chars>`: exactly 31 bytes, which fits one
 * storage slot and keeps registration at its cheapest. 62^6 ≈ 56.8 billion ids.
 */
import { randomInt } from 'node:crypto';

export const SHORT_ID_LENGTH = 6;
export const SHORT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SHORT_URI_ORIGIN = 'https://centralcity.ai';
/** Longest URI that still fits one storage slot. */
export const MAX_AGENT_URI_BYTES = 31;

const SHORT_ID = /^[0-9A-Za-z]{6}$/;

export const isShortId = (value: string): boolean => SHORT_ID.test(value);

/** A uniformly random short id (crypto RNG, no modulo bias). */
export function newShortId(): string {
  let id = '';
  for (let i = 0; i < SHORT_ID_LENGTH; i++) id += SHORT_ID_ALPHABET[randomInt(62)];
  return id;
}

/** The on-chain agent URI for a short id; refuses anything that would exceed one slot. */
export function shortAgentUri(shortId: string, origin = SHORT_URI_ORIGIN): string {
  if (!isShortId(shortId)) throw new Error('Invalid short id.');
  const uri = `${origin}/a/${shortId}`;
  if (Buffer.byteLength(uri, 'utf8') > MAX_AGENT_URI_BYTES)
    throw new Error('Agent URI exceeds one storage slot.');
  return uri;
}
