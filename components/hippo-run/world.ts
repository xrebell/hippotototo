/**
 * World: scroll, generator driving, entity motion, collisions and their scoring/fx/audio events,
 * the debug autopilot and the art gallery bench. Owner: GAMEPLAY.
 *
 * Per sim step (game.ts order): stepHero -> stepWorld (scroll, phase, generator to hero.x + 3000,
 * entity motion, warnings, magnet, recycle) -> collideWorld (landings on stompables using the shared
 * landing rule, hazard contact / stomp / smash / shield / death, near-miss tracking, melons,
 * mangoes, power-up bubbles, best flag, pupil target).
 *
 * Landing rule (spec §4): falling (vy > 0), x-ranges overlap (hurtbox width vs the target widened
 * 10 u each side), feet at/above top + 14 on the previous step and at/below top now. Moving
 * stompables additionally accept "feet above the target's vertical centre with vy > 0" on contact.
 *
 * Determinism: only sim data is read (no clocks, no Math.random). The log edge warning and the
 * recycling line are the only view-dependent bits, and neither changes the course.
 */
import {
  CHAIN_HUES,
  DT,
  FX,
  GEN,
  GOLDEN,
  GROOVE,
  GROUND_Y,
  HAPTIC,
  HERO,
  HITSTOP,
  HORNBILL,
  LOG,
  MANGO,
  MELON,
  NEAR_MISS,
  PAL,
  PHASES,
  PHASE_LEN_M,
  PHYS,
  PIT,
  POWERUP,
  SCORE,
  SHAKE,
  UI,
  U_PER_M,
  VIEW,
  AUTOPILOT,
  UI_TEXT,
} from './config';
import type { DeathCause, Entity, EntityKind, GameState, Services } from './types';
import { boxGap, entityHitbox, heroHurtbox, heroPickupBox, overlaps } from './geom';
import { drumPoints, hueIndex, phaseAt, speedAt } from './state';
import type { SimCtx } from './world-sim';
import {
  addGroove,
  addHitStop,
  award,
  chainColor,
  clearHazardsAhead,
  freeEntity,
  freeMango,
  haptic,
  isLiveHazard,
  kill,
  resetSimCtx,
  setChain,
  spawnEntity,
} from './world-sim';
import { BODY_OFFSET, heroPress, launchHero, nextVy } from './hero';
import type { CourseGen } from './world-gen';

export { spawnEntity } from './world-sim';

const TWO_PI = Math.PI * 2;
/** BOOM off a kite drum: slightly softer than -1100 so Toto's head stays on a 16:9 screen. */
const KITE_BOOM_VY = -1000;
/** Recycle line behind the hero: >= GEN.recycleBehindU past the widest view's left edge. */
const RECYCLE_BEHIND = VIEW.maxW * VIEW.heroXFrac + GEN.recycleBehindU;

/* ------------------------------------------------------------------ */
/* Run setup                                                           */
/* ------------------------------------------------------------------ */

/** Called on start/restart after resetRun(): private state, best flag, opening + lesson + fill. */
export function resetWorld(state: GameState, sv: Services, sim: SimCtx, gen: CourseGen): void {
  resetSimCtx(sim);
  state.nextSerial = 1;
  state.entityCount = 0;
  state.mangoCount = 0;
  sim.goalAtStart = state.save.goalIndex;
  sim.flagX = state.save.bestDist > 0 ? state.save.bestDist * U_PER_M : -1;
  gen.reset();
  spawnFlagIfDue(state, sv, sim);
}

function spawnFlagIfDue(state: GameState, sv: Services, sim: SimCtx): void {
  if (sim.flagSpawned || sim.flagX <= 0) return;
  if (state.hero.x + GEN.aheadU < sim.flagX) return;
  sim.flagSpawned = true;
  const e = spawnEntity(state, sv, 'bestFlag', sim.flagX);
  if (e !== null) e.template = '';
}

/**
 * Art test bench: one of every kind spread ahead of the hero (static: vx = 0), mangoes in an arc.
 * Used by game.ts when the URL has ?gallery=1 (generator off, invincible).
 */
export function spawnGallery(state: GameState, sv: Services): void {
  const kinds: EntityKind[] = [
    'drum',
    'kiteDrum',
    'bush',
    'mound',
    'hornbill',
    'pit',
    'log',
    'melon',
    'pickupShield',
    'pickupMagnet',
    'goldenMango',
    'bestFlag',
  ];
  let x = state.hero.x + 420;
  for (let i = 0; i < kinds.length; i++) {
    const e = spawnEntity(state, sv, kinds[i], x);
    if (e) {
      e.vx = 0;
      if (kinds[i] === 'goldenMango') {
        e.y = GROUND_Y - GOLDEN.minAlt - e.h / 2;
        e.baseY = e.y;
      }
    }
    x += (e ? e.w : 60) + 140;
  }
  for (let i = 0; i < 9; i++) {
    const m = spawnEntity(state, sv, 'mango', state.hero.x + 300 + i * 26);
    if (m) {
      const t = i / 8;
      m.y = GROUND_Y - 40 - 110 * 4 * t * (1 - t);
      m.baseY = m.y;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Step: scroll, generator, entity motion                              */
/* ------------------------------------------------------------------ */

export function stepWorld(state: GameState, sv: Services, sim: SimCtx, gen: CourseGen, dt: number): void {
  const r = state.run;
  const h = state.hero;
  const alive = h.action !== 'dead';
  if (alive) {
    r.time += dt;
    r.speed = speedAt(r.time);
    h.x += r.speed * dt;
  }
  state.cam.prevX = state.cam.x;
  state.cam.x = h.x - state.view.heroX;
  r.distance = h.x / U_PER_M;
  phaseAt(r.distance, state.phase);
  const pa = Math.floor(r.distance / PHASE_LEN_M);
  if (pa > sim.phaseAbs) {
    sim.phaseAbs = pa;
    const idx = pa % PHASES.length;
    r.phasesSeen |= 1 << idx;
    state.banner.text = PHASES[idx].name + ' · ' + pa * PHASE_LEN_M + ' m';
    state.banner.t = 0;
    state.banner.dur = UI.bannerDur;
  }
  if (alive) {
    gen.fill();
    spawnFlagIfDue(state, sv, sim);
  }
  stepEntities(state, sv, sim, dt);
  stepMangoes(state, sim, dt);
}

function stepEntities(state: GameState, sv: Services, sim: SimCtx, dt: number): void {
  const ents = state.entities;
  const recycleX = state.hero.x - RECYCLE_BEHIND;
  const speed = state.run.speed;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active) continue;
    e.age += dt;
    e.hitT += dt;
    e.stateT += dt;
    if (e.warnT > 0) e.warnT = Math.max(0, e.warnT - dt);
    switch (e.kind) {
      case 'hornbill':
        if (e.flag === 'none') {
          e.x += e.vx * dt;
          e.y = e.baseY + HORNBILL.bobAmp * Math.sin(TWO_PI * HORNBILL.bobHz * e.age + e.phase);
        } else if (e.flag === 'stomped') {
          e.vy += 1500 * dt;
          e.x += e.vx * 0.35 * dt;
          e.y += e.vy * dt;
          e.rot += 6 * dt;
          if (e.stateT > 1.4) {
            freeEntity(state, sim, i);
            continue;
          }
        } else if (e.stateT > 0.45) {
          freeEntity(state, sim, i);
          continue;
        }
        break;
      case 'log':
        if (e.flag === 'none') {
          e.x += e.vx * dt;
          e.rot += (e.vx / (LOG.d / 2)) * dt;
          if (sim.warned[i] === 0) {
            const right = state.cam.x + state.view.viewW;
            const closing = speed - e.vx;
            if (closing > 0 && (e.x - right) / closing <= LOG.warnLead) {
              sim.warned[i] = 1;
              e.warnT = LOG.warnLead;
              sv.audio.play('logWarn');
            }
          }
        } else if (e.flag === 'stomped') {
          e.vy += 1500 * dt;
          e.x += e.vx * 1.6 * dt;
          e.y += e.vy * dt;
          e.rot += ((e.vx * 1.6) / (LOG.d / 2)) * dt;
          if (e.stateT > 1.4) {
            freeEntity(state, sim, i);
            continue;
          }
        } else if (e.stateT > 0.45) {
          freeEntity(state, sim, i);
          continue;
        }
        break;
      case 'bush':
      case 'mound':
        if (e.flag === 'smashed' && e.stateT > 0.45) {
          freeEntity(state, sim, i);
          continue;
        }
        break;
      case 'pickupShield':
      case 'pickupMagnet':
        if (e.flag === 'popped') {
          if (e.stateT > 0.35) {
            freeEntity(state, sim, i);
            continue;
          }
        } else {
          e.y = e.baseY + 4 * Math.sin(TWO_PI * 0.9 * e.age + e.phase);
        }
        break;
      case 'melon':
        if (e.flag === 'burst' && e.stateT > 0.6) {
          freeEntity(state, sim, i);
          continue;
        }
        break;
      default:
        break;
    }
    if (e.x + e.w < recycleX && e !== sim.titleDrum) freeEntity(state, sim, i);
  }
}

/** Magnet / melon-burst homing: steer toward Toto in his frame (accel 2400, closing 900 u/s). */
function stepMangoes(state: GameState, sim: SimCtx, dt: number): void {
  const h = state.hero;
  const ms = state.mangoes;
  const recycleX = h.x - RECYCLE_BEHIND;
  const hx = h.x;
  const hy = h.y - BODY_OFFSET;
  const hvx = h.action === 'dead' ? 0 : state.run.speed;
  const hvy = h.grounded ? 0 : h.vy;
  const magnet = h.magnetT > 0 && h.action !== 'dead';
  const r2 = POWERUP.magnetRadius * POWERUP.magnetRadius;
  const maxDv = POWERUP.magnetAccel * dt;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (!m.active) continue;
    m.age += dt;
    m.stateT += dt;
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    let mode = sim.homing[i];
    if (mode === 0 && magnet) {
      const dx = hx - cx;
      const dy = hy - cy;
      if (dx * dx + dy * dy <= r2) {
        sim.homing[i] = 1;
        mode = 1;
        m.vx = 0;
        m.vy = 0;
      }
    }
    if (mode === 2) {
      m.vy += 1800 * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.stateT >= 0.22) sim.homing[i] = 1;
    } else if (mode === 1) {
      let ux = m.vx - hvx;
      let uy = m.vy - hvy;
      const rx = cx - hx;
      const ry = cy - hy;
      const d = Math.sqrt(rx * rx + ry * ry) || 1;
      let ax = (-rx / d) * 900 - ux;
      let ay = (-ry / d) * 900 - uy;
      const al = Math.sqrt(ax * ax + ay * ay);
      if (al > maxDv) {
        ax = (ax / al) * maxDv;
        ay = (ay / al) * maxDv;
      }
      ux += ax;
      uy += ay;
      m.vx = ux + hvx;
      m.vy = uy + hvy;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    } else {
      m.y = m.baseY + MANGO.bobAmp * Math.sin(TWO_PI * MANGO.bobHz * m.age + m.phase);
    }
    if (m.x + m.w < recycleX || m.y > GROUND_Y + 300) freeMango(state, sim, i);
  }
}

/* ------------------------------------------------------------------ */
/* Collisions and their events                                         */
/* ------------------------------------------------------------------ */

/** Bounce off a drum / kite drum, or stomp a hornbill / log (BOOM when slamming). */
function bounceOn(state: GameState, sv: Services, sim: SimCtx, e: Entity): void {
  const h = state.hero;
  const r = state.run;
  const slam = h.action === 'slam';
  const isDrum = e.kind === 'drum' || e.kind === 'kiteDrum';
  const vy = slam ? (e.kind === 'kiteDrum' ? KITE_BOOM_VY : PHYS.boomVy) : PHYS.drumVy;
  h.y = e.y;
  h.pitIndex = -1;
  launchHero(state, sim, vy, false);
  h.squashX = slam ? 1.42 : 1.26;
  h.squashY = slam ? 0.62 : 0.76;
  h.squashVX = 0;
  h.squashVY = 0;
  h.expr = 'joy';
  h.exprT = 0.45;
  if (h.whip < (slam ? 1 : 0.6)) h.whip = slam ? 1 : 0.6;
  e.hitT = 0;
  const cx = e.x + e.w / 2;
  setChain(state, r.chain + (slam ? 2 : 1));
  const c = r.chain;
  const hue = hueIndex(c);
  if (isDrum) {
    e.hue = hue;
    const pts = award(state, drumPoints(c), true);
    addGroove(state, slam ? GROOVE.boom : GROOVE.drum);
    r.drums++;
    sv.fx.ring('drum', cx, e.y, hue);
    sv.fx.burst('note', cx, e.y - 6, slam ? 4 : 2, hue);
    if (slam) {
      r.booms++;
      sv.fx.ring('shock', cx, e.y, hue);
      sv.fx.popup(cx, e.y - 72, 'BOOM! +' + pts, CHAIN_HUES[hue], 'lg');
      addHitStop(state, HITSTOP.boom);
      sv.fx.shake(SHAKE.boom);
      sv.audio.play('drumBoom', c);
      haptic(state, sim, HAPTIC.slam);
    } else {
      sv.fx.popup(cx, e.y - 60, '+' + pts, CHAIN_HUES[hue], 'md');
      sv.audio.play('drum', c);
    }
    return;
  }
  const hornbill = e.kind === 'hornbill';
  const pts = award(state, hornbill ? SCORE.hornbill : SCORE.log, true);
  addGroove(state, slam ? GROOVE.boom : GROOVE.stomp);
  r.stomps++;
  if (hornbill) sim.hornbillStomps++;
  e.flag = 'stomped';
  e.stateT = 0;
  e.nearDone = true;
  e.vy = hornbill ? -120 : -240;
  sv.fx.burst(hornbill ? 'feather' : 'chip', cx, e.y + e.h / 2, 12);
  sv.fx.popup(cx, e.y - 64, (slam ? 'BOOM! +' : 'STOMP! +') + pts, chainColor(c), slam ? 'lg' : 'md');
  if (slam) sv.fx.ring('shock', cx, e.y, hue);
  addHitStop(state, slam ? HITSTOP.boom : HITSTOP.stomp);
  sv.fx.shake(SHAKE.stomp);
  sv.audio.play('stomp', c);
}

function smash(state: GameState, sv: Services, e: Entity): void {
  e.flag = 'smashed';
  e.stateT = 0;
  e.vx = 0;
  e.nearDone = true;
  state.run.smashes++;
  state.run.score += SCORE.feverSmash;
  const cx = e.x + e.w / 2;
  sv.fx.burst('poof', cx, e.y + e.h / 2, 8);
  sv.fx.burst('star', cx, e.y, 3);
  sv.fx.popup(cx, e.y - 40, 'SMASH +' + SCORE.feverSmash, CHAIN_HUES[1], 'md');
  addHitStop(state, HITSTOP.smash);
  sv.fx.shake(SHAKE.smash);
  sv.audio.play('smash');
}

function shieldBreak(state: GameState, sv: Services, sim: SimCtx, e: Entity): void {
  const h = state.hero;
  h.shield = false;
  h.invulnT = POWERUP.shieldInvuln;
  h.expr = 'sweat';
  h.exprT = 0.6;
  h.sweatT = 0.6;
  e.flag = 'smashed';
  e.stateT = 0;
  e.vx = 0;
  e.nearDone = true;
  sv.fx.burst('mud', h.x, h.y - 30, 18);
  sv.fx.burst('poof', e.x + e.w / 2, e.y + e.h / 2, 6);
  sv.fx.popup(h.x, h.y - 92, 'MUD COAT!', PAL.logRing, 'md');
  addHitStop(state, HITSTOP.shield);
  sv.fx.shake(SHAKE.shield);
  sv.audio.play('shieldBreak');
  clearHazardsAhead(state, sv, sim, GEN.safeAfterEventS, 0, -1);
}

function nearMiss(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  state.run.nearMisses++;
  const pts = award(state, SCORE.nearMiss, true);
  addGroove(state, GROOVE.nearMiss);
  h.sweatT = NEAR_MISS.sweatDur;
  h.flashT = NEAR_MISS.flashDur;
  h.expr = 'sweat';
  h.exprT = NEAR_MISS.sweatDur;
  sv.fx.popup(h.x, h.y - 92, UI_TEXT.close + ' +' + pts, PAL.uiText, 'md');
  sv.fx.flash('#FFFFFF', 0.18);
  sv.audio.play('nearMiss');
  if (!state.save.reducedMotion) sim.nearSlowT = NEAR_MISS.slowDur;
}

function burstMelon(state: GameState, sv: Services, sim: SimCtx, e: Entity): void {
  e.flag = 'burst';
  e.stateT = 0;
  e.hitT = 0;
  const pts = award(state, SCORE.melonSlam, true);
  addGroove(state, GROOVE.melon);
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  sv.fx.burst('seed', cx, cy, 10);
  sv.fx.burst('juice', cx, cy, 12);
  sv.fx.popup(cx, e.y - 52, '+' + pts, PAL.melonFlesh, 'md');
  sv.audio.play('melon');
  const ms = state.mangoes;
  for (let k = 0; k < MELON.burstMangoes; k++) {
    const m = spawnEntity(state, sv, 'mango', cx - MANGO.size / 2);
    if (m === null) break;
    m.y = cy - MANGO.size / 2;
    m.baseY = m.y;
    m.vx = state.run.speed + (k - 2) * 55;
    m.vy = -430 - Math.abs(k - 2) * 50;
    m.stateT = 0;
    m.hue = k % CHAIN_HUES.length;
    const idx = ms.indexOf(m);
    if (idx >= 0) sim.homing[idx] = 2;
  }
}

function splitMelon(state: GameState, sv: Services, e: Entity): void {
  e.flag = 'split';
  e.stateT = 0;
  e.hitT = 0;
  const pts = award(state, SCORE.melonRun, true);
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  sv.fx.burst('juice', cx, cy, 6);
  sv.fx.burst('seed', cx, cy, 4);
  sv.fx.popup(cx, e.y - 40, '+' + pts, PAL.melonFlesh, 'sm');
  sv.audio.play('melon');
}

function collectMango(state: GameState, sv: Services, m: Entity): void {
  const r = state.run;
  r.mangoStreak = r.mangoStreakT <= FX.mangoStreakWindow ? r.mangoStreak + 1 : 0;
  r.mangoStreakT = 0;
  const cx = m.x + m.w / 2;
  const cy = m.y + m.h / 2;
  if (m.kind === 'goldenMango') {
    r.golden++;
    const pts = award(state, SCORE.golden, true);
    addGroove(state, GROOVE.golden);
    sv.fx.burst('spark', cx, cy, 12);
    sv.fx.burst('star', cx, cy, 4);
    sv.fx.ring('pickup', cx, cy, 1);
    sv.fx.popup(cx, cy - 34, '+' + pts, PAL.golden, 'lg');
    sv.audio.play('golden');
    return;
  }
  r.mangoes++;
  award(state, SCORE.mango, true);
  addGroove(state, GROOVE.mango);
  sv.fx.burst('spark', cx, cy, FX.mangoSparks, m.hue);
  sv.audio.play('mango', r.mangoStreak);
}

function collectPickup(state: GameState, sv: Services, e: Entity): void {
  const h = state.hero;
  e.flag = 'popped';
  e.stateT = 0;
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  sv.fx.ring('pickup', cx, cy, -1);
  if (e.kind === 'pickupShield') {
    if (!h.shield) {
      h.shield = true;
      sv.fx.popup(cx, cy - 40, 'MUD COAT!', PAL.logRing, 'md');
    } else {
      const pts = award(state, SCORE.golden, false);
      sv.fx.popup(cx, cy - 40, '+' + pts, PAL.uiText, 'md');
    }
    sv.fx.burst('mud', h.x, h.y - 30, 10);
    sv.audio.play('shieldGet');
  } else {
    h.magnetT = POWERUP.magnetDur;
    sv.fx.popup(cx, cy - 40, 'FRUIT MAGNET!', PAL.uiAccent, 'md');
    sv.fx.burst('spark', cx, cy, 8);
    sv.audio.play('magnetGet');
  }
}

function passBestFlag(state: GameState, sv: Services, e: Entity): void {
  const r = state.run;
  e.flag = 'passed';
  e.stateT = 0;
  if (r.bestPassed) return;
  r.bestPassed = true;
  r.score += SCORE.bestFlag;
  sv.fx.burst('confetti', e.x, e.y, FX.confetti);
  sv.fx.popup(e.x, e.y - 30, UI_TEXT.record, PAL.golden, 'lg');
  sv.audio.play('bestFlag');
}

/** Collisions, pickups and their events (spec §4–§6, §13). */
export function collideWorld(state: GameState, sv: Services, sim: SimCtx, dt: number): void {
  const h = state.hero;
  state.run.mangoStreakT += dt;
  if (h.action === 'dead' || h.action === 'idle') return;
  const ents = state.entities;
  const half = HERO.hurtW / 2;

  // 1. Landings on stompables (drums, kite drums, hornbills, logs).
  if (h.vy > 0 && !h.grounded) {
    let best = -1;
    let bestTop = 1e9;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.active || !e.stompable || e.flag !== 'none') continue;
      const top = e.y;
      if (h.prevY > top + PHYS.landTolerance || h.y < top) continue;
      if (h.x + half <= e.x - PHYS.landWiden || h.x - half >= e.x + e.w + PHYS.landWiden) continue;
      if (top < bestTop) {
        bestTop = top;
        best = i;
      }
    }
    if (best >= 0) bounceOn(state, sv, sim, ents[best]);
  }

  // 2. Slam shockwave: melons within reach burst.
  if (sim.slamImpact) {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.active || e.kind !== 'melon' || (e.flag !== 'none' && e.flag !== 'split')) continue;
      const dx = e.x + e.w / 2 - sim.slamImpactX;
      if (dx < MELON.shockRadius && dx > -MELON.shockRadius) burstMelon(state, sv, sim, e);
    }
  }

  // 3. Hazards (contact, stomp, smash, shield, death), near misses, pupil target.
  let hurt = heroHurtbox(h, sim.hurt);
  let lookD = 700;
  let lookX = h.x + 300;
  let lookY = GROUND_Y - 30;
  const nx0 = h.x - half - NEAR_MISS.xExtend;
  const nx1 = h.x + half + NEAR_MISS.xExtend;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active) continue;
    if (e.kind === 'pit') {
      const d = e.x + e.w / 2 - h.x;
      if (d > 0 && d < lookD && !state.fever.active) {
        lookD = d;
        lookX = e.x + e.w / 2;
        lookY = GROUND_Y + 8;
      }
      continue;
    }
    if (!isLiveHazard(e)) continue;
    const hb = entityHitbox(e, sim.hit);
    const d = e.x + e.w / 2 - h.x;
    if (d > 0 && d < lookD) {
      lookD = d;
      lookX = e.x + e.w / 2;
      lookY = e.y + e.h / 2;
    }
    if (overlaps(hurt, hb)) {
      e.nearDone = true;
      if (e.stompable && h.vy > 0 && h.y <= e.y + e.h / 2) {
        bounceOn(state, sv, sim, e);
        hurt = heroHurtbox(h, sim.hurt);
        continue;
      }
      if (state.fever.active) {
        smash(state, sv, e);
        continue;
      }
      if (h.invulnT > 0 || state.debug.invincible) continue;
      if (h.shield) {
        shieldBreak(state, sv, sim, e);
        continue;
      }
      kill(state, sv, sim, e.kind as DeathCause, e);
      return;
    }
    if (!e.nearDone) {
      if (hb.x < nx1 && hb.x + hb.w > nx0) {
        const gap = boxGap(hurt, hb);
        if (gap < e.nearMin) e.nearMin = gap;
      } else if (e.nearMin < 1e8 && hb.x + hb.w <= nx0) {
        e.nearDone = true;
        if (!state.fever.active && e.nearMin <= NEAR_MISS.clearance) nearMiss(state, sv, sim);
      }
    }
  }
  h.lookX = lookX;
  h.lookY = lookY;

  // 4. Melons (run through = split, slam dive = burst), bubbles, best flag.
  const pick = heroPickupBox(h, sim.pick);
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.active || e.flag !== 'none') continue;
    switch (e.kind) {
      case 'melon':
        if (overlaps(hurt, entityHitbox(e, sim.hit))) {
          if (h.action === 'slam') burstMelon(state, sv, sim, e);
          else splitMelon(state, sv, e);
        }
        break;
      case 'pickupShield':
      case 'pickupMagnet':
        if (overlaps(pick, entityHitbox(e, sim.hit))) collectPickup(state, sv, e);
        break;
      case 'bestFlag':
        if (h.x >= e.x) passBestFlag(state, sv, e);
        break;
      default:
        break;
    }
  }

  // 5. Mangoes.
  const ms = state.mangoes;
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (!m.active) continue;
    if (overlaps(pick, entityHitbox(m, sim.hit))) {
      collectMango(state, sv, m);
      freeMango(state, sim, i);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Autopilot (spec §14.6): ground jumps only, doubles as fairness test */
/* ------------------------------------------------------------------ */

/** True when a full jump started now would meet a live hornbill (bob padded). */
function hornbillBlocks(state: GameState, sim: SimCtx): boolean {
  const h = state.hero;
  const ents = state.entities;
  const v = state.run.speed;
  let any = false;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.active && e.kind === 'hornbill' && e.flag === 'none' && e.x > h.x - 200 && e.x < h.x + 900) any = true;
  }
  if (!any) return false;
  let vy = PHYS.jumpVy;
  let y = GROUND_Y;
  const steps = Math.ceil(sim.tm.tJump / DT) + 2;
  for (let s = 1; s <= steps; s++) {
    vy = nextVy(vy, DT);
    y += vy * DT;
    if (y > GROUND_Y) y = GROUND_Y;
    if ((s & 1) === 1) continue;
    const t = s * DT;
    const hx0 = h.x + v * t - HERO.hurtW / 2;
    const hx1 = hx0 + HERO.hurtW;
    const hy1 = y - HERO.hurtBottom;
    const hy0 = hy1 - HERO.hurtH;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.active || e.kind !== 'hornbill' || e.flag !== 'none') continue;
      const hb = entityHitbox(e, sim.hit);
      const bx0 = hb.x + e.vx * t;
      const by0 = hb.y - HORNBILL.bobAmp - 2;
      const by1 = hb.y + hb.h + HORNBILL.bobAmp + 2;
      if (hx1 > bx0 && hx0 < bx0 + hb.w && hy1 > by0 && hy0 < by1) return true;
    }
  }
  return false;
}

/**
 * Jump (full hold) when the next ground hazard's leading edge is <= 0.30 s away (closing speed for
 * logs), or at a pit's lip minus 12 u. Never while a hornbill would meet the arc. Ground only.
 */
export function autopilotStep(state: GameState, sv: Services, sim: SimCtx): void {
  const h = state.hero;
  if (h.action === 'dead' || !h.grounded) return;
  const v = state.run.speed;
  const ents = state.entities;
  const front = h.x + HERO.hurtW / 2;
  let need = false;
  for (let i = 0; i < ents.length && !need; i++) {
    const e = ents[i];
    if (!e.active) continue;
    if (e.kind === 'pit') {
      if (!state.fever.active && h.x >= e.x + PIT.lipInset - AUTOPILOT.pitLipU && h.x < e.x + PIT.lipInset) need = true;
      continue;
    }
    if (e.kind !== 'bush' && e.kind !== 'mound' && e.kind !== 'log') continue;
    if (!isLiveHazard(e)) continue;
    const hb = entityHitbox(e, sim.hit);
    if (hb.x + hb.w < h.x - HERO.hurtW / 2) continue;
    const gap = hb.x - front;
    const closing = v - e.vx;
    if (gap / closing <= AUTOPILOT.leadS) need = true;
  }
  if (need && !hornbillBlocks(state, sim)) heroPress(state, sv, sim);
}

