/**
 * Procedural course generator (spec §7, §8). Owner: GAMEPLAY.
 *
 * Model
 *  - Chunks are authored in SECONDS. Chunk-relative time t maps to the absolute run time
 *    T = cursorT + t and every element is placed at x = D(T), the closed-form position the hero
 *    WILL have at that run time (world-sim distanceAt). Drum spacings, pit widths and mango arcs use
 *    the speed at that moment and the derived flight times (hero.ts computeHeroTimings), so every
 *    pattern is solvable by construction at every speed.
 *  - Content is generated to the FIXED horizon hero.x + GEN.aheadU (view-independent, so the course
 *    is identical on every screen); nothing spawns on screen.
 *  - Only sv.rng (course stream) is consumed here; cosmetic bob phases are derived from x.
 *  - Every run starts with the same structure (seeded fillers vary): opening (0–4.9 s, hazard-free:
 *    hop arc at 1.2 s, drum at 2.6 s) then the lesson chunk: first bush ~5.5 s (TAP prompt +
 *    teaching freeze on a first-ever run), drum pair ~9 s (SLAM prompt), golden mango on the BOING
 *    line ~14 s. Returning players (save.tutorialSeen, read once at reset) skip the BOING line and
 *    the filler after the drum pair: normal fill starts ~3.5 s earlier. The course is a pure
 *    function of seed + that flag, so same seed + same save + same inputs = same run.
 *  - Selection: forced breather (every 4 hazard chunks — chunks with a hazard type; 5 after 500 m —
 *    and once right after TOTOTO TIME)
 *    -> forced solo intro for a newly unlocked hazard type -> tier by distance weights -> weighted
 *    pick among eligible templates excluding the last 2 ids -> variants (bush<->mound swap, +/-6%
 *    jitter on optional drums, optional golden mango) -> rest gap.
 *  - Fairness rules §8.2 are asserted in dev builds (console.warn) from per-chunk records.
 */
import {
  DIFFICULTY,
  DRUM,
  GEN,
  GOLDEN,
  GROUND_Y,
  HORNBILL,
  INTRO_TEMPLATE,
  LOG,
  MANGO,
  OPENING,
  PHYS,
  PIT,
  POWERUP,
  TEMPLATE_TIERS,
  TEMPLATE_WEIGHT,
  TIER_KEYS,
  UNLOCK_M,
  U_PER_M,
} from './config';
import type { DeathCause, Entity, EntityKind, GameState, Services, TemplateId } from './types';
import { clamp, lerp, speedAt } from './state';
import { insetWFracFor } from './geom';
import type { SimCtx } from './world-sim';
import { distanceAt, kindW, spawnEntity } from './world-sim';
import type { ArcKind } from './hero';
import { BODY_OFFSET, flightCross, simArc, trajAt } from './hero';

export interface CourseGen {
  /** New run: opening + lesson, then fill to the horizon. */
  reset(): void;
  /** Keep content generated to hero.x + GEN.aheadU. */
  fill(): void;
}

/** Absolute run time at which the lesson chunk starts (just before the 5 s hazard-free mark). */
export const LESSON_START = OPENING.safeUntil - 0.1;

const HB_BUSH = 1;
const HB_MOUND = 2;
const HB_HORN = 4;
const HB_PIT = 8;
const HB_LOG = 16;

const CAUSES: ReadonlyArray<DeathCause> = ['bush', 'mound', 'hornbill', 'pit', 'log'];

function causeBit(c: DeathCause): number {
  switch (c) {
    case 'bush':
      return HB_BUSH;
    case 'mound':
      return HB_MOUND;
    case 'hornbill':
      return HB_HORN;
    case 'pit':
      return HB_PIT;
    default:
      return HB_LOG;
  }
}

/** Hazard types used by each template (eligibility: all must be introduced). */
const TPL_HAZ: { [id: string]: number } = {
  bush: HB_BUSH,
  bush2: HB_BUSH,
  drumHello: 0,
  drumPair: 0,
  bushDrum: HB_BUSH,
  melonSlam: 0,
  mound: HB_MOUND,
  moundBush: HB_MOUND | HB_BUSH,
  hornbillLow: HB_HORN,
  hornbillStep: HB_HORN,
  pit: HB_PIT,
  pitDrum: HB_PIT,
  drumLine3: 0,
  log: HB_LOG,
  bushHornbill: HB_BUSH | HB_HORN,
  pitMound: HB_PIT | HB_MOUND,
  logDrums: HB_LOG,
  drumBridge: HB_PIT | HB_MOUND,
  alleyDrums: 0,
  alleyMelons: 0,
  alleyKite: 0,
  alleyPickup: 0,
};

function tierOf(id: TemplateId): number {
  const t2 = TEMPLATE_TIERS.t2;
  for (let i = 0; i < t2.length; i++) if (t2[i] === id) return 2;
  const t3 = TEMPLATE_TIERS.t3;
  for (let i = 0; i < t3.length; i++) if (t3[i] === id) return 3;
  return 1;
}

function isBreather(id: TemplateId): boolean {
  return id === 'alleyDrums' || id === 'alleyMelons' || id === 'alleyKite' || id === 'alleyPickup';
}

function isDevBuild(): boolean {
  try {
    return typeof process !== 'undefined' && !!process.env && process.env.NODE_ENV !== 'production';
  } catch (_e) {
    return false;
  }
}

/** Fairness record ring (dev only; capacity per kind). */
const REC = 48;

export function createGenerator(state: GameState, sv: Services, sim: SimCtx): CourseGen {
  const g = sim.gen;
  const tm = sim.tm;
  const rng = sv.rng;
  const J = tm.tJump;
  const J2 = tm.tJump / 2;
  const BB = tm.tBB;
  const F0 = GEN.arcFrom;
  const F1 = GEN.arcTo;
  const DH = DRUM.h;
  const KT = DRUM.kiteTop;
  const HT = HORNBILL.maxAlt;
  const dev = isDevBuild() || state.debug.overlay;

  /* ---------------- chunk context ---------------- */
  let t0 = 0;
  let tier = 1;
  let curId: TemplateId = 'opening';
  let pickupKind: EntityKind | '' = '';
  let chunkHasLog = false;
  let chunkHasPit = false;
  /** save.tutorialSeen at reset: the lesson chunk skips its BOING line. */
  let returning = false;

  /* ---------------- fairness records (absolute) ---------------- */
  const rqTake: number[] = [];
  const rqLand: number[] = [];
  const rqTier: number[] = [];
  const lx0: number[] = [];
  const lx1: number[] = [];
  const pT0: number[] = [];
  const pT1: number[] = [];
  const pX0: number[] = [];
  const pX1: number[] = [];
  const hornT: number[] = [];
  const exX: number[] = [];
  let newRq = 0;
  let newL = 0;
  let newP = 0;
  let newH = 0;
  let newE = 0;

  function trim(a: number[]): void {
    if (a.length > REC) a.splice(0, a.length - REC);
  }
  function clearRecords(): void {
    rqTake.length = 0;
    rqLand.length = 0;
    rqTier.length = 0;
    lx0.length = 0;
    lx1.length = 0;
    pT0.length = 0;
    pT1.length = 0;
    pX0.length = 0;
    pX1.length = 0;
    hornT.length = 0;
    exX.length = 0;
  }
  function beginRecords(): void {
    if (!dev) return;
    trim(rqTake);
    trim(rqLand);
    trim(rqTier);
    trim(lx0);
    trim(lx1);
    trim(pT0);
    trim(pT1);
    trim(pX0);
    trim(pX1);
    trim(hornT);
    trim(exX);
    newRq = rqTake.length;
    newL = lx0.length;
    newP = pT0.length;
    newH = hornT.length;
    newE = exX.length;
  }
  function recReq(take: number, land: number): void {
    if (!dev) return;
    rqTake.push(take);
    rqLand.push(land);
    rqTier.push(tier);
  }
  function recLethal(a: number, b: number): void {
    if (!dev) return;
    lx0.push(a);
    lx1.push(b);
  }
  function recPit(ta: number, tb: number, xa: number, xb: number): void {
    if (!dev) return;
    pT0.push(ta);
    pT1.push(tb);
    pX0.push(xa);
    pX1.push(xb);
  }

  /* ---------------- placement helpers ---------------- */
  function X(t: number): number {
    return distanceAt(t0 + t);
  }
  function V(t: number): number {
    return speedAt(t0 + t);
  }
  function jit(): number {
    return 1 + rng.range(-GEN.jitter, GEN.jitter);
  }
  function put(kind: EntityKind, t: number): Entity | null {
    return spawnEntity(state, sv, kind, X(t) - kindW(kind) / 2);
  }
  function deterministicPhase(x: number): number {
    const p = (x * 0.021) % (Math.PI * 2);
    return p < 0 ? p + Math.PI * 2 : p;
  }
  /** Mango centred at world (cx, cy). */
  function mangoAt(cx: number, cy: number, hue: number): void {
    const e = spawnEntity(state, sv, 'mango', cx - MANGO.size / 2);
    if (e === null) return;
    e.y = cy - MANGO.size / 2;
    e.baseY = e.y;
    e.hue = hue;
    e.optional = true;
    e.phase = deterministicPhase(cx);
  }
  /** Mango trail along a simulated hero flight launched at chunk time tTake. */
  function arc(kind: ArcKind, tTake: number, startAlt: number, endAlt: number, hue: number, f0: number, f1: number): void {
    const n = simArc(kind, X(tTake), GROUND_Y - startAlt, V(tTake), GROUND_Y - endAlt, sim.arcX, sim.arcY, f0, f1);
    for (let i = 0; i < n; i++) mangoAt(sim.arcX[i], sim.arcY[i] - BODY_OFFSET, hue);
  }
  /** Mangoes on the running line (feet altitude alt) from ta to tb. */
  function line(ta: number, tb: number, alt: number, hue: number): void {
    for (let t = ta; t <= tb + 1e-6; t += GEN.arcStep) mangoAt(X(t), GROUND_Y - alt - BODY_OFFSET, hue);
  }
  /**
   * Slam started at chunk time ts from feet altitude a0: 0.05 s hang, then +1500 down to endAlt.
   * Lays `count` mangoes on the dive. Returns the impact chunk time.
   */
  function column(ts: number, a0: number, endAlt: number, count: number): number {
    const dive = (a0 - endAlt) / PHYS.slamVy;
    for (let k = 0; k < count; k++) {
      const f = (k + 1) / (count + 1);
      const tk = ts + PHYS.slamHang + dive * f;
      mangoAt(X(tk), GROUND_Y - (a0 - (a0 - endAlt) * f) - BODY_OFFSET, -1);
    }
    return ts + PHYS.slamHang + dive;
  }
  function goldenAt(cx: number, centreAlt: number): Entity | null {
    const a = clamp(centreAlt, GOLDEN.minAlt, GOLDEN.maxAlt);
    const e = spawnEntity(state, sv, 'goldenMango', cx - GOLDEN.size / 2);
    if (e === null) return null;
    e.y = GROUND_Y - a - GOLDEN.size / 2;
    e.baseY = e.y;
    e.optional = true;
    e.phase = deterministicPhase(cx);
    return e;
  }
  /** Golden where a flight launched at chunk time t (vy0 from feet alt a0) passes body altitude target. */
  function goldenOnFlight(vy0: number, t: number, a0: number, target: number, rising: boolean): Entity | null {
    const tc = flightCross(vy0, a0, target - BODY_OFFSET, rising);
    if (tc < 0) return null;
    return goldenAt(X(t + tc), target);
  }
  /** Golden at the apex of a flight launched at chunk time t from feet alt a0. */
  function goldenAtApex(tApex: number, apexAlt: number, t: number, a0: number): Entity | null {
    return goldenAt(X(t + tApex), Math.min(GOLDEN.maxAlt, a0 + apexAlt + BODY_OFFSET - 8));
  }
  /** About one golden per ~20 s on eligible lines (p = 0.3, guaranteed after 22 s, never < 9 s apart). */
  function wantGolden(): boolean {
    const since = t0 - g.lastGoldenT;
    if (since < 9) return false;
    if (since >= 22 || rng.chance(GEN.goldenChance)) {
      g.lastGoldenT = t0;
      return true;
    }
    return false;
  }
  function exit(t: number): void {
    if (dev) exX.push(X(t));
  }

  function hitHalf(kind: EntityKind): number {
    return (kindW(kind) * (1 - insetWFracFor(kind))) / 2;
  }

  /** Static ground hazard centred at t with its canonical (centred, full) required jump. */
  function hazard(kind: 'bush' | 'mound', t: number, withArc: boolean): Entity | null {
    const e = put(kind, t);
    g.seen |= kind === 'bush' ? HB_BUSH : HB_MOUND;
    if (withArc) {
      if (kind === 'bush') arc('hop', t - tm.tHop / 2, 0, 0, -1, F0, F1);
      else arc('jump', t - J2, 0, 0, -1, F0, F1);
    }
    recReq(t0 + t - J2, t0 + t + J2);
    const hw = hitHalf(kind);
    recLethal(X(t) - hw, X(t) + hw);
    return e;
  }
  /** Bush, or (variant) a mound once mounds are introduced. */
  function bushOrMound(t: number, swapOK: boolean, withArc: boolean): Entity | null {
    const swap = swapOK && (g.seen & HB_MOUND) !== 0 && rng.chance(0.25);
    return hazard(swap ? 'mound' : 'bush', t, withArc);
  }
  /** Mud pit with its near lip at chunk time ts, width widthS seconds of travel. */
  function pit(ts: number, widthS: number, withArc: boolean): Entity | null {
    const v = V(ts);
    const x0 = X(ts);
    const e = spawnEntity(state, sv, 'pit', x0);
    const w = widthS * v;
    if (e !== null) e.w = w;
    g.seen |= HB_PIT;
    chunkHasPit = true;
    const mid = ts + widthS / 2;
    if (withArc) arc('jump', mid - J2, 0, 0, -1, F0, F1);
    recReq(t0 + mid - J2, t0 + mid + J2);
    recLethal(x0 + PIT.lipInset, x0 + w - PIT.lipInset);
    recPit(t0 + ts, t0 + ts + widthS, x0, x0 + w);
    return e;
  }
  /**
   * Moving hazard that ARRIVES at chunk time tArr where the template intends: spawned at
   * xIntended + relSpeed * (time until arrival) (spec §8.1). Hornbills bob through their rest height
   * exactly at arrival.
   */
  function mover(kind: 'hornbill' | 'log', tArr: number, withArc: boolean): Entity | null {
    const tA = t0 + tArr;
    const xc = distanceAt(tA);
    const w = kindW(kind);
    const rel = kind === 'hornbill' ? HORNBILL.speed : LOG.speed;
    const lead = tA - state.run.time;
    const e = spawnEntity(state, sv, kind, xc - w / 2 + rel * lead);
    if (e !== null && kind === 'hornbill') {
      let ph = (-Math.PI * 2 * HORNBILL.bobHz * lead) % (Math.PI * 2);
      if (ph < 0) ph += Math.PI * 2;
      e.phase = ph;
      e.y = e.baseY + HORNBILL.bobAmp * Math.sin(ph);
    }
    const hw = hitHalf(kind);
    recLethal(xc - hw, xc + hw);
    if (kind === 'log') {
      g.seen |= HB_LOG;
      chunkHasLog = true;
      recReq(tA - J2, tA + J2);
      if (withArc) arc('hop', tArr - tm.tHop / 2, 0, 0, -1, F0, F1);
    } else {
      g.seen |= HB_HORN;
      if (dev) hornT.push(tA);
    }
    return e;
  }
  function drum(t: number): Entity | null {
    const e = put('drum', t);
    if (e !== null) e.optional = true;
    return e;
  }
  function kite(t: number): Entity | null {
    const e = put('kiteDrum', t);
    if (e !== null) e.optional = true;
    return e;
  }
  function melon(t: number): Entity | null {
    const e = put('melon', t);
    if (e !== null) e.optional = true;
    return e;
  }

  /* ---------------- reusable patterns ---------------- */
  /** Jump to the apex, slam straight down onto a melon at chunk time m. Returns the chunk end. */
  function melonSlamAt(m: number, goldenOK: boolean): number {
    melon(m);
    const tj = m - (tm.tApexJump + PHYS.slamHang + tm.apexJump / PHYS.slamVy);
    arc('jump', tj, 0, 0, -1, F0, tm.tApexJump / tm.tJump);
    column(tj + tm.tApexJump, tm.apexJump, 0, 3);
    if (goldenOK && wantGolden()) {
      arc('boing', m, 0, 0, -1, 0.12, 0.42);
      goldenAtApex(tm.tApexBoing, tm.apexBoing, m, 0);
      return m + tm.tApexBoing + 0.35;
    }
    return m + 0.4;
  }
  /** Ground drum at d with the arcs onto it and off it. Returns the exit time. */
  function drumHelloAt(d: number): number {
    drum(d);
    arc('ontoDrum', d - tm.tOn, 0, DH, -1, F0, F1);
    arc('bounce', d, DH, 0, -1, F0, F1);
    exit(d + tm.tOff);
    exit(d + tm.tBoomOff);
    return d + tm.tOff;
  }
  /** Time after a drum bounce at which a slam lands back on drum-top height at `land` s. */
  function slamStartFor(land: number): number {
    let lo = 0;
    let hi = land;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      trajAt(PHYS.drumVy, false, DH, mid, sim.traj);
      const tImpact = mid + PHYS.slamHang + (sim.traj.alt - DH) / PHYS.slamVy;
      if (tImpact < land) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /* ---------------- templates (chunk-relative seconds) ---------------- */
  /** Build template `id` at the current chunk start; returns its duration (s). */
  function build(id: TemplateId): number {
    switch (id) {
      case 'opening': {
        arc('hop', OPENING.mangoArcAt, 0, 0, -1, F0, F1);
        drumHelloAt(OPENING.drumAt);
        return LESSON_START;
      }
      case 'tutorial': {
        // TAP: the first bush (~5.5 s). Teaching-freeze / prompt anchor.
        const b = 0.6;
        const be = hazard('bush', b, true);
        if (be !== null) {
          sim.tutBush = be;
          sim.tutBushSerial = be.serial;
          sim.tutBushX = be.x + be.w / 2;
          sim.tutBushTop = be.y;
          sim.tutBushLeft = be.x + (be.w * insetWFracFor('bush')) / 2;
        }
        // seeded filler (no hazards)
        if (rng.next() < 0.5) melonSlamAt(2.4, false);
        else drumHelloAt(2.4);
        // SLAM: drum pair at ~9 s, mango line shows bounce -> tap -> BOOM onto drum 2.
        const d1 = 9.0 - LESSON_START;
        const d2 = d1 + BB;
        drum(d1);
        drum(d2);
        arc('ontoDrum', d1 - tm.tOn, 0, DH, -1, F0, F1);
        const ts = slamStartFor(BB);
        arc('bounce', d1, DH, DH, -1, F0, Math.min(F1, (ts - 0.04) / BB));
        trajAt(PHYS.drumVy, false, DH, ts, sim.traj);
        column(d1 + ts, sim.traj.alt, DH, 2);
        arc('boom', d2, DH, 0, -1, 0.1, 0.5);
        exit(d2 + tm.tOff);
        exit(d2 + tm.tBoomOff);
        sim.tutSlamX0 = X(d1);
        sim.tutSlamX1 = X(d2);
        // Returning players: no BOING line (and no filler before it). The chunk ends at the BOOM exit
        // landing; with the rest gap the normal fill starts at ~11.4 s (first-ever run: ~16.4 s).
        if (returning) return d2 + tm.tBoomOff;
        // seeded filler
        const fb = 6.6;
        const r = rng.int(0, 2);
        if (r === 0) hazard('bush', fb, true);
        else if (r === 1) {
          melon(fb);
          arc('hop', fb - tm.tHop / 2, 0, 0, -1, F0, F1);
        } else line(fb - 0.24, fb + 0.24, 0, -1);
        // BOING: jump, slam at the apex, tap on landing -> golden at ~14 s.
        const gT = 14.0 - LESSON_START;
        const tb = gT - tm.tApexBoing;
        const tj = tb - (tm.tApexJump + PHYS.slamHang + tm.apexJump / PHYS.slamVy);
        arc('jump', tj, 0, 0, -1, F0, tm.tApexJump / tm.tJump);
        column(tj + tm.tApexJump, tm.apexJump, 0, 3);
        arc('boing', tb, 0, 0, -1, 0.12, 0.42);
        const ge = goldenAtApex(tm.tApexBoing, tm.apexBoing, tb, 0);
        if (ge !== null) {
          sim.tutGold = ge;
          sim.tutGoldSerial = ge.serial;
          sim.tutGoldX = ge.x + ge.w / 2;
          sim.tutGoldY = ge.y + ge.h / 2;
        }
        g.lastGoldenT = t0 + gT;
        return gT + 0.6;
      }
      /* ----- tier 1 ----- */
      case 'bush':
        bushOrMound(0.4, true, true);
        return 0.4 + J2;
      case 'bush2': {
        bushOrMound(0.4, true, true);
        const b2 = 0.4 + J + 0.45;
        bushOrMound(b2, true, true);
        return b2 + J2;
      }
      case 'drumHello':
        return drumHelloAt(0.7);
      case 'drumPair': {
        const d1 = 0.7 * jit();
        const d2 = d1 + BB * jit();
        drum(d1);
        drum(d2);
        arc('ontoDrum', d1 - tm.tOn, 0, DH, -1, F0, F1);
        arc('bounce', d1, DH, DH, -1, F0, F1);
        arc('bounce', d2, DH, 0, -1, F0, F1);
        exit(d2 + tm.tOff);
        exit(d2 + tm.tBoomOff);
        if (wantGolden()) goldenOnFlight(PHYS.boomVy, d2, DH, 255, false);
        return d2 + tm.tBoomOff;
      }
      case 'bushDrum': {
        bushOrMound(0.4, true, false);
        const d = 0.4 + tm.tOn - J2;
        drum(d);
        arc('ontoDrum', 0.4 - J2, 0, DH, -1, F0, F1);
        arc('bounce', d, DH, 0, -1, F0, F1);
        exit(d + tm.tOff);
        exit(d + tm.tBoomOff);
        if (wantGolden()) goldenOnFlight(PHYS.boomVy, d, DH, 255, false);
        return d + tm.tBoomOff;
      }
      case 'melonSlam':
        return melonSlamAt(0.9, true);
      /* ----- tier 2 ----- */
      case 'mound':
        hazard('mound', 0.5, true);
        return 0.5 + J2;
      case 'moundBush': {
        hazard('mound', 0.5, true);
        const b = 0.5 + J + 0.4;
        hazard('bush', b, true);
        return b + J2;
      }
      case 'hornbillLow':
        mover('hornbill', 0.8, false);
        line(0.5, 1.1, 0, -1);
        return 1.4;
      case 'hornbillStep': {
        const d = 0.6;
        drum(d);
        arc('ontoDrum', d - tm.tOn, 0, DH, -1, F0, F1);
        const ta = d + tm.tDrumHorn;
        mover('hornbill', ta, false);
        arc('bounce', d, DH, HT, -1, F0, F1);
        arc('bounce', ta, HT, 0, -1, F0, F1);
        exit(ta + tm.tHornOff);
        return ta + tm.tHornOff;
      }
      case 'pit':
        pit(0.6, 0.28, true);
        return Math.max(0.6 + 0.28 + GEN.pitClearAfterS, 0.6 + 0.14 + J2);
      case 'pitDrum': {
        const d = 0.5;
        drum(d);
        arc('ontoDrum', d - tm.tOn, 0, DH, -1, F0, F1);
        arc('bounce', d, DH, 0, -1, F0, F1);
        exit(d + tm.tOff);
        exit(d + tm.tBoomOff);
        const p0 = Math.max(0.65, d + (DRUM.w / 2 + 10) / V(d));
        pit(p0, 0.36, false);
        if (wantGolden()) goldenOnFlight(PHYS.boomVy, d, DH, 255, false);
        return Math.max(d + tm.tBoomOff, p0 + 0.36 + GEN.pitClearAfterS, p0 + 0.18 + J2);
      }
      case 'drumLine3': {
        const d1 = 0.7;
        const d2 = d1 + BB * jit();
        const d3 = d2 + BB * jit();
        drum(d1);
        drum(d2);
        drum(d3);
        arc('ontoDrum', d1 - tm.tOn, 0, DH, -1, F0, F1);
        arc('bounce', d1, DH, DH, -1, F0, F1);
        arc('bounce', d2, DH, DH, -1, F0, F1);
        const k = d3 + tm.tBoomKite;
        kite(k);
        arc('boom', d3, DH, KT, -1, F0, F1);
        arc('bounce', k, KT, 0, -1, F0, F1);
        exit(d3 + tm.tOff);
        exit(d3 + tm.tBoomOff);
        exit(k + tm.tKiteOff);
        if (wantGolden()) goldenOnFlight(PHYS.drumVy, k, KT, 250, true);
        return k + tm.tKiteOff;
      }
      case 'log':
        mover('log', 0.9, true);
        return 0.9 + J2;
      /* ----- tier 3 ----- */
      case 'bushHornbill': {
        hazard('bush', 0.4, true);
        const ta = 0.4 + J2 + 0.65;
        mover('hornbill', ta, false);
        line(ta - 0.2, ta + 0.2, 0, -1);
        return ta + 0.6;
      }
      case 'pitMound': {
        pit(0.5, 0.3, true);
        const m = 0.5 + 0.3 + J2 + 0.45;
        hazard('mound', m, true);
        return m + J2;
      }
      case 'logDrums': {
        mover('log', 0.8, false);
        const d1 = 0.8 + tm.tOn - J2;
        const d2 = d1 + BB;
        drum(d1);
        drum(d2);
        arc('ontoDrum', 0.8 - J2, 0, DH, -1, F0, F1);
        arc('bounce', d1, DH, DH, -1, F0, F1);
        arc('bounce', d2, DH, 0, -1, F0, F1);
        exit(d2 + tm.tOff);
        exit(d2 + tm.tBoomOff);
        if (wantGolden()) goldenOnFlight(PHYS.boomVy, d2, DH, 255, false);
        return d2 + tm.tBoomOff;
      }
      case 'drumBridge': {
        const d1 = 0.5;
        const d2 = d1 + BB;
        drum(d1);
        const p0 = d1 + (DRUM.w / 2 + 6) / V(d1);
        const room = (X(d2) - DRUM.w / 2 - 6 - X(p0)) / V(p0);
        if (room > 0.12) pit(p0, Math.min(GEN.pitMaxS, room), false);
        drum(d2);
        const k = d2 + tm.tBoomKite;
        kite(k);
        arc('ontoDrum', d1 - tm.tOn, 0, DH, -1, F0, F1);
        arc('bounce', d1, DH, DH, -1, F0, F1);
        arc('boom', d2, DH, KT, -1, F0, F1);
        arc('bounce', k, KT, 0, -1, F0, F1);
        const exN = d2 + tm.tOff;
        const exB = d2 + tm.tBoomOff;
        const exK = k + tm.tKiteOff;
        exit(exN);
        exit(exB);
        exit(exK);
        // Mound after every drum-chain exit landing zone (rule 6) with tier-3 reaction room (rule 3).
        const m = Math.max(exN, exB, exK) + GEN.reqGapS[2] + J2 + 0.05;
        hazard('mound', m, true);
        return m + J2;
      }
      /* ----- breathers ----- */
      case 'alleyDrums': {
        // Six drums: a full chain 6 by plain bounces (x3 milestone at 5).
        const d = 0.4;
        for (let k = 0; k < 6; k++) drum(d + k * BB);
        arc('ontoDrum', d - tm.tOn, 0, DH, 0, F0, F1);
        for (let k = 0; k < 5; k++) arc('bounce', d + k * BB, DH, DH, (k + 1) % 5, F0, F1);
        arc('bounce', d + 5 * BB, DH, 0, 1, F0, F1);
        exit(d + 5 * BB + tm.tOff);
        exit(d + 5 * BB + tm.tBoomOff);
        if (wantGolden()) goldenOnFlight(PHYS.boomVy, d + 5 * BB, DH, 255, false);
        return d + 5 * BB + tm.tOff;
      }
      case 'alleyMelons':
        melonSlamAt(0.6, false);
        melonSlamAt(1.3, false);
        melonSlamAt(2.0, false);
        return 2.4;
      case 'alleyKite': {
        const d1 = 0.5;
        drum(d1);
        const k = d1 + tm.tBounceKite;
        kite(k);
        const d3 = k + tm.tKiteDrum;
        drum(d3);
        arc('ontoDrum', d1 - tm.tOn, 0, DH, -1, F0, F1);
        arc('bounce', d1, DH, KT, -1, F0, F1);
        arc('bounce', k, KT, DH, -1, F0, F1);
        arc('bounce', d3, DH, 0, -1, F0, F1);
        goldenOnFlight(PHYS.drumVy, k, KT, 250, true);
        g.lastGoldenT = t0;
        exit(d3 + tm.tOff);
        exit(d3 + tm.tBoomOff);
        return d3 + tm.tOff;
      }
      case 'alleyPickup': {
        line(0.3, 1.0, 0, -1);
        if (pickupKind !== '') {
          const e = put(pickupKind, 1.5);
          if (e !== null) e.phase = deterministicPhase(e.x);
        } else {
          arc('hop', 1.3, 0, 0, -1, F0, F1);
        }
        line(1.9, 2.2, 0, -1);
        return 2.4;
      }
    }
    return 1;
  }

  /* ---------------- selection ---------------- */
  function weightOf(id: TemplateId): number {
    const w = TEMPLATE_WEIGHT[id];
    return w === undefined ? 1 : w;
  }
  function eligible(id: TemplateId, avoidRecent: boolean): boolean {
    const haz = TPL_HAZ[id];
    if (haz === undefined || (haz & ~g.seen) !== 0) return false;
    if (avoidRecent && (id === g.lastA || id === g.lastB)) return false;
    return true;
  }
  function pickFrom(list: ReadonlyArray<TemplateId>, avoidRecent: boolean): TemplateId | '' {
    let total = 0;
    for (let i = 0; i < list.length; i++) if (eligible(list[i], avoidRecent)) total += weightOf(list[i]);
    if (total <= 0) return '';
    let r = rng.next() * total;
    let last: TemplateId | '' = '';
    for (let i = 0; i < list.length; i++) {
      if (!eligible(list[i], avoidRecent)) continue;
      last = list[i];
      r -= weightOf(list[i]);
      if (r < 0) return list[i];
    }
    return last;
  }
  function pickupOnField(kind: EntityKind): boolean {
    const ents = state.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.active && e.kind === kind && e.flag === 'none') return true;
    }
    return false;
  }
  /** Power-up due in a breather arriving at run time Tc ('' = none). */
  function pickupDue(Tc: number): EntityKind | '' {
    const h = state.hero;
    if (!h.shield && !pickupOnField('pickupShield')) {
      if (!g.shieldDone) {
        if (Tc >= POWERUP.shieldFirstAt) {
          g.shieldDone = true;
          g.lastShieldT = Tc;
          return 'pickupShield';
        }
      } else if (Tc - g.lastShieldT >= POWERUP.shieldEvery) {
        g.lastShieldT = Tc;
        return 'pickupShield';
      }
    }
    if (
      POWERUP.magnetEnabled &&
      Tc >= POWERUP.magnetNotBefore &&
      Tc - g.lastMagnetT >= POWERUP.magnetEvery &&
      h.magnetT <= 0 &&
      !pickupOnField('pickupMagnet')
    ) {
      g.lastMagnetT = Tc;
      return 'pickupMagnet';
    }
    return '';
  }
  function choose(Tc: number): TemplateId {
    pickupKind = '';
    const dM = distanceAt(Tc) / U_PER_M;
    const every = dM >= DIFFICULTY.breatherLateM ? DIFFICULTY.breatherEveryLate : DIFFICULTY.breatherEvery;
    const shieldDue =
      !g.shieldDone &&
      Tc >= POWERUP.shieldFirstAt &&
      (g.hazardChunks >= POWERUP.shieldFirstChunks || Tc >= POWERUP.shieldFirstLateAt);
    if (g.forceBreather || g.hazardChunks >= every || shieldDue) {
      pickupKind = pickupDue(Tc);
      if (pickupKind !== '') return 'alleyPickup';
      const b = pickFrom(TEMPLATE_TIERS.breather, true);
      return b !== '' ? b : 'alleyDrums';
    }
    // A newly unlocked hazard type always debuts in its solo intro template.
    for (let i = 0; i < CAUSES.length; i++) {
      const c = CAUSES[i];
      if (dM >= UNLOCK_M[c] && (g.seen & causeBit(c)) === 0) return INTRO_TEMPLATE[c];
    }
    // Tier by distance weights (linear between keys).
    let w1 = 100;
    let w2 = 0;
    let w3 = 0;
    for (let i = 0; i < TIER_KEYS.length; i++) {
      const k = TIER_KEYS[i];
      if (dM >= k.m) {
        w1 = k.w[0];
        w2 = k.w[1];
        w3 = k.w[2];
        if (i + 1 < TIER_KEYS.length && dM < TIER_KEYS[i + 1].m) {
          const n = TIER_KEYS[i + 1];
          const f = (dM - k.m) / (n.m - k.m);
          w1 = lerp(k.w[0], n.w[0], f);
          w2 = lerp(k.w[1], n.w[1], f);
          w3 = lerp(k.w[2], n.w[2], f);
        }
      }
    }
    const r = rng.next() * (w1 + w2 + w3);
    const list = r < w1 ? TEMPLATE_TIERS.t1 : r < w1 + w2 ? TEMPLATE_TIERS.t2 : TEMPLATE_TIERS.t3;
    let id = pickFrom(list, true);
    if (id === '') id = pickFrom(TEMPLATE_TIERS.t1, true);
    if (id === '') id = pickFrom(TEMPLATE_TIERS.t1, false);
    return id === '' ? 'drumHello' : id;
  }

  function restGap(T: number): number {
    const v = lerp(DIFFICULTY.restGapStart, DIFFICULTY.restGapEnd, clamp(T / DIFFICULTY.restGapRampT, 0, 1));
    return v < DIFFICULTY.restGapFloor ? DIFFICULTY.restGapFloor : v;
  }

  function buildChunk(id: TemplateId, start: number): number {
    t0 = start;
    curId = id;
    tier = tierOf(id);
    chunkHasLog = false;
    chunkHasPit = false;
    state.debug.template = id;
    beginRecords();
    const dur = build(id);
    if (dev) checkChunk();
    g.chunks++;
    g.lastB = g.lastA;
    g.lastA = id;
    return dur;
  }

  /* ---------------- fairness assertions (dev builds) ---------------- */
  function warn(rule: number, msg: string): void {
    try {
      console.warn('[hippo-run] fairness rule ' + rule + ' (' + curId + ' @' + t0.toFixed(2) + 's): ' + msg);
    } catch (_e) {
      /* no console */
    }
  }
  function checkChunk(): void {
    const eps = 1e-3;
    // 3: flat ground between consecutive required jumps (landing -> next takeoff).
    for (let j = newRq; j < rqTake.length; j++) {
      const need = GEN.reqGapS[rqTier[j] - 1];
      for (let i = 0; i < rqTake.length; i++) {
        if (i === j || rqTake[i] > rqTake[j]) continue;
        if (rqTake[j] - rqLand[i] < need - eps) {
          warn(3, 'required jumps ' + (rqTake[j] - rqLand[i]).toFixed(3) + 's apart (need ' + need + ')');
        }
      }
      for (let i = 0; i < newRq; i++) {
        if (rqTake[i] > rqTake[j] && rqTake[i] - rqLand[j] < GEN.reqGapS[rqTier[i] - 1] - eps) {
          warn(3, 'required jump overlaps a later one');
        }
      }
    }
    // 4: pit width, flat ground before (0.5 s) and clear ground after (0.25 s).
    for (let p = newP; p < pT0.length; p++) {
      if (pT1[p] - pT0[p] > GEN.pitMaxS + eps) warn(4, 'pit ' + (pT1[p] - pT0[p]).toFixed(3) + 's wide');
      const before = pX0[p] - GEN.pitFlatBeforeS * speedAt(pT0[p]);
      const after = pX1[p] + GEN.pitClearAfterS * speedAt(pT1[p]);
      for (let i = 0; i < lx0.length; i++) {
        if (lx0[i] >= pX0[p] && lx1[i] <= pX1[p]) continue; // the pit itself
        if (lx1[i] > before && lx0[i] < pX0[p]) warn(4, 'lethal within 0.5 s before a pit');
        if (lx0[i] < after && lx1[i] > pX1[p]) warn(4, 'lethal within 0.25 s after a pit');
      }
    }
    // 5: low hornbill never within 0.6 s of a required jump's arc.
    for (let k = 0; k < hornT.length; k++) {
      for (let i = 0; i < rqTake.length; i++) {
        if (k < newH && i < newRq) continue;
        if (hornT[k] > rqTake[i] - GEN.hornbillJumpClearS + eps && hornT[k] < rqLand[i] + GEN.hornbillJumpClearS - eps) {
          warn(5, 'hornbill within 0.6 s of a required jump');
        }
      }
    }
    // 6: nothing lethal within +/-60 u of a drum-chain exit landing.
    for (let e = 0; e < exX.length; e++) {
      for (let i = 0; i < lx0.length; i++) {
        if (e < newE && i < newL) continue;
        if (lx1[i] > exX[e] - GEN.exitSafeU && lx0[i] < exX[e] + GEN.exitSafeU) warn(6, 'lethal in a drum-chain exit zone');
      }
    }
    // 7: logs never share a template with a pit.
    if (chunkHasLog && chunkHasPit) warn(7, 'log and pit in one template');
  }

  /* ---------------- public ---------------- */
  function fill(): void {
    if (!sim.genEnabled) return;
    const horizon = state.hero.x + GEN.aheadU;
    let guard = 0;
    while (distanceAt(g.cursorT) < horizon && guard < 12) {
      guard++;
      const Tc = g.cursorT;
      const id = choose(Tc);
      const dur = buildChunk(id, Tc);
      if (isBreather(id)) {
        g.hazardChunks = 0;
        g.forceBreather = false;
      } else if (TPL_HAZ[id] !== 0) {
        g.hazardChunks++;
      }
      g.cursorT = Tc + dur + restGap(Tc + dur);
    }
  }

  function reset(): void {
    clearRecords();
    returning = state.save.tutorialSeen;
    if (!sim.genEnabled) return;
    buildChunk('opening', 0);
    const dur = buildChunk('tutorial', LESSON_START);
    g.hazardChunks = 1;
    g.cursorT = LESSON_START + dur + restGap(LESSON_START + dur);
    fill();
  }

  return { reset, fill };
}
