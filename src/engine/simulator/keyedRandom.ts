// Identity-keyed random numbers (DESIGN.md §9.3). A draw depends only on its key, never on when it is
// made or how many draws came before, so the original and mitigated runs get the same value for the same
// logical piece of work.

/** What a draw is for; part of every key so draws of different kinds never collide. */
export const Purpose = {
  arrival: 1,
  serviceTime: 2,
  error: 3,
  backoff: 4,
} as const;

/** Murmur3's 32-bit finalizer: spreads every input bit over the whole output. */
function fmix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combines a running hash with one more 32-bit integer. */
export function mixHash(hash: number, part: number): number {
  return fmix32(Math.imul(hash ^ fmix32(part), 0x9e3779b1) + 0x7f4a7c15);
}

/** A uniform number in the open interval (0, 1), determined only by the seed and the key parts (integers). */
export function keyedUniform(seed: number, ...parts: number[]): number {
  let hash = fmix32(seed);
  for (const part of parts) hash = mixHash(hash, part);
  // Mapping 0..2³²−1 to (k + 0.5) / 2³² keeps both 0 and 1 out of reach.
  return (hash + 0.5) / 4294967296;
}
