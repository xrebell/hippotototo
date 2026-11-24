/**
 * GameState factory, in-place reset, view metrics and shared pure spec formulas.
 * COMPLETE. Owner: GAMEPLAY (additive changes only during the parallel phase).
 *
 * Everything here allocates ONLY in createGameState / createEntity (called once per createGame).
 * resetRun() and every helper below are allocation-free and safe in hot paths.
 */
import {
  CHAIN_HUES,
  GOALS,
  GROUND_Y,
  LADDER_OCTAVES,
  MEDALS,
  NEVER,
  PENTA,
  PHASES,
  PHASE_FADE_M,
  PHASE_LEN_M,
  POOLS,
  SCORE,
  SPEED,
  U_PER_M,
  VIEW,
  VIEW_H,
} from './config';
import type { Entity, GameState, HeroState, Medal, PhaseState, SaveData, ViewMetrics } from './types';
import { defaultSave } from './storage';

/* ------------------------------------------------------------------ */
/* Pure spec formulas (shared by gameplay, render, ui, audio)          */
/* ------------------------------------------------------------------ */

/** Forward speed u/s at run time t (s): 340 + 280 * (1 - exp(-t / 75)). */
export function speedAt(t: number): number {
  return SPEED.start + SPEED.gain * (1 - Math.exp(-t / SPEED.tau));
}

/** Score multiplier for a chain: min(5, 1 + floor(chain / 2)). */
export function multiplierFor(chain: number): number {
  const m = 1 + Math.floor(chain / 2);
  return m > SCORE.multMax ? SCORE.multMax : m;
}

/** Chain bank value: min(2000, 10 * chain^2) for chain >= 2, else 0. */
export function chainBankValue(chain: number): number {
  if (chain < SCORE.bankMinChain) return 0;
  const v = SCORE.bankPerChainSq * chain * chain;
  return v > SCORE.bankMax ? SCORE.bankMax : v;
}

/** Drum bounce points before multiplier: min(200, 20 * chain). */
export function drumPoints(chain: number): number {
  const v = SCORE.drumPerChain * chain;
  return v > SCORE.drumMax ? SCORE.drumMax : v;
}

/**
 * Chain value (1-based, chain AFTER the bounce) -> ladder index 0..14 (A minor pentatonic,
 * up an octave every 5 steps, capped at 3 octaves: beyond the top it keeps cycling the top octave).
 */
export function ladderIndex(chain: number): number {
  const i = chain < 1 ? 0 : chain - 1;
  const top = LADDER_OCTAVES * 5;
  if (i < top) return i;
  return top - 5 + ((i - top) % 5);
}

/** Semitones above A2 for a ladder index. Frequency = NOTE_ROOT_HZ * 2^(semi/12). */
export function ladderSemitone(index: number): number {
  return 12 * Math.floor(index / 5) + PENTA[index % 5];
}

/** Chain hue index (0..4) for a chain value (1-based). Use CHAIN_HUES[hueIndex(chain)]. */
export function hueIndex(chain: number): number {
  const i = chain < 1 ? 0 : chain - 1;
  return i % CHAIN_HUES.length;
}

/** Medal for a score. */
export function medalFor(score: number): Medal {
  if (score >= MEDALS.gold) return 'gold';
  if (score >= MEDALS.silver) return 'silver';
  if (score >= MEDALS.bronze) return 'bronze';
  return 'none';
}

/** Label of the current goal or '' when all are done. */
export function goalLabel(goalIndex: number): string {
  return goalIndex >= 0 && goalIndex < GOALS.length ? GOALS[goalIndex].label : '';
}

/**
 * Day phase from distance (m) into `out`: each phase 250 m, cross-fade over the last 50 m,
 * loops dawn -> noon -> dusk -> night -> dawn.
 */
export function phaseAt(distanceM: number, out: PhaseState): void {
  const d = distanceM < 0 ? 0 : distanceM;
  const p = Math.floor(d / PHASE_LEN_M);
  const n = PHASES.length;
  out.index = p % n;
  out.next = (out.index + 1) % n;
  out.loop = Math.floor(p / n);
  const into = d - p * PHASE_LEN_M;
  const fadeStart = PHASE_LEN_M - PHASE_FADE_M;
  out.blend = into <= fadeStart ? 0 : (into - fadeStart) / PHASE_FADE_M;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ------------------------------------------------------------------ */
/* View metrics (spec §2)                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute view metrics from the canvas CSS size. Writes into `out` (no allocation) and does NOT
 * bump out.version (the caller does, after resizing the backing store).
 * insets: CSS px safe-area insets.
 */
export function computeView(
  cssW: number,
  cssH: number,
  devicePixelRatio: number,
  insetL: number,
  insetR: number,
  insetT: number,
  insetB: number,
  lowQuality: boolean,
  out: ViewMetrics,
): void {
  const w = cssW > 1 ? cssW : 1;
  const h = cssH > 1 ? cssH : 1;
  const cap = lowQuality ? VIEW.dprLow : VIEW.dprMax;
  const rawDpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  out.dpr = rawDpr < cap ? rawDpr : cap;
  out.cssW = w;
  out.cssH = h;

  let s = Math.min(h / VIEW_H, w / VIEW.minW);
  let viewW = w / s;
  let viewH = h / s;
  let padX = 0;
  if (viewW > VIEW.maxW) {
    s = w / VIEW.maxW;
    viewW = VIEW.maxW;
    viewH = h / s;
    if (viewH < VIEW.minHPillar) {
      s = h / VIEW.minHPillar;
      viewH = VIEW.minHPillar;
      viewW = VIEW.maxW;
      padX = (w - viewW * s) / 2;
    }
  }
  out.s = s;
  out.viewW = viewW;
  out.viewH = viewH;
  out.padX = padX;
  out.offsetY = viewH >= VIEW_H ? (viewH - VIEW_H) * VIEW.offsetYFactor : viewH - VIEW_H;
  out.heroX = Math.max(VIEW.heroXMin, VIEW.heroXFrac * viewW);
  out.safeL = insetL / s;
  out.safeR = insetR / s;
  out.safeT = insetT / s;
  out.safeB = insetB / s;
  out.portrait = h > w;
}

/* ------------------------------------------------------------------ */
/* Factories                                                           */
/* ------------------------------------------------------------------ */

/** Allocate one pooled entity record (inactive). */
export function createEntity(): Entity {
  return {
    active: false,
    kind: 'drum',
    serial: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
    baseY: 0,
    phase: 0,
    age: 0,
    hitT: NEVER,
    hue: -1,
    rot: 0,
    flag: 'none',
    stateT: 0,
    hazard: false,
    stompable: false,
    optional: false,
    warnT: 0,
    nearMin: 1e9,
    nearDone: false,
    template: '',
  };
}

/** Reset a pooled entity to defaults (inactive). Allocation-free. */
export function clearEntity(e: Entity): void {
  e.active = false;
  e.kind = 'drum';
  e.serial = 0;
  e.x = 0;
  e.y = 0;
  e.w = 0;
  e.h = 0;
  e.vx = 0;
  e.vy = 0;
  e.baseY = 0;
  e.phase = 0;
  e.age = 0;
  e.hitT = NEVER;
  e.hue = -1;
  e.rot = 0;
  e.flag = 'none';
  e.stateT = 0;
  e.hazard = false;
  e.stompable = false;
  e.optional = false;
  e.warnT = 0;
  e.nearMin = 1e9;
  e.nearDone = false;
  e.template = '';
}

function createHero(): HeroState {
  const h = {} as HeroState;
  resetHero(h);
  return h;
}

/** Reset hero to standing at x = 0 on the ground. Allocation-free. */
export function resetHero(h: HeroState): void {
  h.x = 0;
  h.y = GROUND_Y;
  h.prevY = GROUND_Y;
  h.vy = 0;
  h.grounded = true;
  h.action = 'run';
  h.coyoteT = 0;
  h.airT = 0;
  h.bufferT = 0;
  h.slamUsed = false;
  h.hangT = 0;
  h.boingQueued = false;
  h.postSlamT = NEVER;
  h.held = false;
  h.holdT = 0;
  h.cutPending = false;
  h.pitIndex = -1;
  h.pose = 'run';
  h.expr = 'serious';
  h.exprT = 0;
  h.squashX = 1;
  h.squashY = 1;
  h.squashVX = 0;
  h.squashVY = 0;
  h.rot = 0;
  h.runPhase = 0;
  h.lookX = 300;
  h.lookY = GROUND_Y - 30;
  h.flashT = 0;
  h.sweatT = 0;
  h.cheekPuff = 0;
  h.whip = 0;
  h.shield = false;
  h.invulnT = 0;
  h.magnetT = 0;
  h.deathT = 0;
  h.sinkDepth = 0;
}

/**
 * Create THE game state (once per createGame). `save` is copied by reference (state.save IS that
 * object from now on; mutate it in place and call writeSave(state.save)).
 */
export function createGameState(seed: number, save: SaveData | null, standalone: boolean): GameState {
  const entities: Entity[] = [];
  for (let i = 0; i < POOLS.entities; i++) entities.push(createEntity());
  const mangoes: Entity[] = [];
  for (let i = 0; i < POOLS.mangoes; i++) mangoes.push(createEntity());

  const state: GameState = {
    mode: 'title',
    modeT: 0,
    seed: seed >>> 0,
    nextSeed: -1,
    standalone,
    firstRun: false,
    view: {
      cssW: 1,
      cssH: 1,
      dpr: 1,
      s: 1,
      viewW: VIEW.minW,
      viewH: VIEW_H,
      offsetY: 0,
      padX: 0,
      heroX: VIEW.heroXMin,
      safeL: 0,
      safeR: 0,
      safeT: 0,
      safeB: 0,
      portrait: false,
      version: 0,
    },
    clock: { now: 0, frameDt: 0, alpha: 0, fps: 60, frame: 0, lowQuality: false },
    cam: { x: -VIEW.heroXMin, prevX: -VIEW.heroXMin, shakeX: 0, shakeY: 0, trauma: 0 },
    hero: createHero(),
    run: {
      time: 0,
      distance: 0,
      speed: SPEED.start,
      score: 0,
      chain: 0,
      chainBest: 0,
      multiplier: 1,
      groove: 0,
      mangoes: 0,
      golden: 0,
      stomps: 0,
      booms: 0,
      boings: 0,
      drums: 0,
      nearMisses: 0,
      smashes: 0,
      mangoStreak: 0,
      mangoStreakT: NEVER,
      metresScored: 0,
      bestPassed: false,
      phasesSeen: 1,
      goalDone: false,
    },
    fever: { active: false, t: 0, count: 0 },
    phase: { index: 0, next: 1, blend: 0, loop: 0 },
    entities,
    mangoes,
    entityCount: 0,
    mangoCount: 0,
    nextSerial: 1,
    timeScale: 1,
    hitStop: 0,
    deathCause: null,
    tutorial: { active: false, prompt: 'none', promptX: 0, promptY: 0, promptT: 0, freeze: false },
    pause: { countdown: 0, reason: 'none' },
    banner: { text: '', t: 0, dur: 0 },
    toast: { text: '', t: 0, dur: 0 },
    summary: {
      score: 0,
      distance: 0,
      chainBest: 0,
      mangoes: 0,
      stomps: 0,
      newBest: false,
      bestBy: 0,
      shortBy: 0,
      medal: 'none',
      caption: '',
      goalText: '',
      goalDone: false,
      goalDoneText: '',
    },
    music: { bpm: 96, beatPhase: 0, beat: 0 },
    save: save ? save : defaultSave(),
    lastDevice: 'keyboard',
    debug: { overlay: false, invincible: false, autopilot: false, template: '' },
  };
  return state;
}

/**
 * Reset everything run-scoped IN PLACE for a new run with `seed` (pools deactivated, hero at x=0,
 * counters zeroed, timers cleared). Keeps view, clock, save, music, debug, standalone, lastDevice,
 * mode (the caller sets mode). Does NOT reseed RNGs (caller: rng.reset(seed), crng.reset(cosmeticSeed(seed))).
 */
export function resetRun(state: GameState, seed: number): void {
  state.seed = seed >>> 0;
  resetHero(state.hero);
  const r = state.run;
  r.time = 0;
  r.distance = 0;
  r.speed = SPEED.start;
  r.score = 0;
  r.chain = 0;
  r.chainBest = 0;
  r.multiplier = 1;
  r.groove = 0;
  r.mangoes = 0;
  r.golden = 0;
  r.stomps = 0;
  r.booms = 0;
  r.boings = 0;
  r.drums = 0;
  r.nearMisses = 0;
  r.smashes = 0;
  r.mangoStreak = 0;
  r.mangoStreakT = NEVER;
  r.metresScored = 0;
  r.bestPassed = false;
  r.phasesSeen = 1;
  r.goalDone = false;

  state.fever.active = false;
  state.fever.t = 0;
  state.fever.count = 0;
  phaseAt(0, state.phase);

  for (let i = 0; i < state.entities.length; i++) clearEntity(state.entities[i]);
  for (let i = 0; i < state.mangoes.length; i++) clearEntity(state.mangoes[i]);
  state.entityCount = 0;
  state.mangoCount = 0;
  state.nextSerial = 1;

  state.cam.x = state.hero.x - state.view.heroX;
  state.cam.prevX = state.cam.x;
  state.cam.shakeX = 0;
  state.cam.shakeY = 0;
  state.cam.trauma = 0;

  state.timeScale = 1;
  state.hitStop = 0;
  state.deathCause = null;

  const t = state.tutorial;
  t.active = false;
  t.prompt = 'none';
  t.promptX = 0;
  t.promptY = 0;
  t.promptT = 0;
  t.freeze = false;

  state.pause.countdown = 0;
  state.pause.reason = 'none';
  state.banner.text = '';
  state.banner.t = 0;
  state.banner.dur = 0;
  state.debug.template = '';
}

/** Distance in metres for a world x (hero starts at 0). */
export function metresAt(worldX: number): number {
  return worldX / U_PER_M;
}
