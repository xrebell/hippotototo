/**
 * Seeded RNG (mulberry32) + deterministic integer hashing for decoration.
 * COMPLETE. Owner: GAMEPLAY (shared utility, others import read-only).
 *
 * Two streams per run (spec §8.1):
 *   - course RNG:   createRng(seed)                 -> ONLY the generator uses it.
 *   - cosmetic RNG: createRng(cosmeticSeed(seed))   -> particles, blinks, captions, decoration phases.
 * Same seed + same inputs = same run, so visuals must never draw from the course stream.
 */
import type { Rng } from './types';

/** Golden-ratio constant used to derive the cosmetic stream (spec: seed ^ 0x9E3779B9). */
export const COSMETIC_XOR = 0x9e3779b9;

/** Cosmetic stream seed for a run seed. */
export function cosmeticSeed(seed: number): number {
  return (seed ^ COSMETIC_XOR) >>> 0;
}

/** One mulberry32 step on a 32-bit state. Returns [0, 1). Exposed for tests. */
export function mulberry32Next(state: { s: number }): number {
  state.s = (state.s + 0x6d2b79f5) | 0;
  let t = state.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Create a seeded stream. Allocates once (object + methods); calling methods never allocates.
 */
export function createRng(seed: number): Rng {
  const st = { s: seed | 0 };
  let currentSeed = seed >>> 0;

  const next = (): number => mulberry32Next(st);

  const rng: Rng = {
    get seed(): number {
      return currentSeed;
    },
    next,
    range(a: number, b: number): number {
      return a + (b - a) * next();
    },
    int(a: number, b: number): number {
      return a + Math.floor(next() * (b - a + 1));
    },
    chance(p: number): boolean {
      return next() < p;
    },
    sign(): number {
      return next() < 0.5 ? -1 : 1;
    },
    reset(newSeed: number): void {
      currentSeed = newSeed >>> 0;
      st.s = newSeed | 0;
    },
  };
  return rng;
}

/** 32-bit integer avalanche hash (lowbias32). Returns an unsigned 32-bit int. */
export function hashU32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Deterministic [0, 1) value for (tile index, layer salt, channel). Used by render for
 * infinite parallax decoration with zero storage (spec §8.5). `i` may be negative.
 */
export function hash01(i: number, salt: number, channel?: number): number {
  const c = channel === undefined ? 0 : channel;
  const h = hashU32(Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35));
  return h / 4294967296;
}

/**
 * Parse `?seed=N` from a location.search string. Returns an unsigned 32-bit seed or -1 when absent
 * or invalid. Non-numeric strings are hashed so `?seed=hippo` also works.
 */
export function parseSeedParam(search: string): number {
  if (!search) return -1;
  const m = /[?&]seed=([^&#]*)/.exec(search);
  if (!m || m[1] === '') return -1;
  const raw = decodeURIComponent(m[1]);
  const n = Number(raw);
  if (isFinite(n) && raw.trim() !== '') return Math.floor(Math.abs(n)) >>> 0;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h = Math.imul(h ^ raw.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Fresh seed when none is forced: Date.now() >>> 0 (spec §8.1). */
export function timeSeed(): number {
  return Date.now() >>> 0;
}
