/**
 * Gameplay object drawing: drums, kite drums, hazards, pits, melons, mangoes, pickups, best
 * flag, log edge warning. Owner: ART engineer.
 *
 * Readability law (spec §1): SPIKY + red/orange = hurts (bush thorns, mound crown);
 * ROUND + dark outline = safe from above (drums, hornbill, log, melon); GLOWING yellow = collect;
 * only Toto is periwinkle. Every gameplay object gets the 3 u #1B1B3A outline (drawn as a 6 u
 * stroke under the fill so compound shapes read as one silhouette) and, at night, a 2 u light rim.
 *
 * Each draw function places its own transform with place() (double-precision camera maths in JS,
 * so far-away world x never loses precision) and draws in LOCAL coordinates. No allocation.
 */
import { BEST_FLAG, BUSH, CHAIN_HUES, DRUM, FONT_STACK, GROUND_Y, HORNBILL, PAL, PIT } from './config';
import type { Entity } from './types';
import type { REntity } from './render-util';
import { TAU, dot, oval, rrect, starPath, undersidePath } from './render-util';
import { hash01 } from './rng';

/** Per-frame drawing context shared by every entity draw (filled by render.ts). */
export interface EntFrame {
  /** Device px per logical u (dpr * s). */
  K: number;
  /** Device px x offset (dpr * padX). */
  PX: number;
  /** Interpolated camera x (+ shake). */
  camX: number;
  /** Logical y offset (offsetY + shakeY). */
  oy: number;
  /** Render clock (s). */
  time: number;
  /** Night rim weight 0..1. */
  night: number;
  fever: boolean;
  reduced: boolean;
  /** Interpolation alpha for moving entities. */
  alpha: number;
  viewW: number;
  viewH: number;
  safeR: number;
  /** Glow sprite (pre-rendered radial) or null. */
  glow: HTMLCanvasElement | null;
  glowCool: HTMLCanvasElement | null;
  /** Current (blended) ground colours. */
  groundTop: string;
  groundBody: string;
}

export function makeEntFrame(): EntFrame {
  return {
    K: 1,
    PX: 0,
    camX: 0,
    oy: 0,
    time: 0,
    night: 0,
    fever: false,
    reduced: false,
    alpha: 1,
    viewW: 760,
    viewH: 540,
    safeR: 0,
    glow: null,
    glowCool: null,
    groundTop: '#F2C57C',
    groundBody: '#C98F4E',
  };
}

const INK = PAL.outline;
const RIM = PAL.nightRim;
const WHITE = '#FFFFFF';
const SHADOW = '#1B1B3A';
const BUSH_LIGHT = '#4C8A6E';
const THORN_LIGHT = '#FF8A70';
const MOUND_LIGHT = '#D4894A';
const MOUND_HOLE = '#4A2308';
const CROWN_LIGHT = '#FDBA74';
const HORNBILL_BELLY = '#E9E4F2';
const CASQUE = '#FF9F1C';
const MANGO_BLUSH = '#FF7A3D';
const GOLD_BLUSH = '#FFC93C';
const SKIN_DENT = '#EBC891';
const POST_CAP = '#FFD166';
const MUD_LIGHT = '#7B55B0';
const WOOD = '#C08457';
const WOOD_HEAD = '#FFE8C2';
const SHIELD_HI = '#A0724B';
const IRIS_PINK = '#FF9EC4';
const BUBBLE_TINT = 'rgba(224,244,255,0.42)';
const IRIS_CYAN = '#7FE3FF';
const FLAG_STRIPE = '#FF5A5F';
const FLAG_FONT = 'bold 10px ' + FONT_STACK;
const WARN_FONT = 'bold 26px ' + FONT_STACK;
const WARN_RED = '#F25C54';
const HORNBILL_H = HORNBILL.h;

function place(ctx: CanvasRenderingContext2D, f: EntFrame, wx: number, wy: number): void {
  ctx.setTransform(f.K, 0, 0, f.K, f.PX + (wx - f.camX) * f.K, (wy + f.oy) * f.K);
}

/** Night rim + outline (6 u stroke under the fill) + fill of the current path. */
function inkFill(ctx: CanvasRenderingContext2D, f: EntFrame, fill: string, a: number): void {
  if (f.night > 0.01) {
    ctx.globalAlpha = a * f.night;
    ctx.strokeStyle = RIM;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.globalAlpha = a;
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Simple fill + 2.5 u outline for small parts. */
function fillLine(ctx: CanvasRenderingContext2D, fill: string, w: number): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = w;
  ctx.stroke();
}

/** Fade-out alpha for smashed / stomped / split entities. */
export function entityAlpha(e: REntity): number {
  if (e.flag === 'smashed') return e.stateT < 0.22 ? 1 - e.stateT / 0.22 : 0;
  if (e.flag === 'stomped') return e.stateT < 0.55 ? 1 : e.stateT < 0.9 ? 1 - (e.stateT - 0.55) / 0.35 : 0;
  if (e.flag === 'split') return e.stateT < 0.6 ? 1 : e.stateT < 0.95 ? 1 - (e.stateT - 0.6) / 0.35 : 0;
  if (e.flag === 'burst') return 0;
  return 1;
}

/** Alpha for a knocked-out body falling through the ground line (fades as it sinks). */
function sinkFade(bottomY: number): number {
  const d = bottomY - GROUND_Y;
  return d <= 4 ? 1 : d >= 26 ? 0 : 1 - (d - 4) / 22;
}

/** Soft ground shadow under a floating thing. */
export function drawShadow(ctx: CanvasRenderingContext2D, f: EntFrame, cx: number, height: number, w: number): void {
  const k = height > 420 ? 0 : 1 - height / 420;
  if (k <= 0.02) return;
  place(ctx, f, cx, GROUND_Y);
  ctx.globalAlpha = 0.2 * k;
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  oval(ctx, 0, 1, w * (0.55 + 0.45 * k), 4.5 * (0.6 + 0.4 * k), 0);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* ================================================================== */
/* Drums                                                               */
/* ================================================================== */

function drumBody(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity, a: number): void {
  const W = DRUM.w;
  const H = DRUM.h;
  const cx = W / 2;
  // dent / wobble (damped sine over wobbleDur)
  const ht = e.hitT;
  let dent = 0;
  let env = 0;
  if (ht < DRUM.wobbleDur * 1.6) {
    env = Math.exp(-ht * 11);
    dent = DRUM.dentDepth * env * Math.cos(ht * TAU * DRUM.wobbleHz * 0.5);
  }
  // squash the whole drum a touch on impact (anchored at the bottom)
  if (env > 0.01) {
    ctx.translate(cx, H);
    ctx.scale(1 + 0.06 * env, 1 - 0.1 * env * Math.cos(ht * TAU * DRUM.wobbleHz * 0.5));
    ctx.translate(-cx, -H);
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // silhouette: barrel shell + skin
  ctx.beginPath();
  ctx.moveTo(1, 7);
  ctx.quadraticCurveTo(-4, 21, 3, 34);
  ctx.ellipse(cx, 34, cx - 3, 6, 0, Math.PI, 0, true);
  ctx.quadraticCurveTo(W + 4, 21, W - 1, 7);
  ctx.ellipse(cx, 7, cx - 1, 8, 0, 0, Math.PI, true);
  ctx.closePath();
  inkFill(ctx, f, PAL.drumShell, a);
  // darker underside + highlight stripe (clipped to the shell)
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PAL.drumShellDark;
  ctx.globalAlpha = a * 0.75;
  ctx.beginPath();
  ctx.ellipse(cx, 29, cx + 4, 6, 0, 0, Math.PI, false);
  ctx.lineTo(-4, H + 4);
  ctx.lineTo(W + 4, H + 4);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = a * 0.28;
  ctx.fillStyle = WHITE;
  ctx.fillRect(12, 8, 7, 26);
  ctx.globalAlpha = a;
  ctx.restore();
  // rim bands
  ctx.strokeStyle = PAL.drumLacing;
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.ellipse(cx, 12, cx - 0.5, 7, 0, 0.12, Math.PI - 0.12, false);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, 30, cx - 2, 6, 0, 0.1, Math.PI - 0.1, false);
  ctx.stroke();
  // zig-zag lacing following the barrel curve
  ctx.lineWidth = 2.1;
  ctx.beginPath();
  for (let j = 0; j <= 8; j++) {
    const x = 6 + j * 9;
    const n = (x - cx) / (cx + 2);
    const curve = Math.sqrt(1 - n * n);
    const y = (j & 1) === 0 ? 14 + 6 * curve : 28 + 5 * curve;
    if (j === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // skin
  ctx.beginPath();
  oval(ctx, cx, 7, cx - 1, 8, 0);
  ctx.fillStyle = PAL.drumSkin;
  ctx.fill();
  if (dent > 0.2 || dent < -0.2) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = SKIN_DENT;
    ctx.beginPath();
    const dy = dent > 0 ? dent : dent * 0.4;
    oval(ctx, cx, 6 + dy * 0.55, cx - 9, 4 + (dy > 0 ? dy * 0.35 : 0), 0);
    ctx.fill();
    ctx.restore();
  }
  // note-hue flash on the skin
  if (e.hue >= 0 && ht < 0.5) {
    ctx.globalAlpha = a * 0.75 * (1 - ht / 0.5);
    ctx.fillStyle = CHAIN_HUES[e.hue % CHAIN_HUES.length];
    ctx.beginPath();
    oval(ctx, cx, 7, cx - 1, 8, 0);
    ctx.fill();
    ctx.globalAlpha = a;
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  oval(ctx, cx, 7, cx - 1, 8, 0);
  ctx.stroke();
  // shine on the skin
  ctx.globalAlpha = a * 0.6;
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  oval(ctx, cx - 14, 4.5 + dent * 0.25, 11, 2.2, -0.05);
  ctx.fill();
  ctx.globalAlpha = a;
  // hue ring around the skin
  if (e.hue >= 0 && ht < DRUM.wobbleDur) {
    const u = ht / DRUM.wobbleDur;
    ctx.globalAlpha = a * (1 - u);
    ctx.strokeStyle = CHAIN_HUES[e.hue % CHAIN_HUES.length];
    ctx.lineWidth = 4 * (1 - u) + 1;
    ctx.beginPath();
    oval(ctx, cx, 7, cx + 4 + u * 14, 10 + u * 5, 0);
    ctx.stroke();
    ctx.globalAlpha = a;
  }
}

export function drawDrum(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  place(ctx, f, e.x, e.y);
  drumBody(ctx, f, e, 1);
}

export function drawKiteDrum(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const cx = e.x + DRUM.w / 2;
  drawShadow(ctx, f, cx, GROUND_Y - (e.y + DRUM.h), DRUM.w * 0.45);
  const t = f.time + e.phase;
  const sway = Math.sin(t * 1.3) * 4;
  const kx = DRUM.w / 2 + sway;
  const ky = -66 + Math.sin(t * 1.9) * 3;
  const kr = Math.sin(t * 1.3 + 0.4) * 0.09;
  place(ctx, f, e.x, e.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // strings
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(6, 3);
  ctx.lineTo(kx, ky + 26);
  ctx.moveTo(DRUM.w - 6, 3);
  ctx.lineTo(kx, ky + 26);
  ctx.stroke();
  // tail with bows
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(kx, ky + 26);
  for (let j = 1; j <= 8; j++) {
    const tx = kx - j * 5.5;
    const ty = ky + 26 + j * 3 + Math.sin(t * 5 - j * 0.9) * 3;
    ctx.lineTo(tx, ty);
  }
  ctx.stroke();
  for (let j = 1; j <= 3; j++) {
    const tx = kx - j * 13;
    const ty = ky + 26 + j * 7 + Math.sin(t * 5 - j * 2.2) * 3;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 4, ty - 3.5);
    ctx.lineTo(tx - 4, ty + 3.5);
    ctx.closePath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + 4, ty - 3.5);
    ctx.lineTo(tx + 4, ty + 3.5);
    ctx.closePath();
    fillLine(ctx, (j & 1) === 1 ? PAL.kiteAlt : PAL.kite, 1.4);
  }
  // kite (diamond in four quarters)
  ctx.save();
  ctx.translate(kx, ky);
  ctx.rotate(kr);
  const tY = -28;
  const sX = 21;
  const sY = -7;
  const bY = 26;
  for (let q = 0; q < 4; q++) {
    ctx.beginPath();
    ctx.moveTo(0, sY);
    if (q === 0) {
      ctx.lineTo(0, tY);
      ctx.lineTo(-sX, sY);
    } else if (q === 1) {
      ctx.lineTo(0, tY);
      ctx.lineTo(sX, sY);
    } else if (q === 2) {
      ctx.lineTo(sX, sY);
      ctx.lineTo(0, bY);
    } else {
      ctx.lineTo(-sX, sY);
      ctx.lineTo(0, bY);
    }
    ctx.closePath();
    ctx.fillStyle = q === 0 || q === 2 ? PAL.kite : PAL.kiteAlt;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(0, tY);
  ctx.lineTo(sX, sY);
  ctx.lineTo(0, bY);
  ctx.lineTo(-sX, sY);
  ctx.closePath();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, tY);
  ctx.lineTo(0, bY);
  ctx.moveTo(-sX, sY);
  ctx.lineTo(sX, sY);
  ctx.stroke();
  // kite face: a happy little sun
  ctx.fillStyle = WHITE;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  dot(ctx, 0, -3, 5);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
  // the drum itself (gentle bob is cosmetic-free: collision box is exact)
  place(ctx, f, e.x, e.y);
  drumBody(ctx, f, e, 1);
}

/* ================================================================== */
/* Hazards                                                             */
/* ================================================================== */

/** Thorn bush 44 x 34: dark green blob with 7 red-orange thorns and grumpy eyes. */
export function drawBush(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const a = entityAlpha(e);
  if (a <= 0) return;
  place(ctx, f, e.x, e.y);
  if (e.flag === 'smashed') {
    const s = 1 - e.stateT * 2;
    ctx.translate(22, 34);
    ctx.scale(s, s);
    ctx.translate(-22, -34);
  }
  ctx.globalAlpha = a;
  ctx.lineJoin = 'round';
  const cx = 22;
  const cy = 20;
  const shiver = Math.sin(f.time * 3 + e.phase) * 0.04;
  // thorns (behind the blob): fat red-orange triangles, unmistakably pointy
  ctx.beginPath();
  for (let i = 0; i < BUSH.thorns; i++) {
    const ang = Math.PI * (0.97 + (1.06 * i) / (BUSH.thorns - 1)) + shiver;
    const w = 0.5;
    ctx.moveTo(cx + Math.cos(ang - w) * 14, cy + Math.sin(ang - w) * 12);
    ctx.lineTo(cx + Math.cos(ang) * 33, cy + Math.sin(ang) * 28);
    ctx.lineTo(cx + Math.cos(ang + w) * 14, cy + Math.sin(ang + w) * 12);
    ctx.closePath();
  }
  ctx.fillStyle = PAL.thorn;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.fillStyle = THORN_LIGHT;
  ctx.beginPath();
  for (let i = 0; i < BUSH.thorns; i++) {
    const ang = Math.PI * (0.97 + (1.06 * i) / (BUSH.thorns - 1)) + shiver;
    ctx.moveTo(cx + Math.cos(ang - 0.16) * 19, cy + Math.sin(ang - 0.16) * 16);
    ctx.lineTo(cx + Math.cos(ang - 0.03) * 28, cy + Math.sin(ang - 0.03) * 23.5);
    ctx.lineTo(cx + Math.cos(ang - 0.02) * 19, cy + Math.sin(ang - 0.02) * 16);
    ctx.closePath();
  }
  ctx.fill();
  // blob
  ctx.beginPath();
  dot(ctx, 11, 23, 11);
  ctx.moveTo(36, 17);
  dot(ctx, 22, 17, 14);
  ctx.moveTo(44, 23);
  dot(ctx, 33, 23, 11);
  ctx.moveTo(4, 24);
  ctx.rect(4, 24, 36, 10);
  inkFill(ctx, f, PAL.bush, a);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PAL.bushDark;
  ctx.beginPath();
  oval(ctx, 22, 36, 26, 9, 0);
  ctx.fill();
  ctx.fillStyle = BUSH_LIGHT;
  ctx.beginPath();
  oval(ctx, 16, 9, 6, 3, -0.4);
  oval(ctx, 6, 18, 3.5, 2.2, -0.6);
  oval(ctx, 31, 12, 3.6, 2, 0.3);
  ctx.fill();
  ctx.restore();
  // grumpy eyes peeking out of the leaves (look left, toward Toto)
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  oval(ctx, 16, 21, 3.6, 3.2, 0);
  oval(ctx, 27, 21, 3.6, 3.2, 0);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.beginPath();
  dot(ctx, 15, 22, 1.8);
  dot(ctx, 26, 22, 1.8);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(12, 16.5);
  ctx.lineTo(19.5, 18.5);
  ctx.moveTo(31, 16.5);
  ctx.lineTo(23.5, 18.5);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Termite mound 44 x 84: jagged brown spire, angry eye-holes, orange spiky crown. */
export function drawMound(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const a = entityAlpha(e);
  if (a <= 0) return;
  place(ctx, f, e.x, e.y);
  if (e.flag === 'smashed') {
    const s = 1 - e.stateT * 2;
    ctx.translate(22, 84);
    ctx.scale(s, s);
    ctx.translate(-22, -84);
  }
  ctx.globalAlpha = a;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // crown first (spire covers its base)
  ctx.beginPath();
  ctx.moveTo(9, 22);
  ctx.lineTo(4, 9);
  ctx.lineTo(13, 13);
  ctx.lineTo(14, -1);
  ctx.lineTo(20, 10);
  ctx.lineTo(25, -3);
  ctx.lineTo(28, 10);
  ctx.lineTo(35, 1);
  ctx.lineTo(33, 14);
  ctx.lineTo(41, 10);
  ctx.lineTo(35, 22);
  ctx.closePath();
  ctx.fillStyle = PAL.moundCrown;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.fillStyle = CROWN_LIGHT;
  ctx.beginPath();
  ctx.moveTo(14, 4);
  ctx.lineTo(17, 11);
  ctx.lineTo(13.5, 11);
  ctx.closePath();
  ctx.moveTo(25, 2);
  ctx.lineTo(27, 10);
  ctx.lineTo(23.5, 10);
  ctx.closePath();
  ctx.fill();
  // spire
  ctx.beginPath();
  ctx.moveTo(-1, 84);
  ctx.quadraticCurveTo(1, 74, 4, 69);
  ctx.quadraticCurveTo(2, 62, 6, 56);
  ctx.quadraticCurveTo(5, 48, 9, 43);
  ctx.quadraticCurveTo(8, 34, 11, 28);
  ctx.quadraticCurveTo(11, 22, 14, 17);
  ctx.lineTo(31, 17);
  ctx.quadraticCurveTo(34, 23, 33, 29);
  ctx.quadraticCurveTo(37, 35, 36, 43);
  ctx.quadraticCurveTo(40, 49, 39, 57);
  ctx.quadraticCurveTo(43, 64, 41, 70);
  ctx.quadraticCurveTo(44, 76, 45, 84);
  ctx.closePath();
  inkFill(ctx, f, PAL.mound, a);
  ctx.save();
  ctx.clip();
  // shaded right flank
  ctx.fillStyle = PAL.moundDark;
  ctx.beginPath();
  ctx.moveTo(27, 14);
  ctx.quadraticCurveTo(31, 50, 30, 86);
  ctx.lineTo(48, 86);
  ctx.lineTo(48, 14);
  ctx.closePath();
  ctx.fill();
  // lit ridges
  ctx.strokeStyle = MOUND_LIGHT;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(14, 26);
  ctx.quadraticCurveTo(11, 50, 12, 80);
  ctx.moveTo(20, 22);
  ctx.quadraticCurveTo(19, 36, 21, 46);
  ctx.moveTo(8, 60);
  ctx.lineTo(9, 78);
  ctx.stroke();
  // strata bumps
  ctx.strokeStyle = PAL.moundDark;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(6, 57);
  ctx.quadraticCurveTo(14, 60, 22, 57);
  ctx.moveTo(4, 71);
  ctx.quadraticCurveTo(13, 74, 20, 71);
  ctx.stroke();
  ctx.restore();
  // angry eye-holes with orange glints
  ctx.fillStyle = MOUND_HOLE;
  ctx.beginPath();
  oval(ctx, 16, 40, 4.2, 3, 0.45);
  oval(ctx, 28, 40, 4.2, 3, -0.45);
  oval(ctx, 23, 64, 3, 3.6, 0);
  ctx.fill();
  ctx.fillStyle = PAL.moundCrown;
  ctx.beginPath();
  dot(ctx, 15, 40.5, 1.4);
  dot(ctx, 27, 40.5, 1.4);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(10.5, 34);
  ctx.lineTo(20, 37.5);
  ctx.moveTo(33.5, 34);
  ctx.lineTo(24, 37.5);
  ctx.stroke();
  // dirt clumps at the base
  ctx.fillStyle = PAL.moundDark;
  ctx.beginPath();
  oval(ctx, -3, 82, 5, 3, 0);
  oval(ctx, 47, 82, 4.5, 2.6, 0);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Hornbill 50 x 30 (body box): round navy body, big yellow beak, angry brow, flapping wing. */
export function drawHornbill(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  let a = entityAlpha(e);
  if (a <= 0) return;
  const x = e.x + e.vx * (f.alpha - 1) * (1 / 120);
  let y = e.y;
  let rot = 0;
  const stomped = e.flag === 'stomped';
  if (stomped) {
    // gameplay drops it with gravity + spin; fall back to a cosmetic tumble if it does not
    if (e.vy === 0 && e.rot === 0) {
      y += 260 * e.stateT * e.stateT + 30 * e.stateT;
      rot = e.stateT * 7;
    } else {
      rot = e.rot;
    }
    a *= sinkFade(y + HORNBILL_H);
    if (a <= 0) return;
  }
  drawShadow(ctx, f, x + 28, GROUND_Y - (y + 30), 22);
  place(ctx, f, x, y);
  if (e.flag === 'smashed') {
    const s = 1 - e.stateT * 2.5;
    ctx.translate(26, 15);
    ctx.scale(s, s);
    ctx.translate(-26, -15);
  }
  if (rot !== 0) {
    ctx.translate(28, 16);
    ctx.rotate(rot);
    ctx.translate(-28, -16);
  }
  ctx.globalAlpha = a;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const flap = stomped ? -0.2 : Math.sin(e.age * TAU * 4.2 + e.phase);
  // far wing (behind)
  ctx.save();
  ctx.translate(31, 11);
  ctx.rotate(-0.5 - flap * 0.7);
  ctx.beginPath();
  oval(ctx, 10, 0, 14, 5.5, 0);
  ctx.fillStyle = PAL.hornbill;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.restore();
  // tail feathers
  ctx.beginPath();
  ctx.moveTo(44, 13);
  ctx.lineTo(60, 8);
  ctx.quadraticCurveTo(62, 12, 59, 15);
  ctx.lineTo(60, 19);
  ctx.quadraticCurveTo(58, 23, 55, 22);
  ctx.lineTo(43, 20);
  ctx.closePath();
  fillLine(ctx, PAL.hornbill, 2.6);
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(56, 9.5);
  ctx.lineTo(60, 8);
  ctx.quadraticCurveTo(62, 12, 59, 15);
  ctx.lineTo(56, 15);
  ctx.closePath();
  ctx.fill();
  // body + head silhouette
  ctx.beginPath();
  oval(ctx, 29, 16, 18, 13, 0);
  ctx.moveTo(23, 10);
  dot(ctx, 14, 10, 9.5);
  inkFill(ctx, f, PAL.hornbill, a);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = HORNBILL_BELLY;
  ctx.beginPath();
  oval(ctx, 26, 28, 14, 6.5, 0);
  ctx.fill();
  ctx.globalAlpha = a * 0.25;
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  oval(ctx, 24, 6, 8, 2.6, -0.2);
  ctx.fill();
  ctx.globalAlpha = a;
  ctx.restore();
  // feet
  ctx.fillStyle = PAL.hornbillBeak;
  ctx.beginPath();
  oval(ctx, 27, 29.5, 3.2, 2, 0);
  oval(ctx, 33, 29.5, 3.2, 2, 0);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // beak + casque
  ctx.beginPath();
  ctx.moveTo(9, 3);
  ctx.quadraticCurveTo(-4, 4, -13, 15);
  ctx.quadraticCurveTo(-2, 14, 8, 15);
  ctx.closePath();
  fillLine(ctx, PAL.hornbillBeak, 2.6);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(7, 9.5);
  ctx.quadraticCurveTo(-2, 10, -8, 13.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(10, 2);
  ctx.quadraticCurveTo(2, -4, -4, 3.5);
  ctx.quadraticCurveTo(2, 2.5, 9, 4.5);
  ctx.closePath();
  fillLine(ctx, CASQUE, 2.2);
  // eye + angry eyebrow
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  dot(ctx, 14, 9, 4);
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  if (stomped) {
    ctx.lineWidth = 1.8;
    ctx.moveTo(11.5, 6.5);
    ctx.lineTo(16.5, 11.5);
    ctx.moveTo(16.5, 6.5);
    ctx.lineTo(11.5, 11.5);
    ctx.stroke();
  } else {
    dot(ctx, 12.6, 10, 2);
    ctx.fill();
  }
  ctx.strokeStyle = PAL.hornbillBeak;
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(8.5, 2.5);
  ctx.lineTo(20, 5.5);
  ctx.stroke();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // near wing (flapping)
  ctx.save();
  ctx.translate(30, 12);
  ctx.rotate(-0.25 - flap * 0.85);
  ctx.beginPath();
  ctx.moveTo(-2, -3);
  ctx.quadraticCurveTo(12, -11, 24, -3);
  ctx.quadraticCurveTo(18, 1, 21, 4);
  ctx.quadraticCurveTo(10, 8, -2, 4);
  ctx.closePath();
  fillLine(ctx, PAL.hornbillWing, 2.6);
  ctx.strokeStyle = PAL.hornbill;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(19, 2);
  ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Rolling log, 46 diameter: bark ring with nubs, end face with spiral, grumpy upright eyes. */
export function drawLog(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  let a = entityAlpha(e);
  if (a <= 0) return;
  const x = e.x + e.vx * (f.alpha - 1) * (1 / 120);
  let y = e.y;
  let rot = e.rot;
  const stomped = e.flag === 'stomped';
  if (stomped) {
    if (e.vy === 0) {
      const t = e.stateT;
      y -= Math.max(0, 140 * t - 420 * t * t);
      rot -= t * 9;
    }
    a *= sinkFade(y + e.h);
    if (a <= 0) return;
  }
  const r = 23;
  // rolling dust kicked up behind
  if (!stomped && e.flag !== 'smashed') {
    place(ctx, f, x, e.y);
    const ph = (e.age * 3.2 + e.phase) % 1;
    ctx.fillStyle = f.groundTop;
    for (let i = 0; i < 2; i++) {
      const u = (ph + i * 0.5) % 1;
      ctx.globalAlpha = 0.55 * (1 - u);
      ctx.beginPath();
      dot(ctx, 44 + u * 18, 44 - u * 8, 3 + u * 5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  place(ctx, f, x + r, y + r);
  if (e.flag === 'smashed') {
    const s = 1 - e.stateT * 2.5;
    ctx.scale(s, s);
  }
  ctx.globalAlpha = a;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.save();
  ctx.rotate(rot);
  // bark silhouette with nubs
  ctx.beginPath();
  dot(ctx, 0, 0, r);
  for (let i = 0; i < 7; i++) {
    const ang = (i * TAU) / 7 + 0.3;
    const nx = Math.cos(ang) * (r - 0.5);
    const ny = Math.sin(ang) * (r - 0.5);
    ctx.moveTo(nx + 3.6, ny);
    dot(ctx, nx, ny, 3.6);
  }
  inkFill(ctx, f, PAL.logBark, a);
  // end face
  ctx.beginPath();
  dot(ctx, 0, 0, r - 5.5);
  ctx.fillStyle = PAL.log;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  // growth spiral
  ctx.strokeStyle = PAL.logRing;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  for (let j = 0; j <= 40; j++) {
    const th = j * 0.36;
    const rr = 1 + th * 1.05;
    const px = Math.cos(th) * rr;
    const py = Math.sin(th) * rr;
    if (j === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  // crack
  ctx.strokeStyle = PAL.logBark;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(r - 6, -2);
  ctx.lineTo(r - 11, 1);
  ctx.lineTo(r - 14, -1);
  ctx.stroke();
  ctx.restore();
  // upright grumpy eyes (do not roll)
  const blink = (e.age + e.phase) % 3.2 < 0.12;
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  if (blink) {
    ctx.rect(-10.5, -6, 7, 1.8);
    ctx.rect(3.5, -6, 7, 1.8);
  } else {
    oval(ctx, -7, -5, 4.2, 3.6, 0);
    ctx.moveTo(11.2, -5);
    oval(ctx, 7, -5, 4.2, 3.6, 0);
  }
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  if (!blink) {
    ctx.fillStyle = INK;
    ctx.beginPath();
    dot(ctx, -8.4, -4.4, 2);
    dot(ctx, 5.6, -4.4, 2);
    ctx.fill();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-12, -12);
  ctx.lineTo(-3, -9);
  ctx.moveTo(12, -12);
  ctx.lineTo(3, -9);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ================================================================== */
/* Pits                                                                */
/* ================================================================== */

function post(ctx: CanvasRenderingContext2D, f: EntFrame, x: number, a: number): void {
  const w = PIT.postW + 2;
  const h = PIT.postH;
  ctx.beginPath();
  rrect(ctx, x, -h, w, h + 2, 3);
  inkFill(ctx, f, PAL.postB, a);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PAL.postA;
  for (let j = 0; j < 3; j++) {
    ctx.beginPath();
    ctx.moveTo(x - 1, -h + 4 + j * 10);
    ctx.lineTo(x + w + 1, -h + j * 10);
    ctx.lineTo(x + w + 1, -h + 5 + j * 10);
    ctx.lineTo(x - 1, -h + 9 + j * 10);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.beginPath();
  dot(ctx, x + w / 2, -h - 1, 3.4);
  fillLine(ctx, POST_CAP, 2.2);
}

/**
 * Mud pit: hole in the ground with violet mud 26 u down, bubbles, striped fence posts on both lips.
 * During TOTOTO TIME it is covered by a rainbow drum-skin.
 */
export function drawPit(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const w = e.w;
  const md = PIT.mudDepth;
  place(ctx, f, e.x, GROUND_Y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const bottom = f.viewH - (GROUND_Y + f.oy) + 4;
  // hole (back wall)
  ctx.beginPath();
  ctx.moveTo(-4, -0.5);
  ctx.quadraticCurveTo(1, 0, 2, 7);
  ctx.lineTo(2, bottom);
  ctx.lineTo(w - 2, bottom);
  ctx.lineTo(w - 2, 7);
  ctx.quadraticCurveTo(w - 1, 0, w + 4, -0.5);
  ctx.closePath();
  ctx.fillStyle = PAL.mudDark;
  ctx.fill();
  // mud body
  const t = f.time;
  ctx.beginPath();
  ctx.moveTo(2, md + Math.sin(t * 2.2 + e.phase) * 1.2);
  const segs = Math.max(3, Math.ceil(w / 22));
  for (let i = 1; i <= segs; i++) {
    const px = 2 + ((w - 4) * i) / segs;
    const wave = Math.sin(t * 2.2 + e.phase + i * 1.3) * 1.6;
    ctx.lineTo(px, md + wave);
  }
  ctx.lineTo(w - 2, bottom);
  ctx.lineTo(2, bottom);
  ctx.closePath();
  ctx.fillStyle = PAL.mud;
  ctx.fill();
  // glossy streaks on the mud
  ctx.strokeStyle = MUD_LIGHT;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(10, md + 6);
  ctx.lineTo(10 + w * 0.22, md + 6);
  ctx.moveTo(w * 0.55, md + 12);
  ctx.lineTo(w * 0.55 + w * 0.16, md + 12);
  ctx.stroke();
  // depth shade
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = PAL.mudDark;
  ctx.fillRect(2, md + 22, w - 4, bottom - md - 22);
  ctx.globalAlpha = 1;
  // bubbles
  for (let i = 0; i < 3; i++) {
    const period = 1.4 + hash01(e.serial, 31, i) * 1.1;
    const u = ((t + hash01(e.serial, 37, i) * 5) % period) / period;
    const bx = 12 + (w - 24) * hash01(e.serial, 41, i);
    if (u < 0.75) {
      const br = 1 + (u / 0.75) * 4.5;
      ctx.beginPath();
      ctx.arc(bx, md - br * 0.6, br, Math.PI, 0);
      ctx.fillStyle = MUD_LIGHT;
      ctx.fill();
      ctx.strokeStyle = PAL.mudDark;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else {
      const pu = (u - 0.75) / 0.25;
      ctx.globalAlpha = 1 - pu;
      ctx.strokeStyle = MUD_LIGHT;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      oval(ctx, bx, md - 1, 5 + pu * 7, 1.6 + pu * 1.5, 0);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  // rescue ripples
  if (e.flag === 'rescued' && e.stateT < 1.2) {
    for (let j = 0; j < 2; j++) {
      const u = e.stateT / 1.2 - j * 0.25;
      if (u <= 0 || u >= 1) continue;
      ctx.globalAlpha = 1 - u;
      ctx.strokeStyle = MUD_LIGHT;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      oval(ctx, w / 2, md, 8 + u * w * 0.45, 2 + u * 3, 0);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // walls + lips outline
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-4, -0.5);
  ctx.quadraticCurveTo(1, 0, 2, 7);
  ctx.lineTo(2, bottom);
  ctx.moveTo(w + 4, -0.5);
  ctx.quadraticCurveTo(w - 1, 0, w - 2, 7);
  ctx.lineTo(w - 2, bottom);
  ctx.stroke();
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(2, md + Math.sin(t * 2.2 + e.phase) * 1.2);
  for (let i = 1; i <= segs; i++) {
    const px = 2 + ((w - 4) * i) / segs;
    const wave = Math.sin(t * 2.2 + e.phase + i * 1.3) * 1.6;
    ctx.lineTo(px, md + wave);
  }
  ctx.stroke();
  // lip caps (soil edge)
  ctx.fillStyle = f.groundBody;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(-1, 2, 2.6, bottom);
  ctx.fillRect(w - 1.6, 2, 2.6, bottom);
  ctx.globalAlpha = 1;

  // fever cover: rainbow drum-skin bridging the pit
  if (f.fever) {
    ctx.beginPath();
    ctx.moveTo(-8, -4);
    ctx.quadraticCurveTo(w / 2, 5, w + 8, -4);
    ctx.lineTo(w + 8, 6);
    ctx.quadraticCurveTo(w / 2, 15, -8, 6);
    ctx.closePath();
    inkFill(ctx, f, PAL.drumSkin, 1);
    ctx.save();
    ctx.clip();
    const sw = (w + 16) / CHAIN_HUES.length;
    const shift = f.reduced ? 0 : (t * 60) % sw;
    for (let i = -1; i < CHAIN_HUES.length + 1; i++) {
      ctx.fillStyle = CHAIN_HUES[(i + CHAIN_HUES.length) % CHAIN_HUES.length];
      ctx.fillRect(-8 + i * sw + shift, -8, sw + 0.5, 26);
    }
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = WHITE;
    ctx.fillRect(-8, -5, w + 16, 4);
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-8, -4);
    ctx.quadraticCurveTo(w / 2, 5, w + 8, -4);
    ctx.lineTo(w + 8, 6);
    ctx.quadraticCurveTo(w / 2, 15, -8, 6);
    ctx.closePath();
    ctx.stroke();
    // lacing pegs
    ctx.fillStyle = PAL.drumShell;
    ctx.beginPath();
    dot(ctx, -8, 1, 4);
    ctx.moveTo(w + 12, 1);
    dot(ctx, w + 8, 1, 4);
    ctx.fill();
    ctx.stroke();
  }
  // striped fence posts on both lips
  post(ctx, f, -16, 1);
  post(ctx, f, w + 8, 1);
}

/* ================================================================== */
/* Friendly props & collectibles                                       */
/* ================================================================== */

function melonHalf(ctx: CanvasRenderingContext2D, f: EntFrame, left: boolean, a: number): void {
  const rx = 20;
  const ry = 16.5;
  ctx.beginPath();
  if (left) ctx.ellipse(0, 0, rx, ry, 0, Math.PI / 2, (Math.PI * 3) / 2, false);
  else ctx.ellipse(0, 0, rx, ry, 0, -Math.PI / 2, Math.PI / 2, false);
  ctx.closePath();
  inkFill(ctx, f, PAL.melonRind, a);
  ctx.beginPath();
  if (left) ctx.ellipse(0, 0, rx * 0.72, ry * 0.8, 0, Math.PI / 2, (Math.PI * 3) / 2, false);
  else ctx.ellipse(0, 0, rx * 0.72, ry * 0.8, 0, -Math.PI / 2, Math.PI / 2, false);
  ctx.closePath();
  ctx.fillStyle = PAL.melonFlesh;
  ctx.fill();
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = PAL.melonSeed;
  const s = left ? -1 : 1;
  ctx.beginPath();
  oval(ctx, s * 6, -5, 1.3, 2, 0.3 * s);
  oval(ctx, s * 9, 3, 1.3, 2, -0.3 * s);
  oval(ctx, s * 4, 7, 1.3, 2, 0.2 * s);
  ctx.fill();
}

/** Melon 40 x 34 (whole or split halves; burst = nothing, fx did it). */
export function drawMelon(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const a = entityAlpha(e);
  if (a <= 0) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (e.flag === 'split') {
    const k = Math.min(1, e.stateT * 5);
    const d = 3 + k * 12;
    const r = k * 0.55;
    ctx.globalAlpha = a;
    place(ctx, f, e.x + 20 - d, e.y + 17.5 + k * 2);
    ctx.rotate(-r);
    melonHalf(ctx, f, true, a);
    place(ctx, f, e.x + 20 + d, e.y + 17.5 + k * 2);
    ctx.rotate(r);
    melonHalf(ctx, f, false, a);
    ctx.globalAlpha = 1;
    return;
  }
  place(ctx, f, e.x + 20, e.y + 17.5);
  const wob = Math.sin(f.time * 2 + e.phase) * 0.03;
  ctx.rotate(wob);
  const rx = 20;
  const ry = 16.5;
  ctx.beginPath();
  oval(ctx, 0, 0, rx, ry, 0);
  inkFill(ctx, f, PAL.melonRind, 1);
  ctx.strokeStyle = PAL.melonStripe;
  ctx.lineWidth = 3.6;
  ctx.beginPath();
  oval(ctx, 0, 0, rx * 0.22, ry - 1, 0);
  ctx.stroke();
  ctx.beginPath();
  oval(ctx, 0, 0, rx * 0.62, ry - 1, 0);
  ctx.stroke();
  undersidePath(ctx, 0, 0, rx, ry, 0.55, 0);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = PAL.melonStripe;
  ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  oval(ctx, -9, -8, 5, 2.4, -0.6);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  oval(ctx, 0, 0, rx, ry, 0);
  ctx.stroke();
  // stem curl + leaf
  ctx.strokeStyle = PAL.logBark;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(1, -ry + 1);
  ctx.quadraticCurveTo(2, -ry - 5, 6, -ry - 4);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(2, -ry - 1);
  ctx.quadraticCurveTo(-4, -ry - 9, -10, -ry - 3);
  ctx.quadraticCurveTo(-4, -ry, 2, -ry - 1);
  fillLine(ctx, PAL.mangoLeaf, 1.6);
}

function mangoShape(
  ctx: CanvasRenderingContext2D,
  s: number,
  fill: string,
  blush: string,
  ink: number,
): void {
  ctx.beginPath();
  oval(ctx, 0, 0, 9.6 * s, 8.1 * s, -0.55);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = blush;
  ctx.beginPath();
  oval(ctx, -3.5 * s, 4 * s, 7 * s, 5 * s, -0.5);
  ctx.fill();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  oval(ctx, -2.5 * s, -3.4 * s, 3.4 * s, 1.7 * s, -0.6);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = ink;
  ctx.beginPath();
  oval(ctx, 0, 0, 9.6 * s, 8.1 * s, -0.55);
  ctx.stroke();
  // leaf
  ctx.beginPath();
  ctx.moveTo(3.5 * s, -6.5 * s);
  ctx.quadraticCurveTo(7 * s, -15 * s, 14 * s, -11 * s);
  ctx.quadraticCurveTo(9 * s, -5.5 * s, 3.5 * s, -6.5 * s);
  ctx.fillStyle = PAL.mangoLeaf;
  ctx.fill();
  ctx.lineWidth = ink * 0.7;
  ctx.stroke();
}

/** Mango 18 u: warm yellow-orange, leaf, soft glow, occasional glint. */
export function drawMango(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2; // bob is applied by the sim (hitbox = drawn position)
  if (f.glow !== null) {
    place(ctx, f, cx, cy);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.22 + f.night * 0.18;
    ctx.drawImage(f.glow, -19, -19, 38, 38);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  place(ctx, f, cx, cy);
  ctx.lineJoin = 'round';
  mangoShape(ctx, 1, PAL.mango, MANGO_BLUSH, 2.6);
  const g = (e.age * 0.6 + e.phase) % 2.2;
  if (g < 0.3) {
    const u = g / 0.3;
    ctx.globalAlpha = Math.sin(u * Math.PI);
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    starPath(ctx, -5, -6, 5 * Math.sin(u * Math.PI) + 1, 1.2, 4, 0);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** Golden mango 26 u: brighter, pulsing glow sprite (lighter), orbiting sparkles. */
export function drawGolden(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2; // bob is applied by the sim (hitbox = drawn position)
  const pulse = 0.5 + 0.5 * Math.sin(f.time * 4 + e.phase);
  place(ctx, f, cx, cy);
  if (f.glow !== null) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 + 0.3 * pulse;
    const gs = 84 + pulse * 16;
    ctx.drawImage(f.glow, -gs / 2, -gs / 2, gs, gs);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  // rays
  ctx.save();
  ctx.rotate(f.time * 0.8);
  ctx.globalAlpha = 0.35 + 0.2 * pulse;
  ctx.fillStyle = PAL.goldenGlow;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a0 = (i * TAU) / 8;
    ctx.moveTo(Math.cos(a0 - 0.12) * 17, Math.sin(a0 - 0.12) * 17);
    ctx.lineTo(Math.cos(a0) * (30 + pulse * 5), Math.sin(a0) * (30 + pulse * 5));
    ctx.lineTo(Math.cos(a0 + 0.12) * 17, Math.sin(a0 + 0.12) * 17);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'round';
  mangoShape(ctx, 1.42, PAL.golden, GOLD_BLUSH, 3);
  // orbiting sparkles
  for (let i = 0; i < 2; i++) {
    const a0 = f.time * 2.4 + i * Math.PI + e.phase;
    const sx = Math.cos(a0) * 21;
    const sy = Math.sin(a0) * 13;
    const tw = 0.6 + 0.4 * Math.sin(f.time * 9 + i * 2);
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    starPath(ctx, sx, sy, 4.6 * tw + 1.2, 1.2, 4, 0);
    ctx.fill();
  }
}

/** Soap-bubble pickup (Mud Coat / Fruit Magnet). */
export function drawPickup(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity, magnet: boolean): void {
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2; // bob is applied by the sim (hitbox = drawn position)
  const R = e.w / 2;
  if (e.flag === 'popped') {
    if (e.stateT > 0.25) return;
    const u = e.stateT / 0.25;
    place(ctx, f, cx, cy);
    ctx.globalAlpha = 1 - u;
    ctx.strokeStyle = PAL.bubbleRim;
    ctx.lineWidth = 3 * (1 - u) + 0.5;
    ctx.beginPath();
    dot(ctx, 0, 0, R * (1 + u * 0.8));
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  const t = f.time + e.phase;
  const wx = 1 + Math.sin(t * 3.1) * 0.035;
  const wy = 1 - Math.sin(t * 3.1) * 0.035;
  place(ctx, f, cx, cy);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // inner glow so the film reads on a pale noon sky
  ctx.beginPath();
  dot(ctx, 0, 0, R);
  ctx.fillStyle = BUBBLE_TINT;
  ctx.fill();
  // icon
  ctx.save();
  ctx.translate(0, 1);
  ctx.scale(1.3, 1.3);
  if (!magnet) {
    // Mud Coat: a muddy shield with drips
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.quadraticCurveTo(7, -8, 10, -9);
    ctx.quadraticCurveTo(11, 3, 0, 11);
    ctx.quadraticCurveTo(-11, 3, -10, -9);
    ctx.quadraticCurveTo(-7, -8, 0, -11);
    ctx.closePath();
    fillLine(ctx, PAL.mudCoat, 2.4);
    ctx.fillStyle = SHIELD_HI;
    ctx.beginPath();
    oval(ctx, -3.5, -4, 3.2, 2, -0.4);
    ctx.fill();
    ctx.fillStyle = PAL.mudCoatDark;
    ctx.beginPath();
    dot(ctx, 4, 2, 2);
    dot(ctx, -2, 5, 1.4);
    ctx.fill();
    const d = 2 + Math.sin(t * 2.3) * 1.5;
    ctx.beginPath();
    oval(ctx, -5, 8 + d, 1.8, 2.6 + d * 0.3, 0);
    ctx.fillStyle = PAL.mudCoat;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else {
    // Fruit Magnet: two crossed drum-sticks
    for (let s = -1; s <= 1; s += 2) {
      ctx.save();
      ctx.rotate(s * 0.62);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5.6;
      ctx.beginPath();
      ctx.moveTo(0, 11);
      ctx.lineTo(0, -6);
      ctx.stroke();
      ctx.strokeStyle = WOOD;
      ctx.lineWidth = 2.8;
      ctx.stroke();
      ctx.beginPath();
      dot(ctx, 0, -8, 4);
      fillLine(ctx, WOOD_HEAD, 2);
      ctx.restore();
    }
    ctx.fillStyle = PAL.mango;
    ctx.beginPath();
    dot(ctx, 0, 4, 3.4);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  ctx.restore();
  // bubble film
  ctx.scale(wx, wy);
  ctx.beginPath();
  dot(ctx, 0, 0, R);
  ctx.fillStyle = PAL.bubble;
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PAL.bubbleRim;
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 5;
  ctx.beginPath();
  dot(ctx, 0, 0, R - 4);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 2;
  ctx.strokeStyle = IRIS_PINK;
  ctx.beginPath();
  ctx.arc(0, 0, R - 3, 0.2 + t * 0.4, 1.3 + t * 0.4);
  ctx.stroke();
  ctx.strokeStyle = IRIS_CYAN;
  ctx.beginPath();
  ctx.arc(0, 0, R - 3, 2.6 + t * 0.4, 3.5 + t * 0.4);
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, R - 5, Math.PI * 1.12, Math.PI * 1.45);
  ctx.stroke();
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  dot(ctx, R * 0.42, -R * 0.5, 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** Best-score pennant planted at bestDist. */
export function drawBestFlag(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const poleH = GROUND_Y - e.y;
  const passed = e.flag === 'passed';
  place(ctx, f, e.x, GROUND_Y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // little dirt mound
  ctx.beginPath();
  ctx.ellipse(0, 1, 11, 5, 0, Math.PI, 0);
  ctx.closePath();
  fillLine(ctx, PAL.drumShellDark, 2.4);
  // pole
  ctx.beginPath();
  rrect(ctx, -2.5, -poleH, 5, poleH, 2.5);
  inkFill(ctx, f, PAL.flagPole, 1);
  // swallowtail banner
  const speed = passed ? 13 : 5;
  const amp = passed ? 4.5 : 2.6;
  const t = f.time;
  const pw = BEST_FLAG.pennantW + 10;
  const ph = BEST_FLAG.pennantH;
  const top = -poleH + 3;
  ctx.beginPath();
  ctx.moveTo(2, top);
  for (let i = 1; i <= 6; i++) {
    const u = i / 6;
    ctx.lineTo(2 + u * pw, top + Math.sin(t * speed - u * 5) * amp * u);
  }
  const wEnd = Math.sin(t * speed - 5) * amp;
  ctx.lineTo(2 + pw - 9, top + ph / 2 + Math.sin(t * speed - 4.2) * amp * 0.9);
  ctx.lineTo(2 + pw, top + ph + wEnd);
  for (let i = 5; i >= 0; i--) {
    const u = i / 6;
    ctx.lineTo(2 + u * pw, top + ph + Math.sin(t * speed - u * 5) * amp * u);
  }
  ctx.closePath();
  inkFill(ctx, f, PAL.flagPole, 1);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = FLAG_STRIPE;
  ctx.fillRect(2, top - 10, 8, ph + 20);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();
  // star emblem + label
  const wy = Math.sin(t * speed - 1.8) * amp * 0.35;
  ctx.beginPath();
  starPath(ctx, 17, top + ph / 2 + wy, 5.2, 2.2, 5, 0);
  fillLine(ctx, PAL.golden, 1.5);
  ctx.font = FLAG_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.fillText('BEST', 24, top + ph / 2 + wy + 0.5);
  // finial
  ctx.beginPath();
  dot(ctx, 0, -poleH - 3, 5);
  fillLine(ctx, PAL.golden, 2.2);
  if (passed && e.stateT < 3) {
    const tw = Math.sin(t * 12) * 0.5 + 0.5;
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    starPath(ctx, 6, -poleH - 10, 5 + tw * 4, 1.4, 4, t);
    ctx.fill();
  }
}

/** "!" bubble at the right screen edge while a log is about to roll in (warnT > 0). */
export function drawLogWarning(ctx: CanvasRenderingContext2D, f: EntFrame, e: REntity): void {
  const sx = e.x - f.camX;
  if (sx < f.viewW - 10) return;
  const show = 0.6 - e.warnT;
  const pop = show < 0.12 ? show / 0.12 : 1;
  const x = f.viewW - f.safeR - 30;
  const y = e.y + e.h / 2 + f.oy - 30;
  const pulse = f.reduced ? 1 : 1 + Math.sin(f.time * 22) * 0.08;
  const s = pop * pulse * (pop < 1 ? 1.15 : 1);
  ctx.setTransform(f.K * s, 0, 0, f.K * s, f.PX + x * f.K, y * f.K);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  rrect(ctx, -18, -18, 34, 34, 10);
  ctx.moveTo(12, 6);
  ctx.lineTo(24, 18);
  ctx.lineTo(4, 14);
  ctx.closePath();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.fillStyle = WHITE;
  ctx.fill();
  ctx.font = WARN_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = WARN_RED;
  ctx.fillText('!', -1, 0);
  // rumble ticks under the bubble
  if (!f.reduced) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    const j = Math.sin(f.time * 40) * 1.5;
    ctx.beginPath();
    ctx.moveTo(-14 + j, 30);
    ctx.lineTo(-8 + j, 30);
    ctx.moveTo(-2 - j, 33);
    ctx.lineTo(4 - j, 33);
    ctx.stroke();
  }
}

/** Title-screen drum (cosmetic, when gameplay has not spawned a real one under Toto). */
export function drawTitleDrum(ctx: CanvasRenderingContext2D, f: EntFrame, x: number, hitT: number): void {
  place(ctx, f, x, GROUND_Y - DRUM.h);
  titleDrum.hitT = hitT;
  drumBody(ctx, f, titleDrum, 1);
}

/** Scratch entity for the title drum (module-level scratch: hitT is rewritten before every use). */
const titleDrum: Entity = {
  active: true,
  kind: 'drum',
  serial: 0,
  x: 0,
  y: 0,
  w: DRUM.w,
  h: DRUM.h,
  vx: 0,
  vy: 0,
  baseY: 0,
  phase: 0,
  age: 0,
  hitT: 99,
  hue: -1,
  rot: 0,
  flag: 'none',
  stateT: 0,
  hazard: false,
  stompable: true,
  optional: false,
  warnT: 0,
  nearMin: 1e9,
  nearDone: false,
  template: '',
  lane: false,
};
