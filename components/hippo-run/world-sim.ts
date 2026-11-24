/**
 * Gameplay-private core shared by hero.ts, world.ts, world-gen.ts and game.ts.
 * Owner: GAMEPLAY. NOT part of the cross-team contract (render/ui/audio never import it).
 *
 * Holds:
 *  - SimCtx: every piece of private per-game gameplay state that is not a GameState field
 *    (controller internals, generator bookkeeping, pacing timers, preallocated scratch). Created
 *    once per createGame and reset in place on every run, like GameState.
 *  - The closed-form run distance D(t) and its inverse (templates are authored in seconds and
 *    placed where the hero WILL be at that run time, so patterns stay exact at every speed).
 *  - The pooled spawnEntity() helper and shared rule helpers (score, chain, groove, chain bank,
 *    hit-stop, haptics, death, rule-8 hazard clearing) so every module applies them identically.
 *
 * Determinism: nothing here reads clocks, Math.random or view metrics. Cosmetic randomness goes
 * through sv.crng only; course randomness only through sv.rng (world-gen.ts).
 */
import {
  BEST_FLAG,
  BUSH,
  CHAIN_HUES,
  DRUM,
  FEVER,
  GOLDEN,
  GROUND_Y,
  HERO,
  HITSTOP,
  HORNBILL,
  LOG,
  MANGO,
  MELON,
  MOUND,
  MULT_COLORS,
  NEVER,
  PICKUP,
  PIT,
  POOLS,
  SCORE,
  SHAKE,
  SPEED,
  GROOVE,
  HAPTIC,
} from './config';
import type { Box, DeathCause, Entity, EntityKind, GameState, Services, TemplateId } from './types';
import { chainBankValue, multiplierFor, speedAt } from './state';
import { makeBox } from './geom';

/* ------------------------------------------------------------------ */
/* Derived timings                                                     */
/* ------------------------------------------------------------------ */

/**
 * Flight times (s) derived by stepping the exact hero integrator at DT (hero.ts
 * computeHeroTimings). Never hard-coded: tuning PHYS keeps every template solvable.
 */
export interface HeroTimings {
  /** Full jump ground -> ground (~0.644). */
  tJump: number;
  /** Ground takeoff -> falling through a ground-drum top (~0.603). */
  tOn: number;
  /** Drum top -> drum top, normal bounce (~0.644). */
  tBB: number;
  /** BOOM bounce, drum -> drum (~0.788). */
  tBoom: number;
  /** Drum top -> ground (~0.68). */
  tOff: number;
  /** Tap hop ground -> ground (~0.40). */
  tHop: number;
  /** BOOM bounce drum top -> ground. */
  tBoomOff: number;
  /** Normal bounce from a ground drum falling through a kite-drum top. */
  tBounceKite: number;
  /** BOOM bounce from a ground drum falling through a kite-drum top (~BB). */
  tBoomKite: number;
  /** Kite-drum bounce -> ground. */
  tKiteOff: number;
  /** Kite-drum bounce -> ground-drum top. */
  tKiteDrum: number;
  /** Ground-drum bounce -> hornbill top (hornbillStep). */
  tDrumHorn: number;
  /** Hornbill stomp bounce -> ground. */
  tHornOff: number;
  /** Time to apex / apex height (feet, u above launch) of a full jump and of a boing. */
  tApexJump: number;
  apexJump: number;
  tApexBoing: number;
  apexBoing: number;
}

/** Scratch trajectory sample (alt = feet height above ground, + up; vy + down). */
export interface Traj {
  alt: number;
  vy: number;
  t: number;
}

/* ------------------------------------------------------------------ */
/* Generator bookkeeping                                               */
/* ------------------------------------------------------------------ */

export interface GenState {
  /** Absolute run time (s) at which the next chunk starts. */
  cursorT: number;
  /** Last two template ids (excluded from selection). */
  lastA: TemplateId | '';
  lastB: TemplateId | '';
  /** Hazard (non-breather) chunks since the last breather. */
  hazardChunks: number;
  /** Bit mask of hazard types introduced this run (bush 1, mound 2, hornbill 4, pit 8, log 16). */
  seen: number;
  forceBreather: boolean;
  shieldDone: boolean;
  lastShieldT: number;
  lastMagnetT: number;
  lastGoldenT: number;
  /** Chunks generated this run (debug). */
  chunks: number;
}

/* ------------------------------------------------------------------ */
/* SimCtx                                                              */
/* ------------------------------------------------------------------ */

export interface SimCtx {
  tm: HeroTimings;
  /** advance(): no haptics. */
  quiet: boolean;
  /** Generator on (off in the ?gallery=1 art bench). */
  genEnabled: boolean;

  /* hero controller internals */
  /** Current flight may be cut by a release (ground / coyote / buffered jumps only). */
  cuttable: boolean;
  /** An ACTION press was consumed this sim step (teaching freeze release). */
  pressed: boolean;
  /** A ground / coyote / buffered jump launched this sim step (first-run assisted jump). */
  jumped: boolean;
  /** The current flight is a BOING launch (longer slam lockout). */
  boingLaunch: boolean;
  /** Footfall counter (dust every other one). */
  footFalls: number;
  /** A slam hit the GROUND this step (world bursts melons in reach). */
  slamImpact: boolean;
  slamImpactX: number;

  /* death */
  /** Set by kill(); game.ts switches to 'dying' and clears it. */
  died: boolean;
  deathVX: number;
  deathLanded: boolean;
  deathSink: boolean;

  /* pacing (REAL seconds; only affects timeScale, never the sim outcome) */
  nearSlowT: number;
  freezeLevel: number;
  freezeReal: number;
  freezeDone: boolean;
  /** Lesson slow-mo remaining (real s; SLAM / BOING prompts, first run). */
  lessonSlowT: number;
  /** First-run lessons already slowed for / HOLD prompt done (runs 1-3). */
  slamTaught: boolean;
  boingTaught: boolean;
  holdShown: boolean;
  /** Serial of the mound the HOLD prompt is showing for (0 = none yet). */
  holdSerial: number;

  /* run bookkeeping */
  hornbillStomps: number;
  goalAtStart: number;
  /** floor(distance / 250) last announced (phase banner). */
  phaseAbs: number;
  /** Best-flag world x (-1 = none this run). */
  flagX: number;
  flagSpawned: boolean;

  /* tutorial anchors (world u; 0 = none) + the live entities they belong to */
  tutBush: Entity | null;
  tutBushSerial: number;
  tutGold: Entity | null;
  tutGoldSerial: number;
  tutBushX: number;
  tutBushTop: number;
  tutBushLeft: number;
  tutSlamX0: number;
  tutSlamX1: number;
  tutGoldX: number;
  tutGoldY: number;

  /* title scene */
  titleDrum: Entity | null;
  titleAcc: number;

  /* per-slot private flags (index = pool slot; 0 on every free slot) */
  /** mangoes: 0 static, 1 homing (magnet / melon burst), 2 popping (melon burst, gravity first). */
  homing: Uint8Array;
  /** entities: log edge warning already fired. */
  warned: Uint8Array;

  gen: GenState;

  /* scratch (never escapes a call) */
  arcX: number[];
  arcY: number[];
  traj: Traj;
  hurt: Box;
  hit: Box;
  pick: Box;
}

export function createSimCtx(tm: HeroTimings): SimCtx {
  const arcX: number[] = [];
  const arcY: number[] = [];
  for (let i = 0; i < 16; i++) {
    arcX.push(0);
    arcY.push(0);
  }
  const sim: SimCtx = {
    tm,
    quiet: false,
    genEnabled: true,
    cuttable: false,
    pressed: false,
    jumped: false,
    boingLaunch: false,
    footFalls: 0,
    slamImpact: false,
    slamImpactX: 0,
    died: false,
    deathVX: 0,
    deathLanded: false,
    deathSink: false,
    nearSlowT: 0,
    freezeLevel: 0,
    freezeReal: 0,
    freezeDone: false,
    lessonSlowT: 0,
    slamTaught: false,
    boingTaught: false,
    holdShown: false,
    holdSerial: 0,
    hornbillStomps: 0,
    goalAtStart: 0,
    phaseAbs: 0,
    flagX: -1,
    flagSpawned: false,
    tutBush: null,
    tutBushSerial: 0,
    tutGold: null,
    tutGoldSerial: 0,
    tutBushX: 0,
    tutBushTop: 0,
    tutBushLeft: 0,
    tutSlamX0: 0,
    tutSlamX1: 0,
    tutGoldX: 0,
    tutGoldY: 0,
    titleDrum: null,
    titleAcc: 0,
    homing: new Uint8Array(POOLS.mangoes),
    warned: new Uint8Array(POOLS.entities),
    gen: {
      cursorT: 0,
      lastA: '',
      lastB: '',
      hazardChunks: 0,
      seen: 0,
      forceBreather: false,
      shieldDone: false,
      lastShieldT: -1e9,
      lastMagnetT: -1e9,
      lastGoldenT: -1e9,
      chunks: 0,
    },
    arcX,
    arcY,
    traj: { alt: 0, vy: 0, t: 0 },
    hurt: makeBox(),
    hit: makeBox(),
    pick: makeBox(),
  };
  return sim;
}

/** Reset every run-scoped field in place (pools are reset by state.resetRun). */
export function resetSimCtx(sim: SimCtx): void {
  sim.cuttable = false;
  sim.pressed = false;
  sim.jumped = false;
  sim.boingLaunch = false;
  sim.footFalls = 0;
  sim.slamImpact = false;
  sim.slamImpactX = 0;
  sim.died = false;
  sim.deathVX = 0;
  sim.deathLanded = false;
  sim.deathSink = false;
  sim.nearSlowT = 0;
  sim.freezeLevel = 0;
  sim.freezeReal = 0;
  sim.freezeDone = false;
  sim.lessonSlowT = 0;
  sim.slamTaught = false;
  sim.boingTaught = false;
  sim.holdShown = false;
  sim.holdSerial = 0;
  sim.hornbillStomps = 0;
  sim.goalAtStart = 0;
  sim.phaseAbs = 0;
  sim.flagX = -1;
  sim.flagSpawned = false;
  sim.tutBush = null;
  sim.tutBushSerial = 0;
  sim.tutGold = null;
  sim.tutGoldSerial = 0;
  sim.tutBushX = 0;
  sim.tutBushTop = 0;
  sim.tutBushLeft = 0;
  sim.tutSlamX0 = 0;
  sim.tutSlamX1 = 0;
  sim.tutGoldX = 0;
  sim.tutGoldY = 0;
  sim.titleDrum = null;
  sim.titleAcc = 0;
  for (let i = 0; i < sim.homing.length; i++) sim.homing[i] = 0;
  for (let i = 0; i < sim.warned.length; i++) sim.warned[i] = 0;
  const g = sim.gen;
  g.cursorT = 0;
  g.lastA = '';
  g.lastB = '';
  g.hazardChunks = 0;
  g.seen = 0;
  g.forceBreather = false;
  g.shieldDone = false;
  g.lastShieldT = -1e9;
  g.lastMagnetT = -1e9;
  g.lastGoldenT = -1e9;
  g.chunks = 0;
}

/* ------------------------------------------------------------------ */
/* Run distance D(t) (closed form of the speed curve)                  */
/* ------------------------------------------------------------------ */

/** Hero world x at run time t: integral of 340 + 280 (1 - e^(-t/75)). */
export function distanceAt(t: number): number {
  const tau = SPEED.tau;
  return (SPEED.start + SPEED.gain) * t - SPEED.gain * tau * (1 - Math.exp(-t / tau));
}

/** Inverse of distanceAt (Newton; converges in 3–4 iterations). */
export function timeAtX(x: number): number {
  if (x <= 0) return 0;
  let t = x / SPEED.start;
  for (let i = 0; i < 6; i++) {
    const f = distanceAt(t) - x;
    t -= f / speedAt(t);
    if (f < 1e-3 && f > -1e-3) break;
  }
  return t < 0 ? 0 : t;
}

/* ------------------------------------------------------------------ */
/* Entity pool                                                         */
/* ------------------------------------------------------------------ */

/** Default drawn size per kind (u). */
export function kindW(kind: EntityKind): number {
  switch (kind) {
    case 'drum':
    case 'kiteDrum':
      return DRUM.w;
    case 'bush':
      return BUSH.w;
    case 'mound':
      return MOUND.w;
    case 'hornbill':
      return HORNBILL.w;
    case 'pit':
      return 150;
    case 'log':
      return LOG.d;
    case 'melon':
      return MELON.w;
    case 'mango':
      return MANGO.size;
    case 'goldenMango':
      return GOLDEN.size;
    case 'pickupShield':
    case 'pickupMagnet':
      return PICKUP.size;
    case 'bestFlag':
      return BEST_FLAG.pennantW;
  }
  return 40;
}

export function kindH(kind: EntityKind): number {
  switch (kind) {
    case 'drum':
    case 'kiteDrum':
      return DRUM.h;
    case 'bush':
      return BUSH.h;
    case 'mound':
      return MOUND.h;
    case 'hornbill':
      return HORNBILL.h;
    case 'pit':
      return PIT.mudDepth;
    case 'log':
      return LOG.d;
    case 'melon':
      return MELON.h;
    case 'mango':
      return MANGO.size;
    case 'goldenMango':
      return GOLDEN.size;
    case 'pickupShield':
    case 'pickupMagnet':
      return PICKUP.size;
    case 'bestFlag':
      return BEST_FLAG.poleH;
  }
  return 40;
}

export function isMangoKind(kind: EntityKind): boolean {
  return kind === 'mango' || kind === 'goldenMango';
}

/**
 * Activate a free pool slot (mango kinds -> state.mangoes, others -> state.entities) with kind
 * defaults: size from config; ground kinds sit on GROUND_Y; kiteDrum top 170 u above ground;
 * hornbill top at GROUND_Y - maxAlt; pit top = GROUND_Y; hazard/stompable flags per kind.
 * x = LEFT edge. Returns null when the pool is full (callers cope).
 */
export function spawnEntity(state: GameState, sv: Services, kind: EntityKind, x: number): Entity | null {
  const pool = isMangoKind(kind) ? state.mangoes : state.entities;
  let e: Entity | null = null;
  for (let i = 0; i < pool.length; i++) {
    if (!pool[i].active) {
      e = pool[i];
      break;
    }
  }
  if (e === null) return null;
  e.active = true;
  e.kind = kind;
  e.serial = state.nextSerial++;
  e.x = x;
  e.w = kindW(kind);
  e.h = kindH(kind);
  e.vx = 0;
  e.vy = 0;
  e.phase = sv.crng.range(0, Math.PI * 2);
  e.age = 0;
  e.hitT = NEVER;
  e.hue = -1;
  e.rot = 0;
  e.flag = 'none';
  e.stateT = 0;
  e.optional = false;
  e.warnT = 0;
  e.nearMin = 1e9;
  e.nearDone = false;
  e.template = state.debug.template;
  e.lane = false;
  e.hazard = kind === 'bush' || kind === 'mound' || kind === 'hornbill' || kind === 'log';
  e.stompable = kind === 'drum' || kind === 'kiteDrum' || kind === 'hornbill' || kind === 'log';
  switch (kind) {
    case 'kiteDrum':
      e.y = GROUND_Y - DRUM.kiteTop;
      break;
    case 'hornbill':
      e.y = GROUND_Y - HORNBILL.maxAlt;
      e.vx = -HORNBILL.speed;
      break;
    case 'log':
      e.y = GROUND_Y - e.h;
      e.vx = -LOG.speed;
      break;
    case 'pit':
      e.y = GROUND_Y;
      break;
    case 'mango':
    case 'goldenMango':
      e.y = GROUND_Y - 60 - e.h / 2;
      break;
    case 'pickupShield':
    case 'pickupMagnet':
      e.y = GROUND_Y - PICKUP.alt - e.h / 2;
      break;
    case 'bestFlag':
      e.y = GROUND_Y - BEST_FLAG.poleH;
      break;
    default:
      e.y = GROUND_Y - e.h;
      break;
  }
  e.baseY = e.y;
  if (pool === state.mangoes) state.mangoCount++;
  else state.entityCount++;
  return e;
}

/** Free entity slot i (state.entities). */
export function freeEntity(state: GameState, sim: SimCtx, i: number): void {
  const e = state.entities[i];
  if (!e.active) return;
  e.active = false;
  e.flag = 'none';
  sim.warned[i] = 0;
  if (sim.titleDrum === e) sim.titleDrum = null;
  state.entityCount--;
}

/** Free mango slot i (state.mangoes). */
export function freeMango(state: GameState, sim: SimCtx, i: number): void {
  const e = state.mangoes[i];
  if (!e.active) return;
  e.active = false;
  sim.homing[i] = 0;
  state.mangoCount--;
}

/* ------------------------------------------------------------------ */
/* Shared rule helpers                                                 */
/* ------------------------------------------------------------------ */

/** Add hit-stop (real s), max-combined; capped in reduced motion. */
export function addHitStop(state: GameState, s: number): void {
  const v = state.save.reducedMotion && s > HITSTOP.reducedMotionCap ? HITSTOP.reducedMotionCap : s;
  if (v > state.hitStop) state.hitStop = v;
}

/** navigator.vibrate (off in reduced motion and during debug advance()). Never throws. */
export function haptic(state: GameState, sim: SimCtx, ms: number): void {
  if (sim.quiet || state.save.reducedMotion) return;
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch (_e) {
    /* unsupported */
  }
}

/** Set the chain (updates best chain and multiplier). */
export function setChain(state: GameState, chain: number): void {
  const r = state.run;
  r.chain = chain;
  if (chain > r.chainBest) r.chainBest = chain;
  r.multiplier = multiplierFor(chain);
}

/** Add points: base x multiplier (optional) x2 during TOTOTO TIME. Returns the points added. */
export function award(state: GameState, base: number, useMult: boolean): number {
  let p = base;
  if (useMult) p *= state.run.multiplier;
  if (state.fever.active) p *= SCORE.feverMult;
  p = Math.round(p);
  state.run.score += p;
  return p;
}

/**
 * Fill the groove meter (frozen during TOTOTO TIME). Before FEVER.notBefore s of run time the
 * meter stops at 99.9, so no natural fill starts a fever that early (setGroove still can).
 */
export function addGroove(state: GameState, amount: number): void {
  if (state.fever.active) return;
  let g = state.run.groove + amount;
  if (g > GROOVE.max) g = GROOVE.max;
  if (state.run.time < FEVER.notBefore && g > 99.9) g = 99.9;
  state.run.groove = g;
}

/** Bank the chain on touching ground (chain >= 2 scores), then reset it. */
export function bankChain(state: GameState, sv: Services, x: number, y: number): void {
  const r = state.run;
  const c = r.chain;
  if (c >= SCORE.bankMinChain) {
    const mult = r.multiplier;
    const pts = award(state, chainBankValue(c), false);
    sv.fx.popup(x, y - 96, 'CHAIN x' + c + ' +' + pts, MULT_COLORS[mult], 'lg');
    sv.audio.play('chainBank', c);
  }
  if (c !== 0) setChain(state, 0);
}

/** Chain hue colour for a chain value (1-based). */
export function chainColor(chain: number): string {
  const i = chain < 1 ? 0 : (chain - 1) % CHAIN_HUES.length;
  return CHAIN_HUES[i];
}

/** True while `e` is still the live entity spawned with `serial` (pooled slots get reused). */
export function stillLive(e: Entity | null, serial: number): boolean {
  return e !== null && e.active && e.serial === serial && (e.flag === 'none' || e.flag === 'passed');
}

/** Lethal-ish entity still able to hurt (not smashed/stomped). */
export function isLiveHazard(e: Entity): boolean {
  return e.active && e.hazard && e.flag !== 'smashed' && e.flag !== 'stomped';
}

/** Index of the pit whose grounded-test span [x+6, x+w-6] contains footX, or -1. Fever bridges pits. */
export function pitIndexAt(state: GameState, footX: number): number {
  if (state.fever.active) return -1;
  const ents = state.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.active && e.kind === 'pit' && footX > e.x + PIT.lipInset && footX < e.x + e.w - PIT.lipInset) return i;
  }
  return -1;
}

/**
 * Fairness rule 8: remove (poof) every hazard the hero would reach within `seconds` (closing speed
 * for movers) or `minU` u, and pits starting in that span. `keepPit` = entity index to spare (the
 * pit the hero is climbing out of), -1 for none.
 */
export function clearHazardsAhead(
  state: GameState,
  sv: Services,
  sim: SimCtx,
  seconds: number,
  minU: number,
  keepPit: number,
): void {
  const h = state.hero;
  const v = state.run.speed;
  const front = h.x + HERO.hurtW / 2;
  const ents = state.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active) continue;
    if (e.kind === 'pit') {
      if (i === keepPit) continue;
      const reach = Math.max(minU, seconds * v);
      if (e.x + e.w > h.x - 30 && e.x < front + reach) {
        const n = Math.max(2, Math.floor(e.w / 40));
        for (let k = 0; k < n; k++) sv.fx.burst('mud', e.x + ((k + 0.5) * e.w) / n, GROUND_Y + 4, 3);
        sv.fx.burst('poof', e.x + e.w / 2, GROUND_Y, 3);
        freeEntity(state, sim, i);
      }
      continue;
    }
    if (!isLiveHazard(e)) continue;
    if (e.x + e.w < h.x - HERO.hurtW) continue;
    const gap = e.x - front;
    const closing = v - e.vx;
    if (gap <= minU || gap <= seconds * closing) poofHazard(sv, e);
  }
}

/** Remove a hazard with a poof (rule-8 clearing, fever-exit lane cleanup). */
export function poofHazard(sv: Services, e: Entity): void {
  e.flag = 'smashed';
  e.stateT = 0;
  e.vx = 0;
  sv.fx.burst('poof', e.x + e.w / 2, e.y + e.h / 2, 6);
}

/** End the run: death pose, hit-stop, shake, burst, sfx, haptic. game.ts reacts to sim.died. */
export function kill(state: GameState, sv: Services, sim: SimCtx, cause: DeathCause, e: Entity | null): void {
  const h = state.hero;
  if (h.action === 'dead') return;
  state.deathCause = cause;
  h.action = 'dead';
  h.grounded = false;
  h.deathT = 0;
  h.boingQueued = false;
  h.bufferT = 0;
  h.hangT = 0;
  h.cutPending = false;
  h.exprT = 0;
  h.cheekPuff = 0;
  h.flashT = 0;
  sim.deathLanded = false;
  if (cause === 'pit') {
    sim.deathSink = true;
    sim.deathVX = 0;
    h.pose = 'sink';
    h.expr = 'sleep';
    h.vy = 0;
    h.sinkDepth = 0;
    h.y = GROUND_Y + PIT.mudDepth;
    sv.fx.burst('mud', h.x, GROUND_Y + PIT.mudDepth, 14);
  } else {
    sim.deathSink = false;
    sim.deathVX = 70;
    h.pose = 'tumble';
    h.expr = 'dizzy';
    h.vy = -260;
    const cx = h.x + HERO.hurtW / 2;
    const cy = h.y - 30;
    switch (cause) {
      case 'hornbill':
        sv.fx.burst('feather', cx, cy, 10);
        break;
      case 'log':
        sv.fx.burst('chip', cx, cy, 10);
        break;
      case 'mound':
        sv.fx.burst('pebble', cx, cy, 10);
        sv.fx.burst('dust', cx, GROUND_Y, 6);
        break;
      default:
        sv.fx.burst('dust', cx, GROUND_Y, 8);
        sv.fx.burst('seed', cx, cy, 6);
        break;
    }
    sv.fx.burst('star', h.x, h.y - 50, 6);
  }
  if (e !== null) {
    e.hitT = 0;
    if (e.kind === 'log') e.vx = 0;
  }
  state.timeScale = 1;
  addHitStop(state, HITSTOP.death);
  sv.fx.shake(SHAKE.death);
  sv.audio.play('death');
  haptic(state, sim, HAPTIC.death);
  sim.died = true;
}
