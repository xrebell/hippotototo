/**
 * Hero: one-button action resolver, fixed-step physics, ground/pit resolution, visuals, death
 * animation, title bounce, derived timings and simulated mango arcs. Owner: GAMEPLAY.
 *
 * ACTION resolver (spec §3), in this order for every press consumed at the start of a sim step:
 *   5a. grounded within 0.12 s after a slam hit the ground  -> BOING (vy -1120, never cut)
 *   1.  grounded, or coyote (<= 0.09 s after walking off a lip) -> JUMP (vy -900, variable height)
 *   5b. diving (slam after the hang)                          -> BOING queued, fired on ground impact
 *       (discarded if the slam lands on a drum/stompable: the BOOM bounce happens instead)
 *   -   slam hang (0.05 s)                                     -> ignored
 *   2.  airborne < 0.18 s after takeoff/bounce (0.35 s after a BOING launch) -> ignored (kills
 *       double-tap slams and the slam -> boing mash loop)
 *   3.  falling, time-to-ground <= 0.11 s with ground below    -> BUFFERED JUMP (fires on landing)
 *       "ground below" = no pit at the feet or at the predicted landing x, and no stompable top
 *       between the feet and the ground (falling onto a drum makes it a slam -> BOOM)
 *   4.  otherwise, once per airtime                            -> SLAM (0.05 s hang, then +1500)
 * Release: before the flight's cut time (sim.cutAt) -> cut queued (tap hop ~80 u); after -> vy =
 * max(vy, -420). Only ground/coyote/buffered jumps are cuttable; bounces/boings/rescues never are.
 * Bush-aware hold: sim.cutAt is PHYS.jumpMinHold, unless that tap hop would come down on the next
 * live thorn bush; then it is the first later cut (DT steps, <= PHYS.tapAssistMax) that clears it,
 * so an early quick tap (up to ~0.30 s before contact at start speed) still clears ("any hop
 * clears a bush"). Taps elsewhere and every mound keep the plain physics.
 *
 * Physics: semi-implicit Euler at DT = 1/120, gravity 2600 rising / 3500 falling, terminal 1500.
 * The SAME integrator (nextVy) drives stepHero, computeHeroTimings and simArc, so derived template
 * timings and mango arcs match real play exactly at every speed.
 *
 * Ground (spec §5.3): grounded test = foot-centre x outside every pit's [x+6, x+w-6] (fever bridges
 * pits). In a pit: reaching the mud (26 u down) slamming -> SPLORCH rescue (once per pit), Mud Coat
 * / invulnerability -> geyser, else sink. Crossing the far lip <= 16 u below ground snaps up (ledge
 * forgiveness); deeper -> sink. A rising hero is never snapped.
 */
import {
  DRUM,
  DT,
  FX,
  GEN,
  GROUND_Y,
  HAPTIC,
  HERO,
  HITSTOP,
  HORNBILL,
  JUICE,
  NEVER,
  PHYS,
  PIT,
  POWERUP,
  SCORE,
  SHAKE,
  GROOVE,
  TITLE,
  TOTO_ART,
  CHAIN_HUES,
} from './config';
import type { Box, Entity, GameState, InputEvent, Services } from './types';
import { entityHitbox, makeBox } from './geom';
import { speedAt } from './state';
import type { HeroTimings, SimCtx, Traj } from './world-sim';
import {
  addGroove,
  addHitStop,
  award,
  bankChain,
  clearHazardsAhead,
  haptic,
  kill,
  pitIndexAt,
  setChain,
  spawnEntity,
} from './world-sim';

export type { HeroTimings } from './world-sim';

const TWO_PI = Math.PI * 2;
/** Feet -> hurtbox centre (u). Mangoes are laid on this line. */
export const BODY_OFFSET = HERO.hurtBottom + HERO.hurtH / 2;

/* ------------------------------------------------------------------ */
/* Integrator + derived timings                                        */
/* ------------------------------------------------------------------ */

/** One gravity step (rising 2600, falling 3500, terminal 1500). Shared by every simulation. */
export function nextVy(vy: number, dt: number): number {
  const v = vy + (vy < 0 ? PHYS.gravityUp : PHYS.gravityDown) * dt;
  return v > PHYS.terminalVy ? PHYS.terminalVy : v;
}

/** Arc kinds for simArc (spec §8.4). */
export type ArcKind = 'hop' | 'jump' | 'ontoDrum' | 'bounce' | 'boom' | 'boing';

function launchVy(kind: ArcKind): number {
  switch (kind) {
    case 'bounce':
      return PHYS.drumVy;
    case 'boom':
      return PHYS.boomVy;
    case 'boing':
      return PHYS.boingVy;
    default:
      return PHYS.jumpVy;
  }
}

/**
 * Time (s) for a launch at vy0 from feet altitude startAlt until it falls through endAlt, stepped
 * exactly like stepHero. `cut` = tap hop (release cut at PHYS.jumpMinHold).
 */
export function flightTime(vy0: number, cut: boolean, startAlt: number, endAlt: number): number {
  let alt = startAlt;
  let vy = vy0;
  let airT = 0;
  for (let i = 1; i < 2400; i++) {
    airT += DT;
    if (cut && airT >= PHYS.jumpMinHold && vy < PHYS.jumpCutVy) vy = PHYS.jumpCutVy;
    vy = nextVy(vy, DT);
    alt -= vy * DT;
    if (vy > 0 && alt <= endAlt) return i * DT;
  }
  return 2400 * DT;
}

/** Trajectory state `t` seconds after a launch (stepped). Writes into `out`. */
export function trajAt(vy0: number, cut: boolean, startAlt: number, t: number, out: Traj): Traj {
  let alt = startAlt;
  let vy = vy0;
  let airT = 0;
  const n = Math.round(t / DT);
  for (let i = 0; i < n; i++) {
    airT += DT;
    if (cut && airT >= PHYS.jumpMinHold && vy < PHYS.jumpCutVy) vy = PHYS.jumpCutVy;
    vy = nextVy(vy, DT);
    alt -= vy * DT;
  }
  out.alt = alt;
  out.vy = vy;
  out.t = n * DT;
  return out;
}

/**
 * Time when a launch (vy0 from startAlt) crosses feet altitude `alt` while rising (rising=true) or
 * falling; -1 if it never does.
 */
export function flightCross(vy0: number, startAlt: number, alt: number, rising: boolean): number {
  let a = startAlt;
  let vy = vy0;
  for (let i = 1; i < 2400; i++) {
    vy = nextVy(vy, DT);
    a -= vy * DT;
    if (rising) {
      if (vy < 0 && a >= alt) return i * DT;
      if (vy >= 0) return -1;
    } else if (vy > 0 && a <= alt) {
      return i * DT;
    }
  }
  return -1;
}

function apexOf(vy0: number, out: Traj): Traj {
  let a = 0;
  let vy = vy0;
  let i = 0;
  while (vy < 0 && i < 2400) {
    i++;
    vy = nextVy(vy, DT);
    if (vy < 0) a -= vy * DT;
  }
  out.alt = a;
  out.vy = 0;
  out.t = i * DT;
  return out;
}

/** Derived timings (spec §4 "compute in code, do not hard-code"), stepped with the real integrator. */
export function computeHeroTimings(): HeroTimings {
  const drum = DRUM.h;
  const kite = DRUM.kiteTop;
  const horn = HORNBILL.maxAlt;
  const tr: Traj = { alt: 0, vy: 0, t: 0 };
  apexOf(PHYS.jumpVy, tr);
  const tApexJump = tr.t;
  const apexJump = tr.alt;
  apexOf(PHYS.boingVy, tr);
  return {
    tJump: flightTime(PHYS.jumpVy, false, 0, 0),
    tOn: flightTime(PHYS.jumpVy, false, 0, drum),
    tBB: flightTime(PHYS.drumVy, false, drum, drum),
    tBoom: flightTime(PHYS.boomVy, false, drum, drum),
    tOff: flightTime(PHYS.drumVy, false, drum, 0),
    tHop: flightTime(PHYS.jumpVy, true, 0, 0),
    tBoomOff: flightTime(PHYS.boomVy, false, drum, 0),
    tBounceKite: flightTime(PHYS.drumVy, false, drum, kite),
    tBoomKite: flightTime(PHYS.boomVy, false, drum, kite),
    tKiteOff: flightTime(PHYS.drumVy, false, kite, 0),
    tKiteDrum: flightTime(PHYS.drumVy, false, kite, drum),
    tDrumHorn: flightTime(PHYS.drumVy, false, drum, horn),
    tHornOff: flightTime(PHYS.drumVy, false, horn, 0),
    tApexJump,
    apexJump,
    tApexBoing: tr.t,
    apexBoing: tr.alt,
  };
}

/**
 * Simulate a real hero trajectory of `kind` from feet (x0, y0) at forward speed v until it falls
 * through endY, and drop samples (feet positions) every ~GEN.arcStep s between fractions f0..f1 of
 * the flight into outX/outY (caller-owned, preallocated). 5–9 samples for a full arc (never closer
 * than 0.06 s). Returns the number written. Allocation-free.
 */
export function simArc(
  kind: ArcKind,
  x0: number,
  y0: number,
  v: number,
  endY: number,
  outX: number[],
  outY: number[],
  f0: number,
  f1: number,
): number {
  const vy0 = launchVy(kind);
  const cut = kind === 'hop';
  const startAlt = GROUND_Y - y0;
  const T = flightTime(vy0, cut, startAlt, GROUND_Y - endY);
  const span = (f1 - f0) * T;
  if (span <= 0) return 0;
  let n = Math.floor(span / GEN.arcStep) + 1;
  if (n < 5 && span >= 0.24) n = 5;
  if (n > 9) n = 9;
  if (n < 2) n = 2;
  if (n > outX.length) n = outX.length;
  const step = span / (n - 1);
  let alt = startAlt;
  let vy = vy0;
  let airT = 0;
  let t = 0;
  let k = 0;
  let nextT = f0 * T;
  for (let i = 0; i < 2400 && k < n; i++) {
    if (t >= nextT - DT * 0.5) {
      outX[k] = x0 + v * t;
      outY[k] = GROUND_Y - alt;
      k++;
      nextT = f0 * T + k * step;
      continue;
    }
    airT += DT;
    if (cut && airT >= PHYS.jumpMinHold && vy < PHYS.jumpCutVy) vy = PHYS.jumpCutVy;
    vy = nextVy(vy, DT);
    alt -= vy * DT;
    t += DT;
  }
  return k;
}

/* ------------------------------------------------------------------ */
/* Action resolver                                                     */
/* ------------------------------------------------------------------ */

/** Time (s) for feet at y falling at vy to reach GROUND_Y (closed form, fall gravity + terminal). */
function timeToGround(y: number, vy: number): number {
  const d = GROUND_Y - y;
  if (d <= 0) return 0;
  const g = PHYS.gravityDown;
  const term = PHYS.terminalVy;
  const v0 = vy > term ? term : vy < 0 ? 0 : vy;
  const t1 = (term - v0) / g;
  const d1 = v0 * t1 + 0.5 * g * t1 * t1;
  if (d1 >= d) return (-v0 + Math.sqrt(v0 * v0 + 2 * g * d)) / g;
  return t1 + (d - d1) / term;
}

/** Smart-buffer test (rule 3): the hero will land on GROUND (not a pit, not a drum) within 0.11 s. */
function groundSoon(state: GameState): boolean {
  const h = state.hero;
  if (h.y > GROUND_Y) return false; // already below the ground line: inside a pit
  const t = timeToGround(h.y, h.vy);
  if (t > PHYS.smartBuffer) return false;
  if (pitIndexAt(state, h.x) >= 0) return false;
  if (pitIndexAt(state, h.x + state.run.speed * t) >= 0) return false;
  // A stompable top between the feet and the ground: the hero lands on THAT -> slam (BOOM) instead.
  const half = HERO.hurtW / 2 + PHYS.landWiden;
  const ents = state.entities;
  const reach = state.run.speed * t;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active || !e.stompable || e.flag !== 'none') continue;
    if (e.y < h.y - 1 || e.y > GROUND_Y) continue;
    const ex0 = e.x + (e.vx < 0 ? e.vx * t : 0);
    if (h.x + half + reach > ex0 && h.x - half < e.x + e.w) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Bush-aware minimum hold                                             */
/* ------------------------------------------------------------------ */

/** Only bushes whose hitbox starts within this much travel time of the hurtbox front are checked. */
const ASSIST_REACH_S = 0.5;
/** Prediction margin (u) added around the bush hitbox: the chosen hop clears with room to spare. */
const ASSIST_PAD = 1;
/** Scratch hitbox for the prediction (carries nothing between calls). */
const assistBox: Box = makeBox();

/**
 * Would a ground jump launched now, released early (cut on the first step whose rise time reaches
 * cutAt), overlap hitbox `hb` (grown by `pad`) before the hurtbox has passed it? Steps exactly like
 * stepHero -> stepWorld -> collideWorld: same integrator, same speed curve, same overlap rule.
 */
function hopHits(state: GameState, cutAt: number, hb: Box, pad: number): boolean {
  const h = state.hero;
  const half = HERO.hurtW / 2;
  const x0 = hb.x - pad;
  const x1 = hb.x + hb.w + pad;
  const top = hb.y - pad;
  let alt = GROUND_Y - h.y;
  let vy = PHYS.jumpVy;
  let airT = 0;
  let cut = false;
  let x = h.x;
  let t = state.run.time;
  for (let i = 0; i < 360; i++) {
    airT += DT;
    if (!cut && airT >= cutAt) {
      cut = true;
      if (vy < PHYS.jumpCutVy) vy = PHYS.jumpCutVy;
    }
    if (alt > 0 || vy < 0) {
      vy = nextVy(vy, DT);
      alt -= vy * DT;
      if (alt <= 0 && vy > 0) {
        alt = 0; // landed short: runs on along the ground
        vy = 0;
      }
    }
    t += DT;
    x += speedAt(t) * DT;
    if (x - half >= x1) return false;
    if (x + half > x0 && GROUND_Y - alt - HERO.hurtBottom > top) return true;
  }
  return false;
}

/**
 * Cut time for a ground jump launched now (see header): PHYS.jumpMinHold, or the shortest longer
 * hold (<= PHYS.tapAssistMax) that clears the next live thorn bush when the plain tap hop would not.
 * If no hold in range clears it, the plain tap hop is kept. Sim state only; runs at press time.
 */
function bushAwareCutAt(state: GameState): number {
  const def = PHYS.jumpMinHold;
  if (state.fever.active) return def;
  const h = state.hero;
  const back = h.x - HERO.hurtW / 2;
  const reach = h.x + HERO.hurtW / 2 + state.run.speed * ASSIST_REACH_S;
  const ents = state.entities;
  let bush: Entity | null = null;
  let bushX = 1e12;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active || e.kind !== 'bush' || e.flag !== 'none') continue;
    entityHitbox(e, assistBox);
    if (assistBox.x + assistBox.w <= back || assistBox.x >= reach || assistBox.x >= bushX) continue;
    bush = e;
    bushX = assistBox.x;
  }
  if (bush === null) return def;
  entityHitbox(bush, assistBox);
  if (!hopHits(state, def, assistBox, ASSIST_PAD)) return def;
  for (let k = 1; k < 64; k++) {
    const c = def + k * DT;
    if (c > PHYS.tapAssistMax + 1e-9) break;
    if (!hopHits(state, c, assistBox, ASSIST_PAD)) return c;
  }
  return def;
}

/** Common launch bookkeeping (jump, boing, bounce, rescue). */
export function launchHero(state: GameState, sim: SimCtx, vy: number, cuttable: boolean): void {
  const h = state.hero;
  h.vy = vy;
  h.grounded = false;
  h.action = 'air';
  h.airT = 0;
  h.coyoteT = NEVER;
  h.slamUsed = false;
  h.hangT = 0;
  h.bufferT = 0;
  h.postSlamT = NEVER;
  h.boingQueued = false;
  h.cutPending = false;
  sim.cuttable = cuttable;
  sim.cutAt = PHYS.jumpMinHold;
  sim.boingLaunch = false;
}

function doJump(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  launchHero(state, sim, PHYS.jumpVy, true);
  sim.cutAt = bushAwareCutAt(state);
  sim.jumped = true;
  // A press already released (buffered tap) still gives the tap hop.
  h.cutPending = !h.held;
  h.squashX = JUICE.takeoffX;
  h.squashY = JUICE.takeoffY;
  h.squashVX = 0;
  h.squashVY = 0;
  h.expr = 'o';
  h.exprT = 0.3;
  if (h.whip < 0.45) h.whip = 0.45;
  sv.fx.burst('dust', h.x - 8, GROUND_Y, 5);
  sv.audio.play('jump');
}

function doBoing(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  launchHero(state, sim, PHYS.boingVy, false);
  sim.boingLaunch = true;
  if (h.y > GROUND_Y) h.y = GROUND_Y;
  h.squashX = JUICE.boingX;
  h.squashY = JUICE.boingY;
  h.squashVX = 0;
  h.squashVY = 0;
  h.expr = 'joy';
  h.exprT = 0.7;
  h.whip = 1;
  bankChain(state, sv, h.x, h.y); // boing takeoff touches ground (already banked by the impact)
  state.run.boings++;
  const pts = award(state, SCORE.boing, true);
  addGroove(state, GROOVE.boing);
  sv.fx.ring('boing', h.x, GROUND_Y, -1);
  sv.fx.burst('star', h.x, GROUND_Y - 12, 5);
  sv.fx.popup(h.x, h.y - 84, 'BOING! +' + pts, CHAIN_HUES[4], 'md');
  sv.audio.play('boing');
}

function startSlam(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  h.action = 'slamHang';
  h.hangT = PHYS.slamHang;
  h.vy = 0;
  h.slamUsed = true;
  h.bufferT = 0;
  h.cutPending = false;
  h.boingQueued = false;
  sim.cuttable = false;
  h.expr = 'squint';
  h.exprT = 0;
  h.cheekPuff = 1;
  h.whip = 1;
  h.squashX = 1.14;
  h.squashY = 0.88;
  h.squashVX = 0;
  h.squashVY = 0;
  sv.audio.play('slamStart');
}

/** ACTION press (spec §3 resolver). */
export function heroPress(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  h.held = true;
  h.holdT = 0;
  sim.pressed = true;
  if (h.action === 'dead' || h.action === 'idle') return;
  if (h.grounded && h.postSlamT <= PHYS.boingWindow) {
    doBoing(state, sv, sim);
    return;
  }
  if (h.grounded || h.coyoteT <= PHYS.coyote) {
    doJump(state, sv, sim);
    return;
  }
  if (h.action === 'slam') {
    h.boingQueued = true;
    return;
  }
  if (h.action === 'slamHang') return;
  if (h.airT < (sim.boingLaunch ? PHYS.slamLockoutAfterBoing : PHYS.slamLockout)) return;
  if (h.vy > 0 && groundSoon(state)) {
    h.bufferT = PHYS.jumpBuffer;
    return;
  }
  if (!h.slamUsed) {
    startSlam(state, sv, sim);
    return;
  }
  h.bufferT = PHYS.jumpBuffer;
}

/** ACTION release (variable jump height). */
export function heroRelease(state: GameState, sim: SimCtx): void {
  const h = state.hero;
  h.held = false;
  if (!sim.cuttable || h.action !== 'air' || h.vy >= 0) return;
  if (h.airT < sim.cutAt) {
    h.cutPending = true;
    return;
  }
  if (h.vy < PHYS.jumpCutVy) h.vy = PHYS.jumpCutVy;
  sim.cuttable = false;
}

/** Explicit SLAM key (ArrowDown / S): air only, once per airtime; lockout only after a BOING. */
export function heroSlamKey(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  if (h.grounded || h.action !== 'air' || h.slamUsed) return;
  if (sim.boingLaunch && h.airT < PHYS.slamLockoutAfterBoing) return;
  startSlam(state, sv, sim);
}

/** Route one pooled input record (actionDown / actionUp / slam). */
export function heroOnInput(state: GameState, sv: Services, sim: SimCtx, ev: InputEvent): void {
  switch (ev.kind) {
    case 'actionDown':
      heroPress(state, sv, sim);
      break;
    case 'actionUp':
      heroRelease(state, sim);
      break;
    case 'slam':
      heroSlamKey(state, sv, sim);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Ground, pits, landing                                               */
/* ------------------------------------------------------------------ */

function landOnGround(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  const vy = h.vy;
  const wasSlam = h.action === 'slam';
  h.y = GROUND_Y;
  h.vy = 0;
  h.grounded = true;
  h.action = 'run';
  h.coyoteT = 0;
  h.airT = 0;
  h.hangT = 0;
  h.slamUsed = false;
  h.pitIndex = -1;
  h.cutPending = false;
  sim.cuttable = false;
  bankChain(state, sv, h.x, GROUND_Y);
  if (wasSlam) {
    h.squashX = JUICE.slamImpactX;
    h.squashY = JUICE.slamImpactY;
    h.squashVX = 0;
    h.squashVY = 0;
    h.rot = 0;
    h.postSlamT = 0;
    sim.slamImpact = true;
    sim.slamImpactX = h.x;
    sv.fx.ring('shock', h.x, GROUND_Y, -1);
    sv.fx.burst('pebble', h.x, GROUND_Y, FX.shockParticles);
    sv.fx.burst('dust', h.x, GROUND_Y, 6);
    sv.fx.shake(SHAKE.slam);
    addHitStop(state, HITSTOP.slam);
    sv.audio.play('slamImpact');
    haptic(state, sim, HAPTIC.slam);
    const queued = h.boingQueued;
    h.boingQueued = false;
    h.bufferT = 0;
    if (queued) doBoing(state, sv, sim);
    return;
  }
  h.boingQueued = false;
  h.postSlamT = NEVER;
  sim.hopLandT = 0;
  creditPitsCleared(state);
  let k = vy / JUICE.landDiv;
  if (k > JUICE.landMax) k = JUICE.landMax;
  if (k < 0) k = 0;
  h.squashX = 1 + k;
  h.squashY = 1 - k * 0.75;
  h.squashVX = 0;
  h.squashVY = 0;
  sv.fx.burst('dust', h.x, GROUND_Y, vy > 700 ? 6 : 3);
  if (vy > 600) sv.audio.play('land', vy);
  if (h.bufferT > 0) {
    h.bufferT = 0;
    doJump(state, sv, sim);
  }
}

/** Groove for every pit the hero just landed beyond (once per pit; not rescued ones, not in fever). */
function creditPitsCleared(state: GameState): void {
  if (state.fever.active) return;
  const x = state.hero.x;
  const ents = state.entities;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active || e.kind !== 'pit' || e.nearDone || e.flag === 'rescued') continue;
    if (e.x + e.w - PIT.lipInset > x) continue;
    e.nearDone = true;
    addGroove(state, GROOVE.hazardClear);
  }
}

/** Feet reached the mud (or are stuck below a lip): rescue, geyser or sink. */
function mudContact(state: GameState, sv: Services, sim: SimCtx, pitIdx: number): void {
  const h = state.hero;
  const pit = pitIdx >= 0 ? state.entities[pitIdx] : null;
  const pitOk = pit !== null && pit.active && pit.kind === 'pit';
  const mudY = GROUND_Y + PIT.mudDepth;
  if (pit !== null && pitOk && h.action === 'slam' && pit.flag !== 'rescued') {
    // SPLORCH: once per pit, ends the chain without points.
    pit.flag = 'rescued';
    pit.stateT = 0;
    pit.hitT = 0;
    h.y = mudY;
    launchHero(state, sim, PHYS.mudRescueVy, false);
    setChain(state, 0);
    h.squashX = 0.74;
    h.squashY = 1.3;
    h.squashVX = 0;
    h.squashVY = 0;
    h.expr = 'joy';
    h.exprT = 0.5;
    h.whip = 1;
    h.rot = 0;
    sv.fx.burst('mud', h.x, mudY, 16);
    sv.fx.ring('shock', h.x, GROUND_Y, -1);
    sv.fx.popup(h.x, GROUND_Y - 70, 'SPLORCH!', '#C4A3FF', 'md');
    sv.audio.play('splorch');
    clearHazardsAhead(state, sv, sim, GEN.safeAfterEventS, 0, pitIdx);
    return;
  }
  const free = h.invulnT > 0 || state.debug.invincible || state.fever.active;
  if (free || h.shield) {
    if (!free) {
      h.shield = false;
      h.invulnT = POWERUP.shieldInvuln;
      addHitStop(state, HITSTOP.shield);
      sv.fx.shake(SHAKE.shield);
      sv.audio.play('shieldBreak');
      sv.fx.popup(h.x, GROUND_Y - 80, 'MUD COAT!', '#C08457', 'md');
    }
    if (pit !== null && pitOk) {
      pit.flag = 'rescued';
      pit.stateT = 0;
    }
    h.y = mudY;
    // The geyser touches mud: the chain ends like a SPLORCH (kept in fever: pits are drum skins).
    if (!state.fever.active) bankChain(state, sv, h.x, GROUND_Y);
    launchHero(state, sim, PHYS.shieldGeyserVy, false);
    h.squashX = 0.72;
    h.squashY = 1.32;
    h.squashVX = 0;
    h.squashVY = 0;
    h.rot = 0;
    sv.fx.burst('mud', h.x, mudY, 22);
    clearHazardsAhead(state, sv, sim, GEN.safeAfterEventS, 0, pitIdx);
    return;
  }
  kill(state, sv, sim, 'pit', null);
}

/** After integration: ground landing, pit falls, mud, ledge forgiveness. */
function resolveGround(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  if (h.y < GROUND_Y) {
    if (h.pitIndex >= 0) h.pitIndex = -1;
    return;
  }
  const pit = pitIndexAt(state, h.x);
  if (pit >= 0) {
    h.pitIndex = pit;
    if (h.y >= GROUND_Y + PIT.mudDepth) mudContact(state, sv, sim, pit);
    return;
  }
  // Over solid ground, at or below its surface.
  if (h.vy < 0) return; // rising out of a pit past its lip: never snap a rising hero
  if (h.y - GROUND_Y <= PIT.ledgeSnap) landOnGround(state, sv, sim);
  else mudContact(state, sv, sim, h.pitIndex);
}

/* ------------------------------------------------------------------ */
/* Step                                                                */
/* ------------------------------------------------------------------ */

function springSquash(state: GameState, dt: number): void {
  const h = state.hero;
  const k = JUICE.squashK;
  const d = JUICE.squashDamp;
  h.squashVX += (-k * (h.squashX - 1) - d * h.squashVX) * dt;
  h.squashX += h.squashVX * dt;
  h.squashVY += (-k * (h.squashY - 1) - d * h.squashVY) * dt;
  h.squashY += h.squashVY * dt;
}

function heroVisuals(state: GameState, sv: Services, sim: SimCtx, dt: number): void {
  const h = state.hero;
  springSquash(state, dt);
  switch (h.action) {
    case 'run':
      h.pose = 'run';
      break;
    case 'slamHang':
      h.pose = 'slamHang';
      break;
    case 'slam':
      h.pose = 'slam';
      break;
    default:
      h.pose = 'air';
      break;
  }
  if (h.exprT > 0) h.exprT -= dt;
  if (h.exprT <= 0) {
    h.exprT = 0;
    if (state.fever.active) h.expr = 'star';
    else if (h.action === 'slam' || h.action === 'slamHang') h.expr = 'squint';
    else if (h.action === 'air') h.expr = 'o';
    else h.expr = 'serious';
  }
  let rotT = 0;
  if (h.action === 'slam') rotT = 0.22;
  else if (h.action === 'slamHang') rotT = -0.1;
  else if (h.action === 'air') {
    rotT = h.vy * 0.00012;
    if (rotT < -0.12) rotT = -0.12;
    if (rotT > 0.14) rotT = 0.14;
  }
  h.rot += (rotT - h.rot) * Math.min(1, dt * 14);
  if (h.grounded) {
    h.runPhase += state.run.speed * dt * TOTO_ART.legK;
    if (h.runPhase >= TWO_PI) {
      h.runPhase -= TWO_PI;
      sim.footFalls++;
      sv.audio.play('footstep', state.run.speed);
      if (sim.footFalls % FX.dustEvery === 0) sv.fx.burst('dust', h.x - 16, GROUND_Y, 2);
    }
  }
  if (h.action === 'slam' || h.action === 'slamHang') h.cheekPuff = 1;
  else if (h.cheekPuff > 0) h.cheekPuff = Math.max(0, h.cheekPuff - dt * 5);
  if (h.whip > 0) h.whip = Math.max(0, h.whip - dt * 2.5);
  if (h.flashT > 0) h.flashT = Math.max(0, h.flashT - dt);
  if (h.sweatT > 0) h.sweatT = Math.max(0, h.sweatT - dt);
  if (h.invulnT > 0) h.invulnT = Math.max(0, h.invulnT - dt);
  if (h.magnetT > 0) h.magnetT = Math.max(0, h.magnetT - dt);
}

/** Dead hero: tumble -> sit (stars) or sink into the mud. Also used (real dt) on the summary. */
export function stepDeadHero(state: GameState, sv: Services, sim: SimCtx, dt: number): void {
  const h = state.hero;
  h.prevY = h.y;
  h.deathT += dt;
  if (sim.deathSink) {
    h.pose = 'sink';
    h.expr = 'sleep';
    h.y = GROUND_Y + PIT.mudDepth;
    h.vy = 0;
    if (h.sinkDepth < 30) h.sinkDepth = Math.min(30, h.sinkDepth + 26 * dt);
    h.rot += (0 - h.rot) * Math.min(1, dt * 8);
  } else if (!sim.deathLanded) {
    h.pose = 'tumble';
    h.expr = 'dizzy';
    h.x += sim.deathVX * dt;
    sim.deathVX *= Math.max(0, 1 - 3 * dt);
    h.vy = nextVy(h.vy, dt);
    h.y += h.vy * dt;
    h.rot += 11 * dt;
    if (h.y >= GROUND_Y && h.vy > 0) {
      const pit = pitIndexAt(state, h.x);
      if (pit >= 0) {
        if (h.y >= GROUND_Y + PIT.mudDepth) {
          h.y = GROUND_Y + PIT.mudDepth;
          sim.deathSink = true;
          h.sinkDepth = 0;
          sv.fx.burst('mud', h.x, h.y, 10);
        }
      } else {
        h.y = GROUND_Y;
        h.vy = 0;
        sim.deathLanded = true;
        h.pose = 'sit';
        h.squashX = 1.25;
        h.squashY = 0.8;
        h.squashVX = 0;
        h.squashVY = 0;
        sv.fx.burst('dust', h.x, GROUND_Y, 5);
      }
    }
  } else {
    h.pose = 'sit';
    h.expr = 'dizzy';
    h.x += sim.deathVX * dt;
    sim.deathVX *= Math.max(0, 1 - 4 * dt);
    let r = h.rot % TWO_PI;
    if (r > Math.PI) r -= TWO_PI;
    if (r < -Math.PI) r += TWO_PI;
    h.rot = r + (0 - r) * Math.min(1, dt * 10);
  }
  springSquash(state, dt);
  if (h.whip > 0) h.whip = Math.max(0, h.whip - dt * 2.5);
}

/** One fixed sim step for the hero (spec §4). */
export function stepHero(state: GameState, sv: Services, sim: SimCtx, dt: number): void {
  const h = state.hero;
  sim.slamImpact = false;
  if (h.action === 'dead') {
    stepDeadHero(state, sv, sim, dt);
    return;
  }
  h.prevY = h.y;
  if (h.held) h.holdT += dt;
  if (h.bufferT > 0) h.bufferT = Math.max(0, h.bufferT - dt);
  if (h.postSlamT < NEVER) {
    h.postSlamT += dt;
    if (h.postSlamT > 1) h.postSlamT = NEVER;
  }
  if (sim.hopLandT < NEVER) {
    sim.hopLandT += dt;
    if (sim.hopLandT > 1) sim.hopLandT = NEVER;
  }
  if (h.grounded) {
    const pit = pitIndexAt(state, h.x);
    if (pit >= 0) {
      // Walked off a lip: coyote time starts, no lockout (a late press = slam rescue).
      h.grounded = false;
      h.action = 'air';
      h.vy = 0;
      h.coyoteT = 0;
      h.airT = 1;
      h.pitIndex = pit;
      h.slamUsed = false;
      h.postSlamT = NEVER;
      sim.cuttable = false;
    }
  }
  if (!h.grounded) {
    h.airT += dt;
    if (h.coyoteT < NEVER) {
      h.coyoteT += dt;
      if (h.coyoteT > 1) h.coyoteT = NEVER;
    }
    if (h.cutPending && h.airT >= sim.cutAt) {
      h.cutPending = false;
      if (sim.cuttable && h.vy < PHYS.jumpCutVy) h.vy = PHYS.jumpCutVy;
      sim.cuttable = false;
    }
    if (h.action === 'slamHang') {
      h.vy = 0;
      h.hangT -= dt;
      if (h.hangT <= 1e-9) {
        h.hangT = 0;
        h.action = 'slam';
        h.vy = PHYS.slamVy;
      }
    } else if (h.action === 'slam') {
      h.vy = PHYS.slamVy;
    } else {
      h.vy = nextVy(h.vy, dt);
    }
    h.y += h.vy * dt;
    resolveGround(state, sv, sim);
  }
  if (sim.died) {
    springSquash(state, dt);
    return;
  }
  heroVisuals(state, sv, sim, dt);
}

/* ------------------------------------------------------------------ */
/* Title                                                               */
/* ------------------------------------------------------------------ */

/** Seconds of drum-to-drum flight per u/s of launch speed (closed form, rise 2600 / fall 3500). */
const FLIGHT_PER_VY = 1 / PHYS.gravityUp + 1 / Math.sqrt(PHYS.gravityUp * PHYS.gravityDown);

/**
 * Title bounce speed so the next landing falls on the next half beat of the music clock
 * (state.music, cosmetic): Toto drums "to-to-to" in time with the title loop.
 */
function titleBounceVy(state: GameState): number {
  const bpm = state.music.bpm > 30 ? state.music.bpm : 96;
  const half = 30 / bpm;
  let frac = (state.music.beatPhase * 2) % 1;
  if (frac < 0) frac += 1;
  let t = (1 - frac) * half;
  if (t < half * 0.6) t += half;
  let vy = t / FLIGHT_PER_VY;
  const max = -TITLE.bounceVy;
  if (vy > max) vy = max;
  if (vy < 260) vy = 260;
  return -vy;
}

/**
 * Title screen: Toto idle-bounces on a drum that rides along with the drifting camera, landing on
 * the music's half beats. Cosmetic only (real dt, sub-stepped at DT).
 */
export function stepTitleHero(state: GameState, sv: Services, sim: SimCtx, realDt: number): void {
  const h = state.hero;
  h.action = 'idle';
  h.grounded = false;
  h.x = state.cam.x + state.view.heroX;
  const top = GROUND_Y - DRUM.h;
  let d = sim.titleDrum;
  if (d === null || !d.active) {
    d = spawnEntity(state, sv, 'drum', h.x - DRUM.w / 2);
    sim.titleDrum = d;
    if (d !== null) d.template = '';
    h.y = top;
    h.vy = TITLE.bounceVy;
  }
  h.prevY = h.y;
  sim.titleAcc += realDt;
  let guard = 0;
  while (sim.titleAcc >= DT && guard < 16) {
    guard++;
    sim.titleAcc -= DT;
    h.vy = nextVy(h.vy, DT);
    h.y += h.vy * DT;
    if (h.vy > 0 && h.y >= top) {
      h.y = top;
      h.vy = titleBounceVy(state);
      h.squashX = 1.24;
      h.squashY = 0.78;
      h.squashVX = 0;
      h.squashVY = 0;
      h.expr = 'joy';
      h.exprT = 0.32;
      h.whip = 0.5;
      if (d !== null) {
        d.hitT = 0;
        d.hue = (d.hue + 1) % CHAIN_HUES.length;
      }
    }
    if (d !== null) {
      d.age += DT;
      d.hitT += DT;
    }
    springSquash(state, DT);
    if (h.exprT > 0) h.exprT -= DT;
    if (h.exprT <= 0) {
      h.exprT = 0;
      h.expr = h.vy < 0 ? 'o' : 'serious';
    }
    if (h.whip > 0) h.whip = Math.max(0, h.whip - DT * 2.5);
  }
  if (guard >= 16) sim.titleAcc = 0;
  if (d !== null) d.x = h.x - d.w / 2;
  h.pose = 'idle';
  h.rot = 0;
  h.lookX = h.x + 300;
  h.lookY = GROUND_Y - 30;
}
