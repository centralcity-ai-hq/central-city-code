import { createHash } from 'node:crypto';

/*
 * Streaming RFC 6962 Merkle hashing for the checkpoint job. The shared helpers
 * (shared/count-log) hold every leaf in memory and hash through WebCrypto one node at a time;
 * here the leaves are fed in index order and only O(log n) nodes are kept. The bytes are the
 * same: 0x00/0x01 domain separation, SHA-256, and the RFC 6962 split (largest power of two
 * below n). tests/count-log-scale.test.ts checks both against each other.
 */

const EMPTY_ROOT = createHash('sha256').digest();

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return createHash('sha256').update(Uint8Array.of(1)).update(left).update(right).digest();
}

/** Merkle Tree Hash of a run of consecutive leaves, fed one at a time. */
export class StreamingRoot {
  private stack: { size: number; hash: Uint8Array }[] = [];
  private count = 0;
  push(leaf: Uint8Array): void {
    let node = { size: 1, hash: leaf };
    while (this.stack.length && this.stack.at(-1)!.size === node.size) {
      const left = this.stack.pop()!;
      node = { size: node.size * 2, hash: nodeHash(left.hash, node.hash) };
    }
    this.stack.push(node);
    this.count++;
  }
  get size(): number {
    return this.count;
  }
  /** The perfect subtrees have decreasing sizes; folding them right to left is MTH (RFC 6962). */
  root(): Uint8Array {
    if (!this.stack.length) return new Uint8Array(EMPTY_ROOT);
    let hash = this.stack.at(-1)!.hash;
    for (let i = this.stack.length - 2; i >= 0; i--) hash = nodeHash(this.stack[i]!.hash, hash);
    return hash;
  }
}

function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * The leaf ranges [start, start + size) whose subtree roots form the consistency proof from m to
 * n, in proof order: the same walk as shared/count-log consistencyProof. The ranges are disjoint.
 */
export function consistencyRanges(m: number, n: number): { start: number; size: number }[] {
  if (!Number.isInteger(m) || m < 0 || m > n) throw new Error('Old size out of range.');
  if (m === 0 || m === n) return [];
  const trail: { start: number; size: number }[] = [];
  let start = 0;
  let size = n;
  let mm = m;
  let complete = true;
  while (true) {
    if (mm === size) {
      if (!complete) trail.push({ start, size });
      break;
    }
    const k = split(size);
    if (mm <= k) {
      trail.push({ start: start + k, size: size - k });
      size = k;
    } else {
      trail.push({ start, size: k });
      start += k;
      size -= k;
      mm -= k;
      complete = false;
    }
  }
  return trail.reverse();
}

/**
 * Root of all n leaves and the consistency proof from oldSize, in one ordered pass over the
 * leaves. `pages` yields the leaves in index order (any page size).
 */
export async function rootAndConsistency(
  n: number,
  oldSize: number | null,
  pages: AsyncIterable<Uint8Array[]>,
): Promise<{ root: Uint8Array; consistency: Uint8Array[] }> {
  const ranges = oldSize === null ? [] : consistencyRanges(oldSize, n);
  // Ranges sorted by start, each with its own hasher.
  const byStart = ranges
    .map((range, order) => ({ ...range, order, hasher: new StreamingRoot() }))
    .sort((a, b) => a.start - b.start);
  const all = new StreamingRoot();
  let r = 0;
  for await (const page of pages)
    for (const leaf of page) {
      const idx = all.size;
      if (idx >= n) throw new Error('More leaves than the tree size.');
      all.push(leaf);
      while (r < byStart.length && idx >= byStart[r]!.start + byStart[r]!.size) r++;
      const range = byStart[r];
      if (range && idx >= range.start) range.hasher.push(leaf);
    }
  if (all.size !== n) throw new Error('Fewer leaves than the tree size.');
  const consistency: Uint8Array[] = [];
  for (const range of byStart) consistency[range.order] = range.hasher.root();
  return { root: all.root(), consistency };
}
