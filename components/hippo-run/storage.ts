/**
 * Save / load with in-memory fallback. COMPLETE. Owner: GAMEPLAY (others never write saves).
 *
 * One JSON object under localStorage key "hippotototo.v1" (spec §13):
 *   { v:1, best, bestDist, bestChain, runs, totalMangoes, muted, reducedMotion, tutorialSeen, goalIndex }
 * Every access is wrapped in try/catch: blocked/throwing localStorage (Safari private mode,
 * sandboxed iframes, SSR) silently falls back to a module-level in-memory copy, so the game
 * works identically, just without persistence across reloads.
 *
 * Call sites: load once in createGame; write ONLY at run end and on settings change.
 * No DOM access at module top level (module is evaluated during Next SSR).
 */
import { GOALS, STORAGE_KEY } from './config';
import type { SaveData } from './types';

/** In-memory fallback (survives StrictMode remounts within the page). */
let memoryCopy: string | null = null;

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const ls = window.localStorage;
    return ls ? ls : null;
  } catch (_e) {
    return null;
  }
}

/** prefers-reduced-motion media query (false when unavailable). */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_e) {
    return false;
  }
}

/** Fresh save. reducedMotion defaults to the OS preference. */
export function defaultSave(reducedMotion?: boolean): SaveData {
  return {
    v: 1,
    best: 0,
    bestDist: 0,
    bestChain: 0,
    runs: 0,
    totalMangoes: 0,
    muted: false,
    reducedMotion: reducedMotion === undefined ? prefersReducedMotion() : reducedMotion,
    tutorialSeen: false,
    goalIndex: 0,
  };
}

function num(v: unknown, fallback: number, max: number): number {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return fallback;
  return Math.min(Math.floor(v), max);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Validate any parsed JSON into a well-formed SaveData (unknown keys dropped, bad values defaulted). */
export function sanitizeSave(raw: unknown): SaveData {
  const d = defaultSave();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as { [k: string]: unknown };
  const BIG = 1e9;
  return {
    v: 1,
    best: num(o.best, d.best, BIG),
    bestDist: num(o.bestDist, d.bestDist, BIG),
    bestChain: num(o.bestChain, d.bestChain, BIG),
    runs: num(o.runs, d.runs, BIG),
    totalMangoes: num(o.totalMangoes, d.totalMangoes, BIG),
    muted: bool(o.muted, d.muted),
    reducedMotion: bool(o.reducedMotion, d.reducedMotion),
    tutorialSeen: bool(o.tutorialSeen, d.tutorialSeen),
    goalIndex: num(o.goalIndex, d.goalIndex, GOALS.length),
  };
}

function readRaw(): string | null {
  const ls = getStorage();
  if (ls) {
    try {
      const s = ls.getItem(STORAGE_KEY);
      if (s !== null) return s;
    } catch (_e) {
      /* fall through to memory */
    }
  }
  return memoryCopy;
}

/** True when any save exists (localStorage or memory). First-ever run = no save. */
export function hasStoredSave(): boolean {
  return readRaw() !== null;
}

/** Load the save (or defaults). Never throws. */
export function loadSave(): SaveData {
  const raw = readRaw();
  if (raw === null) return defaultSave();
  try {
    return sanitizeSave(JSON.parse(raw));
  } catch (_e) {
    return defaultSave();
  }
}

/**
 * Persist. Returns true when it reached localStorage, false when only the in-memory copy was
 * updated. Never throws. Not a hot path (run end / settings change only).
 */
export function writeSave(data: SaveData): boolean {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch (_e) {
    return false;
  }
  memoryCopy = json;
  const ls = getStorage();
  if (!ls) return false;
  try {
    ls.setItem(STORAGE_KEY, json);
    return true;
  } catch (_e) {
    return false;
  }
}

/** Copy every field of `src` into `dst` (keeps the GameState.save object identity). */
export function copySave(dst: SaveData, src: SaveData): void {
  dst.v = 1;
  dst.best = src.best;
  dst.bestDist = src.bestDist;
  dst.bestChain = src.bestChain;
  dst.runs = src.runs;
  dst.totalMangoes = src.totalMangoes;
  dst.muted = src.muted;
  dst.reducedMotion = src.reducedMotion;
  dst.tutorialSeen = src.tutorialSeen;
  dst.goalIndex = src.goalIndex;
}
