/**
 * World rendering. Owner: ART engineer.
 *
 * Contract:
 *  - createRenderer(ctx, fx, crng) once per game. draw(state, alpha) once per rAF frame.
 *    READ-ONLY on state (enforced by ReadState typing). Private animation state (bandana verlet,
 *    blinks, sky gradient cache, glow sprites, title drum, wind) lives in this closure; random
 *    cosmetics use rng.ts hash01() (decoration, blinks) so the shared cosmetic stream is untouched.
 *  - Coordinates: logical = world with  screenX = worldX - camX,  screenY = worldY + view.offsetY.
 *    camX = lerp(cam.prevX, cam.x, alpha) + cam.shakeX (shake only on world layers).
 *    Hero screen x = view.heroX (- shake); hero y = lerp(hero.prevY, hero.y, alpha).
 *    Moving entities are extrapolated by e.vx * DT * (alpha - 1) for smoothness.
 *  - Transform: ctx.setTransform(dpr*s, 0, 0, dpr*s, dpr*padX, 0) is the BASE transform. Sky and
 *    soil extend to the full logical view (0..viewW, 0..viewH); pillarbox sides (padX > 0) are
 *    filled with VIEW.pillarColor in device space and everything else is clipped to the view.
 *  - TOTOTO TIME look (driven only by state.fever.active / .t / .introT): the sky gradient blends
 *    toward a per-phase festival sky (FEVER_SKY: dawn/dusk/night 35% toward #FF5A5F top -> #FFB627
 *    horizon; noon 74% toward coral #FF6B3D -> gold #FFC24A, since a light push over bright blue mixes
 *    to lavender), precomputed per phase-blend key at init, easing in over 0.4 s and out over the last
 *    FEVER.warn s, quantised to FEVER_SKY_STEPS and part of the sky cache key (so it is rebuilt only
 *    while that blend or the 64-step phase blend moves); the ground's top stripe brightens 15% on
 *    every beat (not in reduced motion); Toto pops 1.25x -> 1x over 0.3 s at the start (draw only,
 *    not in reduced motion). The fever-smash debris itself is fx.ts (burst bias).
 *  - Layer order (spec §9): sky gradient (cached per 64-step phase blend) -> stars (night) ->
 *    sun/moon (arc = 0.02 scroll) -> clouds -> distant kites -> far mesas (0.10) -> hills (0.25) ->
 *    acacias/rocks (0.50) -> ground -> pits -> dusk tint -> shadows -> best flag -> gameplay
 *    entities -> mangoes -> Toto -> fx.drawWorld(ctx) (world transform applied) -> foreground tufts
 *    (1.3, 60% alpha) -> fireflies (night) -> log "!" bubbles -> fx.drawScreen(ctx) -> debug overlay.
 *  - No shadowBlur, no getImageData, no per-frame gradients except via the cache, no allocation
 *    per frame (strings for the debug overlay are rebuilt only when their value changes).
 *  - Leaves ctx in the base transform, globalAlpha 1, 'source-over' for ui.draw.
 */
import { DRUM, FEVER, GROUND_Y, HERO, PAL, PIT, VIEW } from './config';
import type { FxApi, ReadState, Renderer, Rng, ViewMetrics } from './types';
import { entityHitbox, heroHurtboxAt, makeBox } from './geom';
import type { REntity } from './render-util';
import { buildChannel, buildPhaseTable, easeOut, mixHex, oval, phaseKey, phaseWeight, smooth01 } from './render-util';
import type { EntFrame } from './render-entities';
import {
  drawBestFlag,
  drawBush,
  drawDrum,
  drawGolden,
  drawHornbill,
  drawKiteDrum,
  drawLog,
  drawLogWarning,
  drawMango,
  drawMelon,
  drawMound,
  drawPickup,
  drawPit,
  drawShadow,
  drawTitleDrum,
  makeEntFrame,
} from './render-entities';
import {
  drawClouds,
  drawFarKites,
  drawFireflies,
  drawGround,
  drawGroundTint,
  drawHills,
  drawMesas,
  drawStars,
  drawSunMoon,
  drawTrees,
  drawTufts,
  makeBgFrame,
} from './render-world';
import { createTotoRig, makeTotoView } from './render-toto';

/** Offscreen buffer for drawing Toto at partial alpha (logical size, feet position). */
const BUF_W = 220;
const BUF_H = 190;
const BUF_FX = 110;
const BUF_FY = 140;

const DEBUG_FONT = 'bold 12px ui-monospace, Menlo, Consolas, monospace';

/* TOTOTO TIME look */
/** Festival sky a phase's sky blends toward at full fever strength (top, horizon, how far). */
interface FeverSky {
  top: string;
  bottom: string;
  mix: number;
}
/**
 * Per phase, in PHASES order. Dawn/dusk skies are warm already and night must stay dark (hazard
 * readability), so they only get a 35% push; 35% of coral over noon's bright blue reads lavender,
 * so noon mostly swaps to a coral -> gold festival sky.
 */
const FEVER_SKY: ReadonlyArray<FeverSky> = [
  { top: '#FF5A5F', bottom: '#FFB627', mix: 0.35 },
  { top: '#FF6B3D', bottom: '#FFC24A', mix: 0.74 },
  { top: '#FF5A5F', bottom: '#FFB627', mix: 0.35 },
  { top: '#FF5A5F', bottom: '#FFB627', mix: 0.35 },
];
function feverSkyDef(i: number): FeverSky {
  return FEVER_SKY[i] || FEVER_SKY[0];
}
const FEVER_SKY_STEPS = 16;
const FEVER_EASE_IN = 0.4;
/** A fever that ends early (restart) still fades the sky out over this long instead of popping. */
const FEVER_SKY_FADE = 0.4;
const FEVER_POP = 1.25;
const FEVER_POP_T = 0.3;

/** Real seconds since the current fever started (introT when gameplay keeps it, else sim time). */
function feverSince(state: ReadState): number {
  const f = state.fever;
  const it = f.introT;
  if (typeof it === 'number' && it >= 0 && it < 90) return it;
  return FEVER.duration - f.t;
}

/** 0..1 strength of the fever sky: ease in over 0.4 s, out over the last FEVER.warn s. */
function feverSkyTarget(state: ReadState): number {
  const f = state.fever;
  if (!f.active) return 0;
  const wIn = smooth01(feverSince(state) / FEVER_EASE_IN);
  const wOut = smooth01(f.t / FEVER.warn);
  return wIn < wOut ? wIn : wOut;
}

function makeGlow(doc: Document, size: number, c0: string, c1: string, c2: string): HTMLCanvasElement | null {
  try {
    const cv = doc.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const g = cv.getContext('2d');
    if (!g) return null;
    const r = size / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, c0);
    grad.addColorStop(0.25, c1);
    grad.addColorStop(1, c2);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return cv;
  } catch (_e) {
    return null;
  }
}

export function createRenderer(ctx: CanvasRenderingContext2D, fx: FxApi, crng: Rng): Renderer {
  const table = buildPhaseTable();
  // Full-strength festival sky per phase-blend key (init only; the 0.58 mid stop matches the phase skies).
  const feverTop = buildChannel((p, i) => mixHex(p.skyTop, feverSkyDef(i).top, feverSkyDef(i).mix));
  const feverMid = buildChannel((p, i) => {
    const f = feverSkyDef(i);
    return mixHex(mixHex(p.skyTop, p.skyBottom, 0.58), mixHex(f.top, f.bottom, 0.58), f.mix);
  });
  const feverBottom = buildChannel((p, i) => mixHex(p.skyBottom, feverSkyDef(i).bottom, feverSkyDef(i).mix));
  const ef: EntFrame = makeEntFrame();
  const bg = makeBgFrame();
  const tv = makeTotoView();
  const rig = createTotoRig((crng.seed ^ 0x5bd1e995) | 0);

  let doc: Document | null = null;
  try {
    doc = ctx.canvas.ownerDocument;
  } catch (_e) {
    doc = null;
  }
  const glow = doc ? makeGlow(doc, 128, 'rgba(255,250,220,1)', 'rgba(255,228,94,0.55)', 'rgba(255,182,39,0)') : null;
  const glowCool = doc ? makeGlow(doc, 64, 'rgba(250,255,220,1)', 'rgba(232,255,138,0.45)', 'rgba(199,210,254,0)') : null;
  ef.glow = glow;
  ef.glowCool = glowCool;
  bg.glow = glow;
  bg.glowCool = glowCool;

  // Sky gradient cache (key = phase key * (FEVER_SKY_STEPS + 1) + fever step)
  let sky: CanvasGradient | null = null;
  let skyKey = -1;
  let feverW = 0;
  let skyVersion = -1;
  let skyH = -1;

  // Toto alpha buffer
  let buf: HTMLCanvasElement | null = null;
  let bctx: CanvasRenderingContext2D | null = null;
  let bufK = 0;

  // Private animation state
  let rt = 0;
  let wind = 340;
  let lastCam = 0;
  let lastMode = '';
  let titleLowest = 0;
  let titleHitT = 9;
  let lastHeroVy = 0;
  let rigPrimed = false;
  let lastPose = '';
  let sinkT = 0;
  let sinkFrom = 0;

  // Debug overlay caches
  const box = makeBox();
  let dbgSpeed = -1;
  let dbgFps = -1;
  let dbgParts = -1;
  let dbgTemplate = '';
  let dbgLine1 = '';
  let dbgLine2 = '';

  function ensureBuffer(K: number): void {
    if (buf !== null && bufK === K) return;
    if (doc === null) return;
    try {
      if (buf === null) buf = doc.createElement('canvas');
      buf.width = Math.max(1, Math.ceil(BUF_W * K));
      buf.height = Math.max(1, Math.ceil(BUF_H * K));
      bctx = buf.getContext('2d');
      bufK = K;
    } catch (_e) {
      buf = null;
      bctx = null;
    }
  }

  function drawPits(state: ReadState): void {
    const list = state.entities;
    // ground-level pits first
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.active && e.kind === 'pit' && visible(e, 40)) drawPit(ctx, ef, e);
    }
  }

  function visible(e: REntity, margin: number): boolean {
    const sx = e.x - ef.camX;
    return sx + e.w + margin > 0 && sx - margin < ef.viewW;
  }

  function drawProps(state: ReadState): void {
    const list = state.entities;
    // best flag (behind everything else)
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.active && e.kind === 'bestFlag' && visible(e, 80)) drawBestFlag(ctx, ef, e);
    }
    // soft contact shadows under ground props (one batch, under everything)
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = PAL.outline;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active || !visible(e, 40)) continue;
      if (e.kind !== 'drum' && e.kind !== 'bush' && e.kind !== 'mound' && e.kind !== 'melon') continue;
      if (e.flag === 'smashed' || e.flag === 'burst') continue;
      const sx = e.x + e.w / 2 - ef.camX;
      ctx.setTransform(ef.K, 0, 0, ef.K, ef.PX + sx * ef.K, (GROUND_Y + ef.oy) * ef.K);
      ctx.beginPath();
      ctx.ellipse(0, 1, e.w * 0.58, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // ground props
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active || !visible(e, 90)) continue;
      switch (e.kind) {
        case 'drum':
          drawDrum(ctx, ef, e);
          break;
        case 'kiteDrum':
          drawKiteDrum(ctx, ef, e);
          break;
        case 'bush':
          drawBush(ctx, ef, e);
          break;
        case 'mound':
          drawMound(ctx, ef, e);
          break;
        case 'melon':
          drawMelon(ctx, ef, e);
          break;
        default:
          break;
      }
    }
    // movers + floaters on top
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active || !visible(e, 90)) continue;
      switch (e.kind) {
        case 'log':
          drawLog(ctx, ef, e);
          break;
        case 'hornbill':
          drawHornbill(ctx, ef, e);
          break;
        case 'pickupShield':
          drawPickup(ctx, ef, e, false);
          break;
        case 'pickupMagnet':
          drawPickup(ctx, ef, e, true);
          break;
        case 'goldenMango':
          drawGolden(ctx, ef, e);
          break;
        case 'mango':
          drawMango(ctx, ef, e);
          break;
        default:
          break;
      }
    }
    const ml = state.mangoes;
    for (let i = 0; i < ml.length; i++) {
      const e = ml[i];
      if (!e.active || !visible(e, 60)) continue;
      if (e.kind === 'goldenMango') drawGolden(ctx, ef, e);
      else drawMango(ctx, ef, e);
    }
  }

  function hasDrumUnder(state: ReadState, wx: number): boolean {
    const list = state.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.active && (e.kind === 'drum' || e.kind === 'kiteDrum') && wx > e.x - 10 && wx < e.x + e.w + 10) return true;
    }
    return false;
  }

  function drawToto(state: ReadState, dt: number, x: number, y: number, heroWX: number, heroWY: number): void {
    const h = state.hero;
    const reduced = state.save.reducedMotion;
    // Fill the view from hero state.
    tv.pose = h.pose;
    tv.expr = h.expr;
    tv.squashX = h.squashX;
    tv.squashY = h.squashY;
    tv.rot = h.rot;
    tv.runPhase = h.runPhase;
    tv.vy = h.vy;
    tv.cheekPuff = h.cheekPuff;
    tv.sweatT = h.sweatT;
    tv.flash = h.flashT > 0 && !reduced;
    tv.shield = h.shield;
    tv.fever = state.fever.active;
    tv.deathT = h.deathT;
    tv.night = ef.night;
    tv.time = rt;
    // TOTOTO TIME entry pop (render only; hitboxes untouched). Skipped in reduced motion.
    tv.scale = 1;
    if (state.fever.active && !reduced) {
      const since = feverSince(state);
      if (since >= 0 && since < FEVER_POP_T) tv.scale = 1 + (FEVER_POP - 1) * (1 - easeOut(since / FEVER_POP_T));
    }
    if (state.fever.active && h.expr !== 'dizzy' && h.expr !== 'sleep') tv.expr = 'star';
    // pupils look at the nearest hazard (world look target from gameplay)
    const dx = h.lookX - (heroWX + 20);
    const dy = h.lookY - (heroWY - 48);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0.001) {
      const m = d > 40 ? 1 : d / 40;
      tv.lookX = (dx / d) * m;
      tv.lookY = (dy / d) * m;
    } else {
      tv.lookX = 1;
      tv.lookY = 0;
    }

    if (!rigPrimed) {
      rig.reset(tv, x, y);
      rigPrimed = true;
    }
    rig.step(dt, tv, x, y, wind, h.whip);

    // Alpha: invulnerability blink (steady 50% in reduced motion), fever-end warning flicker.
    let a = 1;
    if (h.invulnT > 0 && state.mode === 'playing') {
      a = reduced ? 0.5 : Math.floor(rt * 14) % 2 === 0 ? 1 : 0.3;
    }
    if (state.fever.active && state.fever.t < FEVER.warn) {
      a = Math.min(a, reduced ? 0.8 : Math.floor(rt * 10) % 2 === 0 ? 1 : 0.45);
    }

    // Fever aura (glow sprite, additive)
    if (state.fever.active && glow !== null) {
      const bp = state.music.beatPhase;
      const pulse = reduced ? 0.5 : (1 - bp) * (1 - bp);
      ctx.setTransform(ef.K, 0, 0, ef.K, ef.PX, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45 + 0.25 * pulse;
      const gs = 150 + pulse * 30;
      ctx.drawImage(glow, x - gs / 2, y - 32 - gs / 2, gs, gs);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    const sinking = h.pose === 'sink';
    if (sinking) {
      ctx.save();
      ctx.setTransform(ef.K, 0, 0, ef.K, ef.PX, 0);
      ctx.beginPath();
      ctx.rect(-10, -10, ef.viewW + 20, GROUND_Y + PIT.mudDepth + ef.oy + 10);
      ctx.clip();
    }
    if (a >= 0.999) {
      rig.draw(ctx, tv, ef.K, ef.PX, 0, x, y);
    } else {
      ensureBuffer(ef.K);
      if (buf !== null && bctx !== null) {
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.globalAlpha = 1;
        bctx.globalCompositeOperation = 'source-over';
        bctx.clearRect(0, 0, buf.width, buf.height);
        rig.draw(bctx, tv, ef.K, 0, 0, BUF_FX, BUF_FY);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = a;
        ctx.drawImage(buf, ef.PX + (x - BUF_FX) * ef.K, (y - BUF_FY) * ef.K);
        ctx.globalAlpha = 1;
      } else {
        rig.draw(ctx, tv, ef.K, ef.PX, 0, x, y);
      }
    }
    if (sinking) {
      ctx.restore();
      // mud collar around the sunk hippo
      const my = GROUND_Y + PIT.mudDepth + ef.oy;
      ctx.setTransform(ef.K, 0, 0, ef.K, ef.PX, 0);
      ctx.beginPath();
      oval(ctx, x + 4, my, 44, 5.5, 0);
      ctx.fillStyle = PAL.mud;
      ctx.fill();
      ctx.strokeStyle = PAL.outline;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.ellipse(x + 4, my, 44, 5.5, 0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
    }
  }

  function drawDebug(state: ReadState, heroWX: number, heroWY: number): void {
    const K = ef.K;
    ctx.setTransform(K, 0, 0, K, ef.PX - ef.camX * K, ef.oy * K);
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    heroHurtboxAt(heroWX, heroWY, box);
    const pad = HERO.pickupPad;
    ctx.strokeStyle = '#7FE3FF';
    ctx.strokeRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2);
    ctx.strokeStyle = '#22FF88';
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.lineWidth = 1.5;
    for (let p = 0; p < 2; p++) {
      const list = p === 0 ? state.entities : state.mangoes;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e.active) continue;
        entityHitbox(e, box);
        ctx.strokeStyle = e.hazard || e.kind === 'pit' ? '#FF3B3B' : e.stompable ? '#4FA8F6' : '#FFE45E';
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
    }
    // text
    const sp = Math.round(state.run.speed);
    const fps = Math.round(state.clock.fps);
    const parts = fx.count();
    const tpl = state.debug.template;
    if (sp !== dbgSpeed || fps !== dbgFps || parts !== dbgParts || tpl !== dbgTemplate) {
      dbgSpeed = sp;
      dbgFps = fps;
      dbgParts = parts;
      dbgTemplate = tpl;
      dbgLine1 = 'tpl ' + (tpl === '' ? '-' : tpl);
      dbgLine2 = 'v ' + sp + '  fps ' + fps + '  fx ' + parts + '  ent ' + (state.entityCount + state.mangoCount);
    }
    const v = state.view;
    ctx.setTransform(K, 0, 0, K, ef.PX, 0);
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = PAL.bg;
    const tx = v.safeL + 10;
    const ty = v.viewH - v.safeB - 46;
    ctx.fillRect(tx - 6, ty - 14, 250, 38);
    ctx.globalAlpha = 1;
    ctx.font = DEBUG_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#E8FF8A';
    ctx.fillText(dbgLine1, tx, ty - 3);
    ctx.fillText(dbgLine2, tx, ty + 13);
  }

  const renderer: Renderer = {
    resize(view: ViewMetrics): void {
      sky = null;
      skyVersion = -1;
      ensureBuffer(view.dpr * view.s);
      rigPrimed = false;
    },

    draw(state: ReadState, alpha: number): void {
      const v = state.view;
      const canvas = ctx.canvas;
      const K = v.dpr * v.s;
      const PX = v.dpr * v.padX;
      const paused = state.mode === 'paused';
      let dt = paused ? 0 : state.clock.frameDt;
      if (dt > 0.1) dt = 0.1;
      if (dt < 0) dt = 0;
      rt += dt;
      const reduced = state.save.reducedMotion;

      // ---- frame setup ----
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (PX > 0) {
        ctx.fillStyle = VIEW.pillarColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.setTransform(K, 0, 0, K, PX, 0);
      ctx.save();
      if (PX > 0) {
        ctx.beginPath();
        ctx.rect(0, 0, v.viewW, v.viewH);
        ctx.clip();
      }

      const cam = state.cam;
      const camI = cam.prevX + (cam.x - cam.prevX) * alpha;
      const shX = cam.shakeX;
      const shY = cam.shakeY;
      const ph = state.phase;
      const key = phaseKey(ph.index, ph.blend);
      const night = phaseWeight(3, ph.index, ph.next, ph.blend);
      const dusk = phaseWeight(2, ph.index, ph.next, ph.blend);

      // wind = smoothed on-screen scroll speed (drives the bandana)
      if (dt > 0) {
        const inst = (camI - lastCam) / dt;
        const target = inst > 0 && inst < 2000 ? inst : wind * 0.9;
        wind += (target - wind) * (1 - Math.exp(-dt * 6));
      }
      lastCam = camI;

      bg.K = K;
      bg.PX = PX;
      bg.viewW = v.viewW;
      bg.viewH = v.viewH;
      bg.offY = v.offsetY;
      bg.camX = camI;
      bg.shakeX = shX;
      bg.shakeY = shY;
      bg.key = key;
      bg.distM = state.run.distance;
      bg.time = rt;
      bg.night = night;
      bg.dusk = dusk;
      bg.lowQ = state.clock.lowQuality;

      // TOTOTO TIME strength (analytic ease; an early end fades over FEVER_SKY_FADE instead of popping)
      let fw = feverSkyTarget(state);
      if (fw < feverW) {
        const floor = feverW - dt / FEVER_SKY_FADE;
        if (fw < floor) fw = floor;
      }
      feverW = fw > 0 ? fw : 0;
      if (feverW > 0 && !reduced) {
        const bp = state.music.beatPhase;
        const u = bp >= 0 && bp < 1 ? 1 - bp : 0;
        bg.feverPulse = feverW * u * u;
      } else {
        bg.feverPulse = 0;
      }

      ef.K = K;
      ef.PX = PX;
      ef.camX = camI + shX;
      ef.oy = v.offsetY + shY;
      ef.time = rt;
      ef.night = night;
      ef.fever = state.fever.active;
      ef.reduced = reduced;
      ef.alpha = alpha;
      ef.viewW = v.viewW;
      ef.viewH = v.viewH;
      ef.safeR = v.safeR;
      ef.groundTop = table.groundTop[key];
      ef.groundBody = table.groundBody[key];

      // ---- sky (cached gradient) ----
      const horizon = GROUND_Y + v.offsetY;
      const fs = Math.round(feverW * FEVER_SKY_STEPS);
      const sk = key * (FEVER_SKY_STEPS + 1) + fs;
      if (sky === null || sk !== skyKey || v.version !== skyVersion || horizon !== skyH) {
        const g = ctx.createLinearGradient(0, 0, 0, horizon);
        if (fs === 0) {
          g.addColorStop(0, table.skyTop[key]);
          g.addColorStop(0.62, table.skyMid[key]);
          g.addColorStop(1, table.skyBottom[key]);
        } else {
          // Cache miss only (a new gradient is built here anyway): mix toward the festival sky.
          const m = fs / FEVER_SKY_STEPS;
          g.addColorStop(0, mixHex(table.skyTop[key], feverTop[key], m));
          g.addColorStop(0.62, mixHex(table.skyMid[key], feverMid[key], m));
          g.addColorStop(1, mixHex(table.skyBottom[key], feverBottom[key], m));
        }
        sky = g;
        skyKey = sk;
        skyVersion = v.version;
        skyH = horizon;
      }
      ctx.fillStyle = sky;
      ctx.fillRect(-2, -2, v.viewW + 4, horizon + 24);

      drawStars(ctx, bg);
      drawSunMoon(ctx, bg);
      drawClouds(ctx, bg, table);
      drawFarKites(ctx, bg, table);
      drawMesas(ctx, bg, table);
      drawHills(ctx, bg, table);
      drawTrees(ctx, bg, table);
      drawGround(ctx, bg, table);

      // ---- gameplay layer ----
      drawPits(state);
      drawGroundTint(ctx, bg);

      const h = state.hero;
      const heroWX = camI + v.heroX;
      const heroWY = h.prevY + (h.y - h.prevY) * alpha;
      // Toto's shadow (helps judge landings)
      if (h.pitIndex < 0 && h.pose !== 'sink') drawShadow(ctx, ef, heroWX + 2, GROUND_Y - heroWY, 30);

      // Title scene: Toto bounces on a drum gameplay may not have spawned.
      if (state.mode !== lastMode) {
        lastMode = state.mode;
        titleLowest = h.y;
        titleHitT = 9;
      }
      titleHitT += dt;
      if (state.mode === 'title') {
        if (h.y > titleLowest) titleLowest = h.y;
        if (h.vy < 0 && lastHeroVy >= 0 && h.y <= GROUND_Y - DRUM.h + 6) titleHitT = 0;
        if (titleLowest <= GROUND_Y - DRUM.h + 4 && !hasDrumUnder(state, heroWX)) {
          drawTitleDrum(ctx, ef, heroWX - DRUM.w / 2 + 4, titleHitT);
        }
      }
      lastHeroVy = h.vy;

      drawProps(state);

      // ---- Toto ----
      let feetY = heroWY;
      if (h.pose === 'sink') {
        // Settle half-way into the mud so the nap reads, whatever depth gameplay stops at.
        const mud = GROUND_Y + PIT.mudDepth;
        if (lastPose !== 'sink') {
          sinkT = 0;
          sinkFrom = heroWY;
        }
        sinkT += dt;
        const eased = sinkFrom + (mud + 25 - sinkFrom) * easeOut(sinkT / 0.9);
        if (eased > feetY) feetY = eased;
        if (GROUND_Y + h.sinkDepth > feetY) feetY = GROUND_Y + h.sinkDepth;
        if (feetY > mud + 30) feetY = mud + 30;
      }
      lastPose = h.pose;
      drawToto(state, dt, v.heroX - shX, feetY + v.offsetY + shY, heroWX, heroWY);

      // ---- fx (world space) ----
      ctx.setTransform(K, 0, 0, K, PX - ef.camX * K, ef.oy * K);
      ctx.globalAlpha = 1;
      fx.drawWorld(ctx);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // ---- foreground ----
      drawTufts(ctx, bg, table, state.entities);
      drawFireflies(ctx, bg);

      // log "!" edge warnings (a live cue: hidden once the run has ended)
      const list = state.entities;
      const liveRun = state.mode === 'playing' || state.mode === 'paused';
      for (let i = 0; i < list.length && liveRun; i++) {
        const e = list[i];
        if (e.active && e.kind === 'log' && e.warnT > 0) drawLogWarning(ctx, ef, e);
      }

      // ---- screen-space fx ----
      ctx.setTransform(K, 0, 0, K, PX, 0);
      ctx.globalAlpha = 1;
      fx.drawScreen(ctx);

      if (state.debug.overlay) drawDebug(state, heroWX, heroWY);

      ctx.restore();
      // Leave the base transform for ui.draw.
      ctx.setTransform(K, 0, 0, K, PX, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    },

    destroy(): void {
      sky = null;
      buf = null;
      bctx = null;
    },
  };
  return renderer;
}
