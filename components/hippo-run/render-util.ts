/**
 * Render-private helpers. Owner: ART engineer.
 *
 *  - Colour maths runs at INIT time only (createRenderer): every colour the renderer needs while
 *    the day phases cross-fade is precomputed into string tables indexed by
 *    `phase.index * (PHASE_STEPS + 1) + round(phase.blend * PHASE_STEPS)` so the per-frame path
 *    only does array lookups (no string building, no allocation).
 *  - Path helpers (rounded rect, star, ellipse underside crescent) never allocate.
 */
import { PHASES } from './config';
import type { DayPhaseDef } from './config';
import type { DeepReadonly, Entity, HeroState } from './types';

export type REntity = DeepReadonly<Entity>;
export type RHero = DeepReadonly<HeroState>;

export const TAU = Math.PI * 2;

/** Quantisation of the phase cross-fade (spec §9: 64 steps). */
export const PHASE_STEPS = 64;

/* ------------------------------------------------------------------ */
/* Init-time colour maths (allocates; never call per frame)            */
/* ------------------------------------------------------------------ */

function hexChannel(hex: string, i: number): number {
  return parseInt(hex.substring(1 + i * 2, 3 + i * 2), 16);
}

function to2(n: number): string {
  const v = n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
  const s = v.toString(16);
  return s.length < 2 ? '0' + s : s;
}

/** Mix two #RRGGBB colours (t = 0 -> a, 1 -> b). Init-time only. */
export function mixHex(a: string, b: string, t: number): string {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const ca = hexChannel(a, i);
    const cb = hexChannel(b, i);
    out += to2(ca + (cb - ca) * t);
  }
  return out;
}

/** rgba() string from #RRGGBB + alpha. Init-time only. */
export function rgbaHex(hex: string, a: number): string {
  return 'rgba(' + hexChannel(hex, 0) + ',' + hexChannel(hex, 1) + ',' + hexChannel(hex, 2) + ',' + a + ')';
}

/** One named colour per phase, derived from the phase definition. */
type PhaseColorFn = (p: DayPhaseDef) => string;

/** Every phase-dependent colour the renderer uses (each array: 4 phases x 65 blend steps). */
export interface PhaseTable {
  skyTop: string[];
  skyMid: string[];
  skyBottom: string[];
  cloud: string[];
  cloudShade: string[];
  mesa: string[];
  mesaShade: string[];
  mesaLight: string[];
  hills: string[];
  hillsShade: string[];
  trees: string[];
  groundTop: string[];
  groundLight: string[];
  groundEdge: string[];
  groundBody: string[];
  groundDark: string[];
  tuft: string[];
  haze: string[];
}

function buildChannel(fn: PhaseColorFn): string[] {
  const n = PHASES.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = fn(PHASES[i]);
    const b = fn(PHASES[(i + 1) % n]);
    for (let k = 0; k <= PHASE_STEPS; k++) out.push(mixHex(a, b, k / PHASE_STEPS));
  }
  return out;
}

/** Build all phase colour tables (createRenderer only). */
export function buildPhaseTable(): PhaseTable {
  return {
    skyTop: buildChannel((p) => p.skyTop),
    skyMid: buildChannel((p) => mixHex(p.skyTop, p.skyBottom, 0.58)),
    skyBottom: buildChannel((p) => p.skyBottom),
    cloud: buildChannel((p) => (p.night ? mixHex(p.skyBottom, '#C7D2FE', 0.25) : mixHex(p.skyBottom, '#FFFFFF', 0.62))),
    cloudShade: buildChannel((p) =>
      p.night ? mixHex(p.skyBottom, p.skyTop, 0.35) : mixHex(mixHex(p.skyBottom, '#FFFFFF', 0.4), p.skyTop, 0.22),
    ),
    mesa: buildChannel((p) => p.mesa),
    mesaShade: buildChannel((p) => mixHex(p.mesa, p.trees, 0.32)),
    mesaLight: buildChannel((p) => mixHex(p.mesa, p.skyBottom, 0.3)),
    hills: buildChannel((p) => p.hills),
    hillsShade: buildChannel((p) => mixHex(p.hills, p.trees, 0.38)),
    trees: buildChannel((p) => p.trees),
    groundTop: buildChannel((p) => p.groundTop),
    groundLight: buildChannel((p) => mixHex(p.groundTop, '#FFFFFF', p.night ? 0.12 : 0.3)),
    groundEdge: buildChannel((p) => mixHex(p.groundTop, p.groundBody, 0.6)),
    groundBody: buildChannel((p) => p.groundBody),
    groundDark: buildChannel((p) => mixHex(p.groundBody, '#1B1B3A', 0.22)),
    tuft: buildChannel((p) => mixHex(p.trees, p.groundBody, 0.25)),
    haze: buildChannel((p) => mixHex(p.skyBottom, p.mesa, 0.25)),
  };
}

/** Table index for the current phase state. */
export function phaseKey(index: number, blend: number): number {
  let k = Math.round(blend * PHASE_STEPS);
  if (!(k >= 0)) k = 0;
  if (k > PHASE_STEPS) k = PHASE_STEPS;
  let i = index | 0;
  if (i < 0 || i >= PHASES.length) i = 0;
  return i * (PHASE_STEPS + 1) + k;
}

/** Weight 0..1 of phase `k` in the current blend (index -> next). */
export function phaseWeight(k: number, index: number, next: number, blend: number): number {
  const b = blend >= 0 ? (blend <= 1 ? blend : 1) : 0;
  let w = 0;
  if (index === k) w += 1 - b;
  if (next === k) w += b;
  return w;
}

/* ------------------------------------------------------------------ */
/* Path helpers (allocation-free)                                      */
/* ------------------------------------------------------------------ */

/** Rounded rectangle sub-path (does not beginPath). */
export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  let rr = r;
  if (rr > w * 0.5) rr = w * 0.5;
  if (rr > h * 0.5) rr = h * 0.5;
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Star polygon sub-path (does not beginPath). */
export function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
  points: number,
  rot: number,
): void {
  const n = points * 2;
  for (let i = 0; i < n; i++) {
    const r = (i & 1) === 0 ? rOut : rIn;
    const a = rot - Math.PI / 2 + (i * Math.PI) / points;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Soft darker underside of an ellipse: a crescent between the bottom half of the ellipse and a
 * flatter inner ellipse (thickest at the bottom, zero at the sides). Starts its own path.
 */
export function undersidePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  k: number,
  rot: number,
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI, false);
  ctx.ellipse(cx, cy, rx, ry * k, rot, Math.PI, 0, true);
  ctx.closePath();
}

/** Clamp helper. */
export function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Smooth 0..1 ease (smoothstep). */
export function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Ease-out cubic. */
export function easeOut(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const u = 1 - x;
  return 1 - u * u * u;
}

/** Positive modulo. */
export function pmod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r;
}

/** Full circle as its own sub-path (moveTo first, so several dots never get joined by lines). */
export function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, TAU);
}

/** Full ellipse as its own sub-path (moveTo first). */
export function oval(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number): void {
  ctx.moveTo(x + Math.cos(rot) * rx, y + Math.sin(rot) * rx);
  ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
}
