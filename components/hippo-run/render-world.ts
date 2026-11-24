/**
 * Background + ground layers (spec §9): sun/moon arc, stars, clouds, distant festival kites,
 * far mesas (0.10), hills (sum of 3 sines, 0.25), acacias / rocks / the odd giraffe (0.50),
 * gameplay ground (1.0; its deep soil carries low-contrast roots, pebbles, fossils and critter
 * burrows for portrait phones), foreground tufts (1.3, 60% alpha), night fireflies. Owner: ART engineer.
 *
 * Decoration is a pure function of (tile index, layer salt) via rng.hash01 — deterministic,
 * infinite, zero storage. Background layers carry no outline. Colours come from the precomputed
 * phase tables (render-util) indexed by the quantised blend key, so nothing here allocates.
 */
import { CHAIN_HUES, GEN, GROUND_Y, NIGHT, PAL, PARALLAX, PHASES } from './config';
import type { DeepReadonly, Entity } from './types';
import type { PhaseTable } from './render-util';
import { dot, oval, pmod } from './render-util';
import { hash01 } from './rng';

/** Per-frame inputs for the background (filled by render.ts). */
export interface BgFrame {
  K: number;
  PX: number;
  viewW: number;
  viewH: number;
  /** view.offsetY (no shake). */
  offY: number;
  /** Interpolated camera x (no shake). */
  camX: number;
  shakeX: number;
  shakeY: number;
  /** Phase colour table key. */
  key: number;
  /** Distance (m) driving the sun/moon clock. */
  distM: number;
  time: number;
  night: number;
  dusk: number;
  lowQ: boolean;
  /** TOTOTO TIME beat pulse 0..1 on the ground's top stripe (0 outside fever / reduced motion). */
  feverPulse: number;
  glow: HTMLCanvasElement | null;
  glowCool: HTMLCanvasElement | null;
}

export function makeBgFrame(): BgFrame {
  return {
    K: 1,
    PX: 0,
    viewW: 760,
    viewH: 540,
    offY: 0,
    camX: 0,
    shakeX: 0,
    shakeY: 0,
    key: 0,
    distM: 0,
    time: 0,
    night: 0,
    dusk: 0,
    lowQ: false,
    feverPulse: 0,
    glow: null,
    glowCool: null,
  };
}

const FEVER_STRIPE = '#FFFFFF';

const SALT_MESA = 11;
const SALT_TREE = 23;
const SALT_ROCK = 29;
const SALT_TUFT = 37;
const SALT_CLOUD = 43;
const SALT_KITE = 53;
const SALT_STAR = 61;
const SALT_FLY = 67;
const SALT_SPECK = 71;
const SALT_SOIL = 79;
const SALT_ROOT = 83;

/* Deep-soil decoration (scroll 1.0, portrait shows a lot of soil): one item per tile and slot. */
const SOIL_TILE = 130;
/** Soil depth (u) per stacked slot of items: landscape gets one row, portrait phones three. */
const SOIL_SLOT_H = 170;
/** Items start this far below the trail and stop this far above the view's bottom edge. */
const SOIL_TOP = 44;
const SOIL_BOTTOM = 16;
const SOIL_PEBBLES = 1;
const SOIL_BONE = 2;
const SOIL_SHELL = 3;
/** Top slot only. */
const SOIL_BURROW = 4;
/** Low-contrast: decoration never competes with gameplay. */
const SOIL_DARK_A = 0.32;
const SOIL_PALE_A = 0.3;
const SOIL_STONE_A = 0.55;
const SOIL_EYE_A = 0.7;

const KITE_COLORS: ReadonlyArray<string> = CHAIN_HUES;
const SUN_CORE = '#FFF7D6';
const MOON_CRATER = '#E9DEC0';
const FIREFLY_CORE = PAL.firefly;
const STAR_COLOR = PAL.star;

/** Base logical transform with an x/y shift (parallax layers). */
function base(ctx: CanvasRenderingContext2D, b: BgFrame, dx: number, dy: number): void {
  ctx.setTransform(b.K, 0, 0, b.K, b.PX + dx * b.K, dy * b.K);
}

/* ------------------------------------------------------------------ */
/* Sky dwellers                                                         */
/* ------------------------------------------------------------------ */

export function drawStars(ctx: CanvasRenderingContext2D, b: BgFrame): void {
  if (b.night < 0.02) return;
  const horizon = GROUND_Y + b.offY;
  base(ctx, b, 0, 0);
  ctx.fillStyle = STAR_COLOR;
  const n = b.lowQ ? NIGHT.stars >> 1 : NIGHT.stars;
  const W = b.viewW + 40;
  for (let i = 0; i < n; i++) {
    const hx = hash01(i, SALT_STAR, 0);
    const hy = hash01(i, SALT_STAR, 1);
    const hs = hash01(i, SALT_STAR, 2);
    const x = pmod(hx * W - b.camX * 0.01, W) - 20;
    const y = 12 + hy * hy * (horizon - 130);
    const tw = 0.55 + 0.45 * Math.sin(b.time * (1.2 + hs * 2.6) + hs * 40);
    ctx.globalAlpha = b.night * tw;
    const r = 0.9 + hs * 1.5;
    if (hs > 0.78) {
      // sparkle star
      ctx.beginPath();
      ctx.moveTo(x, y - r * 2.6);
      ctx.lineTo(x + r * 0.55, y - r * 0.55);
      ctx.lineTo(x + r * 2.6, y);
      ctx.lineTo(x + r * 0.55, y + r * 0.55);
      ctx.lineTo(x, y + r * 2.6);
      ctx.lineTo(x - r * 0.55, y + r * 0.55);
      ctx.lineTo(x - r * 2.6, y);
      ctx.lineTo(x - r * 0.55, y - r * 0.55);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      dot(ctx, x, y, r);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Sun (dawn -> dusk) and moon (night) arcing across the sky with the day clock. */
export function drawSunMoon(ctx: CanvasRenderingContext2D, b: BgFrame): void {
  const horizon = GROUND_Y + b.offY;
  const arcH = Math.min(horizon - 70, 330);
  const day = pmod(b.distM, 1000);
  // The arc itself is the sun/moon parallax: ~0.8 viewW of travel per 780 m ~= the spec's 0.02.
  // Sun: rises at -80 m, sets at 700 m of each day.
  const sd = day > 900 ? day - 1000 : day;
  const sp = (sd + 80) / 780;
  const sunA = 1 - b.night;
  if (sp > 0 && sp < 1 && sunA > 0.01) {
    const x = b.viewW * (0.1 + 0.8 * sp);
    const y = horizon - Math.sin(sp * Math.PI) * arcH + 18;
    const low = 1 - Math.sin(sp * Math.PI);
    base(ctx, b, 0, 0);
    if (b.glow !== null) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = sunA * (0.35 + 0.3 * low);
      const gs = 260 + 120 * low;
      ctx.drawImage(b.glow, x - gs / 2, y - gs / 2, gs, gs);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = sunA;
    ctx.fillStyle = PAL.sun;
    ctx.beginPath();
    dot(ctx, x, y, 30);
    ctx.fill();
    ctx.fillStyle = SUN_CORE;
    ctx.beginPath();
    dot(ctx, x - 3, y - 3, 23);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Moon: rises at 680 m, sets at 1080 m.
  const md = day < 100 ? day + 1000 : day;
  const mp = (md - 680) / 400;
  const moonA = b.night > 0.7 ? 1 : b.night / 0.7;
  if (mp > 0 && mp < 1 && moonA > 0.01) {
    const x = b.viewW * (0.12 + 0.76 * mp);
    const y = horizon - Math.sin(mp * Math.PI) * arcH * 0.9 + 14;
    base(ctx, b, 0, 0);
    if (b.glowCool !== null) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = moonA * 0.35;
      ctx.drawImage(b.glowCool, x - 90, y - 90, 180, 180);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = moonA;
    ctx.fillStyle = PAL.moon;
    ctx.beginPath();
    dot(ctx, x, y, 22);
    ctx.fill();
    ctx.fillStyle = MOON_CRATER;
    ctx.beginPath();
    dot(ctx, x - 7, y - 5, 5);
    dot(ctx, x + 6, y + 7, 3.6);
    dot(ctx, x + 8, y - 8, 2.4);
    dot(ctx, x - 4, y + 10, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export function drawClouds(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable): void {
  const horizon = GROUND_Y + b.offY;
  const f = 0.05;
  const tile = 560;
  const lx = b.camX * f + b.time * 4;
  const i0 = Math.floor((lx - 200) / tile);
  const i1 = Math.floor((lx + b.viewW + 200) / tile);
  const a = 1 - b.night * 0.55;
  for (let i = i0; i <= i1; i++) {
    if (hash01(i, SALT_CLOUD, 0) > 0.72) continue;
    const s = 0.6 + hash01(i, SALT_CLOUD, 2) * 0.7;
    const x = i * tile + hash01(i, SALT_CLOUD, 1) * 300 - lx;
    const span = horizon - 260 > 0 ? Math.min(horizon - 260, 640) : 0;
    const y = horizon - 210 - hash01(i, SALT_CLOUD, 3) * span;
    base(ctx, b, x, y);
    ctx.globalAlpha = a * 0.92;
    ctx.fillStyle = t.cloud[b.key];
    ctx.beginPath();
    dot(ctx, 0, 0, 22 * s);
    ctx.moveTo(30 * s + 28 * s, 2 * s);
    dot(ctx, 30 * s, 2 * s, 28 * s);
    ctx.moveTo(62 * s + 20 * s, 6 * s);
    dot(ctx, 62 * s, 6 * s, 20 * s);
    ctx.moveTo(-20 * s + 14 * s, 10 * s);
    dot(ctx, -20 * s, 10 * s, 14 * s);
    ctx.rect(-26 * s, 10 * s, 104 * s, 16 * s);
    ctx.fill();
    ctx.fillStyle = t.cloudShade[b.key];
    ctx.beginPath();
    oval(ctx, 28 * s, 22 * s, 52 * s, 5 * s, 0);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Tiny festival kites far away (charm; fade out at night). */
export function drawFarKites(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable): void {
  const a = (1 - b.night) * 0.75;
  if (a < 0.02) return;
  const horizon = GROUND_Y + b.offY;
  const f = 0.12;
  const tile = 620;
  const lx = b.camX * f;
  const i0 = Math.floor((lx - 100) / tile);
  const i1 = Math.floor((lx + b.viewW + 100) / tile);
  for (let i = i0; i <= i1; i++) {
    if (hash01(i, SALT_KITE, 0) > 0.5) continue;
    const x = i * tile + hash01(i, SALT_KITE, 1) * 400 - lx + Math.sin(b.time * 0.8 + i) * 6;
    const y = horizon - 170 - hash01(i, SALT_KITE, 2) * 110 + Math.sin(b.time * 1.1 + i * 2) * 5;
    const s = 0.7 + hash01(i, SALT_KITE, 3) * 0.5;
    const col = KITE_COLORS[Math.floor(hash01(i, SALT_KITE, 4) * KITE_COLORS.length) % KITE_COLORS.length];
    base(ctx, b, x, y);
    ctx.globalAlpha = a * 0.5;
    ctx.strokeStyle = t.trees[b.key];
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(0, 10 * s);
    ctx.quadraticCurveTo(-30, 80, -70 - hash01(i, SALT_KITE, 5) * 60, horizon - y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 10 * s);
    for (let j = 1; j <= 4; j++) ctx.lineTo(-j * 4 * s, 10 * s + j * 4 * s + Math.sin(b.time * 4 + j + i) * 2);
    ctx.stroke();
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, -10 * s);
    ctx.lineTo(7 * s, -1 * s);
    ctx.lineTo(0, 10 * s);
    ctx.lineTo(-7 * s, -1 * s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------ */
/* Landscape                                                            */
/* ------------------------------------------------------------------ */

export function drawMesas(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable): void {
  const horizon = GROUND_Y + b.offY + b.shakeY * PARALLAX.mesas;
  const f = PARALLAX.mesas;
  const tile = PARALLAX.tileMesa;
  const lx = b.camX * f + b.shakeX * f;
  const i0 = Math.floor((lx - 340) / tile);
  const i1 = Math.floor((lx + b.viewW + 40) / tile);
  base(ctx, b, -lx, 0);
  for (let pass = 0; pass < 2; pass++) {
    ctx.fillStyle = pass === 0 ? t.mesa[b.key] : t.mesaShade[b.key];
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const n = hash01(i, SALT_MESA, 0) < 0.45 ? 2 : 1;
      for (let m = 0; m < n; m++) {
        const ch = m * 5;
        const x0 = i * tile + hash01(i, SALT_MESA, 1 + ch) * (m === 0 ? 220 : 160) + m * 250;
        const w = 120 + hash01(i, SALT_MESA, 2 + ch) * 170;
        const h = 42 + hash01(i, SALT_MESA, 3 + ch) * 82;
        const shoulder = hash01(i, SALT_MESA, 4 + ch);
        const top = horizon - h;
        const x1 = x0 + w;
        if (pass === 0) {
          ctx.moveTo(x0 - 26, horizon + 10);
          if (shoulder < 0.5) {
            ctx.lineTo(x0 - 20, horizon - h * 0.45);
            ctx.lineTo(x0 + 6, horizon - h * 0.48);
            ctx.lineTo(x0 + 12, top + 6);
          } else {
            ctx.lineTo(x0 + 4, top + 10);
          }
          ctx.lineTo(x0 + 14, top);
          ctx.lineTo(x1 - 16, top);
          ctx.lineTo(x1 - 8, top + 10);
          ctx.lineTo(x1 + 22, horizon + 10);
          ctx.closePath();
        } else {
          // shaded right face + strata line
          ctx.moveTo(x1 - 34, top);
          ctx.lineTo(x1 - 16, top);
          ctx.lineTo(x1 - 8, top + 10);
          ctx.lineTo(x1 + 22, horizon + 10);
          ctx.lineTo(x1 - 18, horizon + 10);
          ctx.closePath();
          ctx.rect(x0 + 10, top + h * 0.38, w - 30, 3);
        }
      }
    }
    ctx.fill();
  }
  // lit rim on the flat tops
  ctx.fillStyle = t.mesaLight[b.key];
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const n = hash01(i, SALT_MESA, 0) < 0.45 ? 2 : 1;
    for (let m = 0; m < n; m++) {
      const ch = m * 5;
      const x0 = i * tile + hash01(i, SALT_MESA, 1 + ch) * (m === 0 ? 220 : 160) + m * 250;
      const w = 120 + hash01(i, SALT_MESA, 2 + ch) * 170;
      const h = 42 + hash01(i, SALT_MESA, 3 + ch) * 82;
      ctx.rect(x0 + 14, horizon - h, w - 52, 3);
    }
  }
  ctx.fill();
}

function hillY(X: number): number {
  return 46 + 18 * Math.sin(X * 0.0042 + 1.3) + 11 * Math.sin(X * 0.0117 + 0.4) + 5 * Math.sin(X * 0.031 + 2.2);
}

export function drawHills(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable): void {
  const f = PARALLAX.hills;
  const horizon = GROUND_Y + b.offY + b.shakeY * f;
  const lx = b.camX * f + b.shakeX * f;
  const step = PARALLAX.hillSampleU;
  const sx0 = -step - pmod(lx, step);
  base(ctx, b, 0, 0);
  ctx.fillStyle = t.hills[b.key];
  ctx.beginPath();
  ctx.moveTo(sx0, horizon + 12);
  for (let sx = sx0; sx <= b.viewW + step; sx += step) ctx.lineTo(sx, horizon - hillY(sx + lx));
  ctx.lineTo(b.viewW + step, horizon + 12);
  ctx.closePath();
  ctx.fill();
  // lower shading band (same curve, dropped) gives the hills some form
  ctx.fillStyle = t.hillsShade[b.key];
  ctx.beginPath();
  ctx.moveTo(sx0, horizon + 12);
  for (let sx = sx0; sx <= b.viewW + step; sx += step) {
    const X = sx + lx;
    ctx.lineTo(sx, horizon - 14 - 9 * Math.sin(X * 0.0071 + 2.6) - 5 * Math.sin(X * 0.019 + 0.7));
  }
  ctx.lineTo(b.viewW + step, horizon + 12);
  ctx.closePath();
  ctx.fill();
}

function acacia(ctx: CanvasRenderingContext2D, x: number, g: number, s: number, H: number, lean: number): void {
  const topY = g - H;
  ctx.lineCap = 'round';
  ctx.lineWidth = 5 * s;
  ctx.beginPath();
  ctx.moveTo(x, g + 4);
  ctx.quadraticCurveTo(x + lean * 0.3, g - H * 0.35, x + lean * 0.55, g - H * 0.55);
  ctx.lineTo(x - 18 * s, topY + 12 * s);
  ctx.moveTo(x + lean * 0.55, g - H * 0.55);
  ctx.lineTo(x + 22 * s + lean * 0.4, topY + 10 * s);
  ctx.moveTo(x + lean * 0.55, g - H * 0.6);
  ctx.lineTo(x + lean * 0.3, topY + 8 * s);
  ctx.stroke();
  const cx = x + lean * 0.35;
  const cy = topY + 6 * s;
  ctx.beginPath();
  oval(ctx, cx - 24 * s, cy + 2 * s, 22 * s, 8 * s, -0.05);
  ctx.moveTo(cx + 32 * s, cy - 3 * s);
  oval(ctx, cx + 2 * s, cy - 3 * s, 30 * s, 10 * s, 0);
  ctx.moveTo(cx + 46 * s, cy + 2 * s);
  oval(ctx, cx + 26 * s, cy + 2 * s, 20 * s, 7.5 * s, 0.05);
  ctx.rect(cx - 42 * s, cy + 1 * s, 86 * s, 5 * s);
  ctx.fill();
}

function giraffe(ctx: CanvasRenderingContext2D, x: number, g: number, s: number, time: number): void {
  const nod = Math.sin(time * 0.9 + x * 0.01) * 0.06;
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.4 * s;
  ctx.beginPath();
  // legs
  ctx.moveTo(x - 12 * s, g + 2);
  ctx.lineTo(x - 11 * s, g - 26 * s);
  ctx.moveTo(x - 6 * s, g + 2);
  ctx.lineTo(x - 6 * s, g - 26 * s);
  ctx.moveTo(x + 8 * s, g + 2);
  ctx.lineTo(x + 8 * s, g - 27 * s);
  ctx.moveTo(x + 13 * s, g + 2);
  ctx.lineTo(x + 12 * s, g - 27 * s);
  ctx.stroke();
  // neck
  ctx.lineWidth = 6 * s;
  ctx.beginPath();
  const nx = x + 12 * s;
  const ny = g - 34 * s;
  const hx = nx + 10 * s + nod * 40 * s;
  const hy = ny - 34 * s;
  ctx.moveTo(nx, ny);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  // body + head
  ctx.beginPath();
  oval(ctx, x, g - 32 * s, 18 * s, 8 * s, -0.12);
  ctx.moveTo(hx + 9 * s, hy + 1 * s);
  oval(ctx, hx + 3 * s, hy + 1 * s, 7 * s, 3.6 * s, 0.25);
  ctx.fill();
  ctx.lineWidth = 1.8 * s;
  ctx.beginPath();
  ctx.moveTo(hx - 1 * s, hy - 2 * s);
  ctx.lineTo(hx - 2 * s, hy - 7 * s);
  ctx.moveTo(hx + 2 * s, hy - 2 * s);
  ctx.lineTo(hx + 2 * s, hy - 7 * s);
  ctx.moveTo(x - 17 * s, g - 33 * s);
  ctx.lineTo(x - 22 * s, g - 22 * s);
  ctx.stroke();
}

export function drawTrees(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable): void {
  const f = PARALLAX.trees;
  const g = GROUND_Y + b.offY + b.shakeY * f;
  const lx = b.camX * f + b.shakeX * f;
  base(ctx, b, -lx, 0);
  const col = t.trees[b.key];
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  // rocks
  const rt = PARALLAX.tileRock;
  const r0 = Math.floor((lx - 60) / rt);
  const r1 = Math.floor((lx + b.viewW + 60) / rt);
  ctx.fillStyle = t.hillsShade[b.key];
  ctx.beginPath();
  for (let i = r0; i <= r1; i++) {
    if (hash01(i, SALT_ROCK, 0) > 0.4) continue;
    const x = i * rt + hash01(i, SALT_ROCK, 1) * 120;
    const rw = 9 + hash01(i, SALT_ROCK, 2) * 14;
    const rh = 6 + hash01(i, SALT_ROCK, 3) * 9;
    ctx.moveTo(x + rw, g + 2);
    ctx.ellipse(x, g + 2, rw, rh, 0, Math.PI, 0);
    ctx.moveTo(x + rw * 1.4 + rw * 0.55, g + 2);
    ctx.ellipse(x + rw * 1.4, g + 2, rw * 0.55, rh * 0.6, 0, Math.PI, 0);
  }
  ctx.fill();
  ctx.fillStyle = col;
  // acacias + the odd giraffe
  const tt = PARALLAX.tileTree;
  const i0 = Math.floor((lx - 120) / tt);
  const i1 = Math.floor((lx + b.viewW + 120) / tt);
  for (let i = i0; i <= i1; i++) {
    const h0 = hash01(i, SALT_TREE, 0);
    const x = i * tt + hash01(i, SALT_TREE, 1) * 170;
    const s = 0.7 + hash01(i, SALT_TREE, 2) * 0.55;
    if (h0 < 0.58) {
      const H = (78 + hash01(i, SALT_TREE, 3) * 40) * s;
      const lean = (hash01(i, SALT_TREE, 4) - 0.5) * 22 * s;
      acacia(ctx, x, g, s, H, lean);
    } else if (h0 < 0.65) {
      giraffe(ctx, x, g, 1.05 + s * 0.3, b.time);
    } else if (h0 < 0.8) {
      // low shrub
      ctx.beginPath();
      ctx.ellipse(x, g, 16 * s, 9 * s, 0, Math.PI, 0);
      ctx.moveTo(x + 14 * s + 10 * s, g);
      ctx.ellipse(x + 14 * s, g, 10 * s, 6 * s, 0, Math.PI, 0);
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gameplay ground + foreground                                         */
/* ------------------------------------------------------------------ */

export function drawGround(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable): void {
  const gy = GROUND_Y + b.offY + b.shakeY;
  const k = b.key;
  const lx = b.camX + b.shakeX;
  base(ctx, b, 0, 0);
  const W = b.viewW;
  const bottom = b.viewH + 4;
  ctx.fillStyle = t.groundBody[k];
  ctx.fillRect(-4, gy, W + 8, bottom - gy);
  ctx.fillStyle = t.groundTop[k];
  ctx.fillRect(-4, gy, W + 8, 13);
  if (b.feverPulse > 0.004) {
    // TOTOTO TIME: the trail's top stripe brightens up to 15% on every beat.
    ctx.globalAlpha = 0.15 * (b.feverPulse > 1 ? 1 : b.feverPulse);
    ctx.fillStyle = FEVER_STRIPE;
    ctx.fillRect(-4, gy, W + 8, 13);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = t.groundLight[k];
  ctx.fillRect(-4, gy, W + 8, 2.5);
  ctx.fillStyle = t.groundEdge[k];
  ctx.beginPath();
  // scalloped edge between the trail and the soil
  const sc = 24;
  const s0 = -sc - pmod(lx, sc);
  ctx.moveTo(s0, gy + 12);
  for (let x = s0; x <= W + sc; x += sc) {
    ctx.quadraticCurveTo(x + sc * 0.5, gy + 17, x + sc, gy + 12);
  }
  ctx.lineTo(W + sc, gy + 11);
  ctx.lineTo(s0, gy + 11);
  ctx.closePath();
  ctx.fill();
  // deeper soil darkens in bands (portrait shows a lot of it)
  ctx.fillStyle = t.groundDark[k];
  for (let band = 1; band < 8; band++) {
    const by = gy + 30 + band * 90;
    if (by > bottom) break;
    ctx.globalAlpha = band * 0.07 > 0.45 ? 0.45 : band * 0.07;
    ctx.fillRect(-4, by, W + 8, 90);
  }
  // strata
  ctx.strokeStyle = t.groundDark[k];
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  for (let row = 0; row < 24; row++) {
    const yy = gy + 40 + row * 42;
    if (yy > bottom) break;
    const st = 40;
    const x0 = -st - pmod(lx, st);
    for (let x = x0; x <= W + st; x += st) {
      const X = x + lx;
      const y = yy + Math.sin(X * 0.013 + row * 2.1) * 4;
      if (x === x0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // pebbles in the trail + specks in the soil
  const tile = 56;
  const i0 = Math.floor((lx - 20) / tile);
  const i1 = Math.floor((lx + W + 20) / tile);
  ctx.fillStyle = t.groundEdge[k];
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    if (hash01(i, SALT_SPECK, 0) > 0.55) continue;
    const x = i * tile + hash01(i, SALT_SPECK, 1) * tile - lx;
    const r = 1.6 + hash01(i, SALT_SPECK, 2) * 2.2;
    ctx.moveTo(x + r * 1.5, gy + 7);
    oval(ctx, x, gy + 7, r * 1.5, r, 0);
  }
  ctx.fill();
  ctx.fillStyle = t.groundDark[k];
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const hy = hash01(i, SALT_SPECK, 3);
    const x = i * tile + hash01(i, SALT_SPECK, 4) * tile - lx;
    const y = gy + 26 + hy * (bottom - gy - 34);
    const r = 1.5 + hash01(i, SALT_SPECK, 5) * 2.5;
    ctx.moveTo(x + r * 1.4, y);
    oval(ctx, x, y, r * 1.4, r, 0);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  drawSoilDecor(ctx, b, t, gy, lx);
}

/** Per-frame scratch for drawSoilDecor (module-level typed arrays: the frame path never allocates). */
const SOIL_MAX = 160;
/** kind, x, y, a, c per item. */
const soilBuf = new Float64Array(SOIL_MAX * 5);
const STONE_MAX = 200;
/** x, y, r, rot per pebble. */
const stoneBuf = new Float64Array(STONE_MAX * 4);

/**
 * Deep-soil decoration under the trail (scroll 1.0, so it reads as the same ground): hanging
 * roots, pebble clusters, fossil bones and ammonite shells, critter burrows (top slot, tunnel up
 * to the trail) with eyes that blink and now and then duck away. Pure function of (tile index,
 * slot, salt) via hash01, gathered once into scratch arrays and drawn in 8 batched paths at low
 * alpha in the phase's soil colours; pits are drawn on top and hide it.
 */
function drawSoilDecor(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable, gy: number, lx: number): void {
  const k = b.key;
  const depth = b.viewH - gy;
  if (depth < 40) return;
  const i0 = Math.floor((lx - 70) / SOIL_TILE);
  const i1 = Math.floor((lx + b.viewW + 70) / SOIL_TILE);
  const dark = t.groundDark[k];
  const pale = t.groundLight[k];
  const cap = ctx.lineCap;
  const join = ctx.lineJoin;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // roots hanging under the trail, each with one rootlet
  ctx.strokeStyle = dark;
  ctx.globalAlpha = SOIL_DARK_A + 0.08;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    if (hash01(i, SALT_ROOT, 0) > 0.42) continue;
    let len = 20 + hash01(i, SALT_ROOT, 1) * 30;
    if (len > depth - 34) len = depth - 34;
    if (len < 10) continue;
    const x = i * SOIL_TILE + hash01(i, SALT_ROOT, 2) * SOIL_TILE - lx;
    const bend = (hash01(i, SALT_ROOT, 3) - 0.5) * 16;
    const y0 = gy + 15;
    ctx.moveTo(x, y0);
    ctx.quadraticCurveTo(x + bend, y0 + len * 0.55, x + bend * 0.3, y0 + len);
    const side = bend > 0 ? -1 : 1;
    const mx = x + bend * 0.45;
    const my = y0 + len * 0.45;
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(mx + side * 6, my + 2, mx + side * 10, my + 9);
  }
  ctx.stroke();

  const top = gy + SOIL_TOP;
  const avail = b.viewH - SOIL_BOTTOM - top;
  if (avail >= 24) {
    let slots = Math.round(avail / SOIL_SLOT_H);
    if (slots < 1) slots = 1;
    const slotH = avail / slots;

    // Gather: one item per (tile, slot). Burrows only in the top slot (their tunnel climbs to the
    // trail); deeper slots get fossils in their place.
    let n = 0;
    let ns = 0;
    for (let i = i0; i <= i1 && n < SOIL_MAX; i++) {
      for (let s = 0; s < slots && n < SOIL_MAX; s++) {
        const id = i * 16 + s;
        const h0 = hash01(id, SALT_SOIL, 0);
        if (h0 >= 0.58) continue;
        let kind = SOIL_PEBBLES;
        if (h0 >= 0.49) kind = s === 0 ? SOIL_BURROW : h0 < 0.535 ? SOIL_BONE : SOIL_SHELL;
        else if (h0 >= 0.41) kind = SOIL_SHELL;
        else if (h0 >= 0.3) kind = SOIL_BONE;
        const x = i * SOIL_TILE + 24 + hash01(id, SALT_SOIL, 1) * (SOIL_TILE - 48) - lx;
        const y = top + s * slotH + 12 + hash01(id, SALT_SOIL, 2) * (slotH - 24);
        const a = hash01(id, SALT_SOIL, 3);
        const c = hash01(id, SALT_SOIL, 4);
        const o = n * 5;
        soilBuf[o] = kind;
        soilBuf[o + 1] = x;
        soilBuf[o + 2] = y;
        soilBuf[o + 3] = a;
        soilBuf[o + 4] = c;
        n++;
        if (kind !== SOIL_PEBBLES) continue;
        const m = 2 + Math.floor(a * 3);
        for (let j = 0; j < m && ns < STONE_MAX; j++) {
          const q = ns * 4;
          stoneBuf[q] = x + (j - (m - 1) * 0.5) * 12 + (hash01(id, SALT_SOIL, 9 + j) - 0.5) * 6;
          stoneBuf[q + 1] = y + (hash01(id, SALT_SOIL, 13 + j) - 0.5) * 8;
          stoneBuf[q + 2] = 3.5 + hash01(id, SALT_SOIL, 5 + j) * 4.5;
          stoneBuf[q + 3] = (c - 0.5) * 0.5;
          ns++;
        }
      }
    }

    // burrow tunnels: an S-curve from the chamber up to the underside of the trail
    const tunnelTop = gy + 18;
    ctx.lineWidth = 6.5;
    ctx.globalAlpha = SOIL_DARK_A * 0.8;
    ctx.beginPath();
    for (let e = 0; e < n * 5; e += 5) {
      if (soilBuf[e] !== SOIL_BURROW) continue;
      const x = soilBuf[e + 1];
      const y = soilBuf[e + 2];
      const dir = soilBuf[e + 3] < 0.5 ? -1 : 1;
      const ex = x + dir * (18 + soilBuf[e + 4] * 30);
      const rise = y - tunnelTop;
      ctx.moveTo(x + dir * 4, y);
      ctx.bezierCurveTo(x - dir * 16, y - rise * 0.5, ex + dir * 14, tunnelTop + rise * 0.45, ex, tunnelTop);
    }
    ctx.stroke();
    // burrow chambers
    ctx.fillStyle = dark;
    ctx.globalAlpha = SOIL_DARK_A + 0.2;
    ctx.beginPath();
    for (let e = 0; e < n * 5; e += 5) {
      if (soilBuf[e] === SOIL_BURROW) oval(ctx, soilBuf[e + 1], soilBuf[e + 2], 12, 8, 0);
    }
    ctx.fill();

    // pebble clusters (2-4 stones)
    ctx.fillStyle = t.groundEdge[k];
    ctx.globalAlpha = SOIL_STONE_A;
    ctx.beginPath();
    for (let q = 0; q < ns * 4; q += 4) {
      const r = stoneBuf[q + 2];
      oval(ctx, stoneBuf[q], stoneBuf[q + 1], r * 1.3, r * 0.85, stoneBuf[q + 3]);
    }
    ctx.fill();

    // pale: pebble highlights + fossil bones (one nonzero fill: overlaps never double the alpha)
    ctx.fillStyle = pale;
    ctx.globalAlpha = SOIL_PALE_A;
    ctx.beginPath();
    for (let q = 0; q < ns * 4; q += 4) {
      const r = stoneBuf[q + 2];
      oval(ctx, stoneBuf[q] - r * 0.35, stoneBuf[q + 1] - r * 0.3, r * 0.5, r * 0.28, -0.2);
    }
    for (let e = 0; e < n * 5; e += 5) {
      if (soilBuf[e] !== SOIL_BONE) continue;
      const ang = (soilBuf[e + 3] - 0.5) * 1.4;
      const half = 13 + soilBuf[e + 4] * 7;
      const cx = Math.cos(ang);
      const sy = Math.sin(ang);
      const hw = 2.2;
      const x1 = soilBuf[e + 1] - cx * half;
      const y1 = soilBuf[e + 2] - sy * half;
      const x2 = soilBuf[e + 1] + cx * half;
      const y2 = soilBuf[e + 2] + sy * half;
      // shaft wound the same way as arc() so the nonzero fill unions it with the knobs
      ctx.moveTo(x1 - sy * hw, y1 + cx * hw);
      ctx.lineTo(x1 + sy * hw, y1 - cx * hw);
      ctx.lineTo(x2 + sy * hw, y2 - cx * hw);
      ctx.lineTo(x2 - sy * hw, y2 + cx * hw);
      ctx.closePath();
      dot(ctx, x1 - sy * 2.8 - cx * 1.5, y1 + cx * 2.8 - sy * 1.5, 3.3);
      dot(ctx, x1 + sy * 2.8 - cx * 1.5, y1 - cx * 2.8 - sy * 1.5, 3.3);
      dot(ctx, x2 - sy * 2.8 + cx * 1.5, y2 + cx * 2.8 + sy * 1.5, 3.3);
      dot(ctx, x2 + sy * 2.8 + cx * 1.5, y2 - cx * 2.8 + sy * 1.5, 3.3);
    }
    ctx.fill();

    // ammonite shells: ring + inward spiral
    ctx.strokeStyle = pale;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let e = 0; e < n * 5; e += 5) {
      if (soilBuf[e] !== SOIL_SHELL) continue;
      const x = soilBuf[e + 1];
      const y = soilBuf[e + 2];
      const R = 9 + soilBuf[e + 4] * 5;
      const rot = soilBuf[e + 3] * 6.283;
      dot(ctx, x, y, R);
      for (let q = 0; q <= 20; q++) {
        const u = q / 20;
        const ang = rot + u * 11;
        const r = R * (0.92 - u * 0.78);
        if (q === 0) ctx.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
        else ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
      }
    }
    ctx.stroke();

    // critters peeking out of their burrows (blink every few seconds, duck away now and then)
    ctx.globalAlpha = SOIL_EYE_A;
    ctx.beginPath();
    for (let e = 0; e < n * 5; e += 5) {
      if (soilBuf[e] !== SOIL_BURROW) continue;
      const a = soilBuf[e + 3];
      const tt = b.time + soilBuf[e + 4] * 17;
      if (Math.sin(tt * 0.45 + a * 9) < -0.45) continue;
      if (tt % (2.6 + a * 2.4) < 0.14) continue;
      dot(ctx, soilBuf[e + 1] - 3.8, soilBuf[e + 2] - 0.5, 1.7);
      dot(ctx, soilBuf[e + 1] + 3.8, soilBuf[e + 2] - 0.5, 1.7);
    }
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.lineCap = cap;
  ctx.lineJoin = join;
}

/** Dusk tint over the gameplay ground (10% #FF7E5F), applied after pits. */
export function drawGroundTint(ctx: CanvasRenderingContext2D, b: BgFrame): void {
  const ph = PHASES[2];
  const a = ph.tintAlpha * b.dusk;
  if (a < 0.003 || ph.tint === '') return;
  const gy = GROUND_Y + b.offY + b.shakeY;
  base(ctx, b, 0, 0);
  ctx.globalAlpha = a;
  ctx.fillStyle = ph.tint;
  ctx.fillRect(-4, gy, b.viewW + 8, b.viewH - gy + 8);
  ctx.globalAlpha = 1;
}

type ReadEntities = ReadonlyArray<DeepReadonly<Entity>>;

function nearHazard(worldX: number, list: ReadEntities): boolean {
  const clear = GEN.tuftHazardClear;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.active || (!e.hazard && e.kind !== 'pit')) continue;
    if (worldX > e.x - clear && worldX < e.x + e.w + clear) return true;
  }
  return false;
}

/** Foreground grass tufts in the soil (scroll 1.3, 60% alpha), skipped near hazards. */
export function drawTufts(ctx: CanvasRenderingContext2D, b: BgFrame, t: PhaseTable, list: ReadEntities): void {
  const f = PARALLAX.tufts;
  const gy = GROUND_Y + b.offY + b.shakeY * f;
  const soil = b.viewH - gy;
  if (soil < 40) return;
  const lx = (b.camX + b.shakeX) * f;
  const tile = PARALLAX.tileTuft;
  const i0 = Math.floor((lx - 40) / tile);
  const i1 = Math.floor((lx + b.viewW + 40) / tile);
  base(ctx, b, 0, 0);
  ctx.globalAlpha = PARALLAX.tuftAlpha;
  ctx.strokeStyle = t.tuft[b.key];
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    if (hash01(i, SALT_TUFT, 0) > 0.6) continue;
    const sx = i * tile + hash01(i, SALT_TUFT, 1) * 60 - lx;
    // world x of the same screen column on the gameplay layer
    if (nearHazard(sx + b.camX, list)) continue;
    const y = gy + 36 + hash01(i, SALT_TUFT, 2) * (soil - 52);
    const h = 9 + hash01(i, SALT_TUFT, 3) * 9;
    const sway = Math.sin(b.time * 2 + i) * 1.5;
    const blades = 3 + Math.floor(hash01(i, SALT_TUFT, 4) * 3);
    for (let j = 0; j < blades; j++) {
      const off = (j - (blades - 1) / 2) * 3.2;
      ctx.moveTo(sx + off * 0.6, y);
      ctx.quadraticCurveTo(sx + off, y - h * 0.6, sx + off * 1.9 + sway, y - h * (0.75 + 0.25 * ((j * 7) % 3) / 2));
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Night fireflies drifting over the trail (glow sprite, additive). */
export function drawFireflies(ctx: CanvasRenderingContext2D, b: BgFrame): void {
  if (b.night < 0.02) return;
  const horizon = GROUND_Y + b.offY;
  const n = b.lowQ ? NIGHT.fireflies >> 1 : NIGHT.fireflies;
  const W = b.viewW + 80;
  base(ctx, b, 0, 0);
  for (let i = 0; i < n; i++) {
    const h0 = hash01(i, SALT_FLY, 0);
    const h1 = hash01(i, SALT_FLY, 1);
    const h2 = hash01(i, SALT_FLY, 2);
    const x = pmod(h0 * W - b.camX * (0.55 + h2 * 0.3) + Math.sin(b.time * 0.7 + h1 * 10) * 30, W) - 40;
    const y = horizon - 150 + h1 * 190 + Math.sin(b.time * 1.1 + h0 * 7) * 16;
    const blink = Math.sin(b.time * (1.6 + h2) + h2 * 20);
    const a = b.night * (0.25 + 0.75 * (blink > 0 ? blink : 0));
    if (a < 0.02) continue;
    if (b.glowCool !== null) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.8;
      ctx.drawImage(b.glowCool, x - 13, y - 13, 26, 26);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = a;
    ctx.fillStyle = FIREFLY_CORE;
    ctx.beginPath();
    dot(ctx, x, y, 1.8);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
