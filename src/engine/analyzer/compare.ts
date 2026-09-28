// Time comparisons with a small tolerance, shared by every rule (DESIGN.md §7), so that a value landing
// exactly on a boundary, such as a worst case equal to its share, is not flipped by floating-point noise.
import type { Ms } from '../config/schema';

export const TOLERANCE_MS = 1e-9;

/** a is meaningfully greater than b. */
export function exceeds(a: Ms, b: Ms): boolean {
  return a > b + TOLERANCE_MS;
}

/** a is at most b, up to the tolerance. */
export function fits(a: Ms, b: Ms): boolean {
  return !exceeds(a, b);
}
