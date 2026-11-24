/**
 * UI paint primitives — private helper of ui.ts. Owner: UI engineer.
 *
 * Pure drawing functions shared by the canvas UI: rounded rects, outlined text, rich (multi-colour)
 * text runs, TABULAR numbers drawn digit by digit (no string building per frame), path-drawn icons,
 * medals, bursts, keycaps and toggle switches.
 *
 * Rules: nothing here allocates on a per-frame path. Number drawing uses a module-level scratch
 * buffer that carries nothing between calls. Measuring helpers (measureText allocates a
 * TextMetrics) are only called from ui.ts at layout / event time.
 */
import { CHAIN_HUES, FONT_STACK, PAL } from './config';
import type { Medal } from './types';

export const TAU = Math.PI * 2;

/** UI colour palette (spec §9 + a few derived UI tints). */
export const COL = {
  ink: PAL.uiStroke,
  text: PAL.uiText,
  soft: '#E0E7FF',
  dim: '#C7D2FE',
  dimmer: '#A5B4FC',
  accent: PAL.uiAccent,
  accentDark: '#5B5FD6',
  gold: '#FFD166',
  warm: '#FFB627',
  red: '#FF5A5F',
  green: '#5BD08A',
  blue: '#4FA8F6',
  violet: '#B78CFF',
  panel: PAL.panel,
  card: '#17153A',
  cardTop: '#221F52',
  btn: '#26235E',
  btnEdge: 'rgba(199,210,254,0.55)',
  track: 'rgba(3,7,18,0.72)',
  trackEdge: 'rgba(248,250,252,0.9)',
  white: '#FFFFFF',
  shine: 'rgba(255,255,255,0.16)',
  shade: 'rgba(3,7,18,0.6)',
  mango: PAL.mango,
  leaf: PAL.mangoLeaf,
  mud: PAL.mudCoat,
  mudDark: PAL.mudCoatDark,
  drumShell: PAL.drumShell,
  drumSkin: PAL.drumSkin,
  drumLace: PAL.drumLacing,
};

/** Build a canvas font string (layout / measure time only: allocates). */
export function fontPx(px: number, weight: string): string {
  return weight + ' ' + Math.round(px * 10) / 10 + 'px ' + FONT_STACK;
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/** Rounded rectangle path (begins a new path). */
export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  let rr = r;
  if (rr > w / 2) rr = w / 2;
  if (rr > h / 2) rr = h / 2;
  if (rr < 0) rr = 0;
  ctx.beginPath();
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

/**
 * Chunky "sticker" shape used across the UI: ink drop shadow `drop` u below, fill, outline.
 * Pass lw = 0 for no outline.
 */
export function sticker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  drop: number,
  fill: string | CanvasGradient,
  edge: string,
  lw: number,
): void {
  if (drop > 0) {
    rrect(ctx, x, y + drop, w, h, r);
    ctx.fillStyle = COL.ink;
    ctx.fill();
  }
  rrect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (lw > 0) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = edge;
    ctx.stroke();
  }
}

/** Circle path (begins a new path). */
export function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r > 0 ? r : 0, 0, TAU);
}

/** Star / burst path with n points (begins a new path). */
export function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rIn: number,
  rOut: number,
  n: number,
  rot: number,
): void {
  ctx.beginPath();
  const step = Math.PI / n;
  for (let i = 0; i < n * 2; i++) {
    const r = (i & 1) === 0 ? rOut : rIn;
    const a = rot + i * step - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** Stroke then fill (light fill over a dark stroke; caller sets styles, align, baseline). */
export function outlined(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** One coloured run of a rich text line. `w` is filled in by measureSegs. */
export interface Seg {
  text: string;
  color: string;
  w: number;
}

const KEYWORDS: ReadonlyArray<string> = ['TAP', 'SPACE', 'SLAM', 'BOING!', 'BOING'];
const KEYWORD_COLORS: ReadonlyArray<string> = [COL.gold, COL.gold, COL.red, COL.green, COL.green];

/**
 * Split a line into coloured runs: TAP/SPACE gold, SLAM red, BOING green, the rest `base`.
 * Init-time only (allocates).
 */
export function richLine(text: string, base: string): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  let run = '';
  while (i < text.length) {
    let hit = -1;
    for (let k = 0; k < KEYWORDS.length; k++) {
      const kw = KEYWORDS[k];
      if (text.substring(i, i + kw.length) === kw) {
        const before = i === 0 ? ' ' : text.charAt(i - 1);
        const after = i + kw.length >= text.length ? ' ' : text.charAt(i + kw.length);
        const isWordStart = !/[A-Za-z]/.test(before);
        const isWordEnd = !/[A-Za-z]/.test(after);
        if (isWordStart && isWordEnd) {
          hit = k;
          break;
        }
      }
    }
    if (hit >= 0) {
      if (run !== '') out.push({ text: run, color: base, w: 0 });
      run = '';
      out.push({ text: KEYWORDS[hit], color: KEYWORD_COLORS[hit], w: 0 });
      i += KEYWORDS[hit].length;
    } else {
      run += text.charAt(i);
      i++;
    }
  }
  if (run !== '') out.push({ text: run, color: base, w: 0 });
  return out;
}

/** Measure each run with the current ctx.font; returns the total width. Measure time only. */
export function measureSegs(ctx: CanvasRenderingContext2D, segs: ReadonlyArray<Seg>): number {
  let w = 0;
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i] as Seg;
    sg.w = ctx.measureText(sg.text).width;
    w += sg.w;
  }
  return w;
}

/** Draw measured runs left-aligned from x (stroke pass, then fill pass). */
export function drawSegs(
  ctx: CanvasRenderingContext2D,
  segs: ReadonlyArray<Seg>,
  x: number,
  y: number,
  stroke: boolean,
): void {
  ctx.textAlign = 'left';
  if (stroke) {
    let sx = x;
    for (let i = 0; i < segs.length; i++) {
      ctx.strokeText(segs[i].text, sx, y);
      sx += segs[i].w;
    }
  }
  let fx = x;
  for (let i = 0; i < segs.length; i++) {
    ctx.fillStyle = segs[i].color;
    ctx.fillText(segs[i].text, fx, y);
    fx += segs[i].w;
  }
}

/* ------------------------------------------------------------------ */
/* Tabular numbers (no strings per frame)                              */
/* ------------------------------------------------------------------ */

/** A font measured for tabular digit drawing. */
export interface NumFont {
  font: string;
  size: number;
  /** Fixed advance of one digit cell (max digit width). */
  cell: number;
  /** Advance of the thousands separator. */
  comma: number;
}

export function makeNumFont(): NumFont {
  return { font: '', size: 0, cell: 0, comma: 0 };
}

const DIGITS: ReadonlyArray<string> = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const COMMA = ',';
/** Scratch digit buffer (most significant first). Carries nothing between calls. */
const digitBuf: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** (Re)build and measure a NumFont. Measure time only. */
export function measureNumFont(ctx: CanvasRenderingContext2D, nf: NumFont, px: number, weight: string): void {
  nf.font = fontPx(px, weight);
  nf.size = px;
  ctx.font = nf.font;
  let m = 0;
  for (let d = 0; d < 10; d++) {
    const w = ctx.measureText(DIGITS[d]).width;
    if (w > m) m = w;
  }
  nf.cell = m;
  nf.comma = ctx.measureText(COMMA).width * 0.9;
}

function splitDigits(value: number): number {
  let v = Math.floor(value < 0 ? -value : value);
  if (!(v < 1e15)) v = 0;
  let n = 0;
  do {
    digitBuf[n++] = v % 10;
    v = Math.floor(v / 10);
  } while (v > 0 && n < digitBuf.length);
  // reverse in place -> most significant first
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const t = digitBuf[i];
    digitBuf[i] = digitBuf[j];
    digitBuf[j] = t;
  }
  return n;
}

/** Width of a number drawn with drawNum. */
export function numWidth(nf: NumFont, value: number, commas: boolean): number {
  const n = splitDigits(value);
  const groups = commas ? Math.floor((n - 1) / 3) : 0;
  return n * nf.cell + groups * nf.comma;
}

/**
 * Draw a non-negative integer with fixed digit cells (tabular) at (x, y). align: 0 left, 0.5 centre,
 * 1 right. Uses the caller's fillStyle/strokeStyle/lineWidth/baseline and nf.font (set here).
 * Returns the drawn width.
 */
export function drawNum(
  ctx: CanvasRenderingContext2D,
  nf: NumFont,
  value: number,
  x: number,
  y: number,
  align: number,
  commas: boolean,
  stroke: boolean,
): number {
  const n = splitDigits(value);
  const groups = commas ? Math.floor((n - 1) / 3) : 0;
  const w = n * nf.cell + groups * nf.comma;
  const x0 = x - w * align;
  ctx.font = nf.font;
  ctx.textAlign = 'center';
  const half = nf.cell / 2;
  for (let pass = stroke ? 0 : 1; pass < 2; pass++) {
    let cx = x0;
    for (let i = 0; i < n; i++) {
      const ch = DIGITS[digitBuf[i]];
      if (pass === 0) ctx.strokeText(ch, cx + half, y);
      else ctx.fillText(ch, cx + half, y);
      cx += nf.cell;
      if (commas && i < n - 1 && (n - 1 - i) % 3 === 0) {
        if (pass === 0) ctx.strokeText(COMMA, cx + nf.comma / 2, y);
        else ctx.fillText(COMMA, cx + nf.comma / 2, y);
        cx += nf.comma;
      }
    }
  }
  return w;
}

/** Mix two #RRGGBB colours (t = 0 -> a, 1 -> b). Init / measure time only (allocates). */
export function mixHex(a: string, b: string, t: number): string {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const ca = parseInt(a.substring(1 + i * 2, 3 + i * 2), 16);
    const cb = parseInt(b.substring(1 + i * 2, 3 + i * 2), 16);
    const v = Math.round(ca + (cb - ca) * t);
    const h = (v < 0 ? 0 : v > 255 ? 255 : v).toString(16);
    out += h.length < 2 ? '0' + h : h;
  }
  return out;
}

/** Format an integer with thousands separators. EVENT time only (allocates). */
export function fmtInt(value: number): string {
  const v = Math.floor(value < 0 ? -value : value);
  const s = String(v);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s.charAt(i);
  }
  return value < 0 ? '-' + out : out;
}

/* ------------------------------------------------------------------ */
/* Easing                                                              */
/* ------------------------------------------------------------------ */

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInCubic(t: number): number {
  const u = clamp01(t);
  return u * u * u;
}

/** Overshooting ease (back). */
export function easeOutBack(t: number): number {
  const u = clamp01(t) - 1;
  const c = 1.9;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

/** Springy settle: 0 -> 1 with a damped wobble. */
export function easeOutElastic(t: number): number {
  const u = clamp01(t);
  if (u === 0 || u === 1) return u;
  return Math.pow(2, -9 * u) * Math.sin((u * 9 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

/** Bouncing landing (like a dropped ball). */
export function easeOutBounce(t: number): number {
  let u = clamp01(t);
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) {
    u -= 1.5 / d;
    return n * u * u + 0.75;
  }
  if (u < 2.5 / d) {
    u -= 2.25 / d;
    return n * u * u + 0.9375;
  }
  u -= 2.625 / d;
  return n * u * u + 0.984375;
}

/* ------------------------------------------------------------------ */
/* Icons (centred at cx, cy; r = half size)                            */
/* ------------------------------------------------------------------ */

export function iconPause(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  const bw = r * 0.32;
  const bh = r * 1.04;
  const gap = r * 0.28;
  ctx.fillStyle = color;
  rrect(ctx, cx - gap / 2 - bw, cy - bh / 2, bw, bh, bw * 0.4);
  ctx.fill();
  rrect(ctx, cx + gap / 2, cy - bh / 2, bw, bh, bw * 0.4);
  ctx.fill();
}

export function iconPlay(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.32, cy - r * 0.5);
  ctx.lineTo(cx + r * 0.52, cy);
  ctx.lineTo(cx - r * 0.32, cy + r * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = r * 0.22;
  ctx.stroke();
  ctx.fill();
}

export function iconSpeaker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  muted: boolean,
): void {
  const x = cx - r * 0.18;
  ctx.beginPath();
  ctx.moveTo(x - r * 0.42, cy - r * 0.2);
  ctx.lineTo(x - r * 0.14, cy - r * 0.2);
  ctx.lineTo(x + r * 0.2, cy - r * 0.52);
  ctx.lineTo(x + r * 0.2, cy + r * 0.52);
  ctx.lineTo(x - r * 0.14, cy + r * 0.2);
  ctx.lineTo(x - r * 0.42, cy + r * 0.2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = r * 0.12;
  ctx.stroke();
  ctx.fill();
  ctx.lineCap = 'round';
  if (muted) {
    const mx = x + r * 0.62;
    const d = r * 0.22;
    ctx.strokeStyle = COL.red;
    ctx.lineWidth = r * 0.16;
    ctx.beginPath();
    ctx.moveTo(mx - d, cy - d);
    ctx.lineTo(mx + d, cy + d);
    ctx.moveTo(mx + d, cy - d);
    ctx.lineTo(mx - d, cy + d);
    ctx.stroke();
  } else {
    ctx.lineWidth = r * 0.12;
    ctx.beginPath();
    ctx.arc(x + r * 0.22, cy, r * 0.3, -0.85, 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + r * 0.22, cy, r * 0.56, -0.85, 0.85);
    ctx.stroke();
  }
}

/** Ball with speed lines (motion setting). `calm` draws a resting ball with a soft halo instead. */
export function iconMotion(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  calm: boolean,
): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  if (calm) {
    circle(ctx, cx, cy, r * 0.3);
    ctx.fill();
    ctx.lineWidth = r * 0.1;
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * 0.6;
    circle(ctx, cx, cy, r * 0.56);
    ctx.stroke();
    ctx.globalAlpha = a;
    return;
  }
  circle(ctx, cx + r * 0.3, cy, r * 0.3);
  ctx.fill();
  ctx.lineWidth = r * 0.13;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.62, cy - r * 0.3);
  ctx.lineTo(cx - r * 0.12, cy - r * 0.3);
  ctx.moveTo(cx - r * 0.72, cy);
  ctx.lineTo(cx - r * 0.16, cy);
  ctx.moveTo(cx - r * 0.62, cy + r * 0.3);
  ctx.lineTo(cx - r * 0.12, cy + r * 0.3);
  ctx.stroke();
}

export function iconRestart(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  const rr = r * 0.46;
  const a0 = -Math.PI * 0.15;
  const a1 = Math.PI * 1.45;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = r * 0.17;
  ctx.beginPath();
  ctx.arc(cx, cy, rr, a0, a1);
  ctx.stroke();
  // arrow head at a0 (pointing along the circle, counter-clockwise start)
  const hx = cx + Math.cos(a0) * rr;
  const hy = cy + Math.sin(a0) * rr;
  const s = r * 0.3;
  ctx.beginPath();
  ctx.moveTo(hx + s * 0.9, hy - s * 0.1);
  ctx.lineTo(hx - s * 0.2, hy - s * 0.95);
  ctx.lineTo(hx - s * 0.35, hy + s * 0.35);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = r * 0.08;
  ctx.stroke();
  ctx.fill();
}

export function iconCopy(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  const w = r * 0.7;
  const h = r * 0.86;
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.13;
  ctx.lineJoin = 'round';
  rrect(ctx, cx - w * 0.75, cy - h * 0.62, w, h, r * 0.14);
  ctx.stroke();
  rrect(ctx, cx - w * 0.25, cy - h * 0.38, w, h, r * 0.14);
  ctx.fillStyle = color;
  ctx.fill();
}

export function iconMango(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, golden: boolean): void {
  ctx.save();
  ctx.translate(cx, cy + r * 0.06);
  ctx.rotate(-0.35);
  // leaf
  ctx.beginPath();
  ctx.ellipse(r * 0.28, -r * 0.72, r * 0.36, r * 0.16, -0.5, 0, TAU);
  ctx.fillStyle = COL.leaf;
  ctx.fill();
  ctx.lineWidth = r * 0.14;
  ctx.strokeStyle = COL.ink;
  ctx.stroke();
  // fruit
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.62, r * 0.76, 0, 0, TAU);
  ctx.fillStyle = golden ? PAL.golden : COL.mango;
  ctx.fill();
  ctx.stroke();
  // blush + shine
  ctx.beginPath();
  ctx.ellipse(r * 0.18, r * 0.2, r * 0.3, r * 0.36, 0, 0, TAU);
  ctx.fillStyle = 'rgba(255,90,95,0.35)';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-r * 0.22, -r * 0.28, r * 0.12, r * 0.2, 0.3, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fill();
  ctx.restore();
}

export function iconDrum(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const w = r * 1.5;
  const h = r * 1.0;
  const x = cx - w / 2;
  const top = cy - h * 0.35;
  ctx.lineWidth = r * 0.14;
  ctx.strokeStyle = COL.ink;
  ctx.lineJoin = 'round';
  // shell
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x + w * 0.08, top + h);
  ctx.ellipse(cx, top + h, w * 0.42, r * 0.2, 0, Math.PI, 0, true);
  ctx.lineTo(x + w, top);
  ctx.closePath();
  ctx.fillStyle = COL.drumShell;
  ctx.fill();
  ctx.stroke();
  // lacing
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const lx = x + w * 0.12 + (w * 0.76 * i) / 4;
    const ly = i % 2 === 0 ? top + h * 0.28 : top + h * 0.82;
    if (i === 0) ctx.moveTo(lx, ly);
    else ctx.lineTo(lx, ly);
  }
  ctx.strokeStyle = COL.drumLace;
  ctx.lineWidth = r * 0.1;
  ctx.stroke();
  // skin
  ctx.beginPath();
  ctx.ellipse(cx, top, w / 2, r * 0.26, 0, 0, TAU);
  ctx.fillStyle = COL.drumSkin;
  ctx.fill();
  ctx.lineWidth = r * 0.14;
  ctx.strokeStyle = COL.ink;
  ctx.stroke();
}

export function iconFlag(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const px = cx - r * 0.42;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // pennant
  ctx.beginPath();
  ctx.moveTo(px, cy - r * 0.78);
  ctx.quadraticCurveTo(px + r * 0.6, cy - r * 0.78, px + r * 1.0, cy - r * 0.48);
  ctx.quadraticCurveTo(px + r * 0.6, cy - r * 0.18, px, cy - r * 0.2);
  ctx.closePath();
  ctx.fillStyle = COL.accent;
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.13;
  ctx.stroke();
  // pole
  ctx.beginPath();
  ctx.moveTo(px, cy - r * 0.86);
  ctx.lineTo(px, cy + r * 0.86);
  ctx.lineWidth = r * 0.3;
  ctx.strokeStyle = COL.ink;
  ctx.stroke();
  ctx.lineWidth = r * 0.13;
  ctx.strokeStyle = COL.text;
  ctx.stroke();
}

/** Stomp: a chunky downward arrow onto a bump with impact ticks. */
export function iconStomp(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // bump (hornbill back)
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.62, r * 0.7, r * 0.3, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = PAL.hornbill;
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.12;
  ctx.stroke();
  // arrow
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.18, cy - r * 0.86);
  ctx.lineTo(cx + r * 0.18, cy - r * 0.86);
  ctx.lineTo(cx + r * 0.18, cy - r * 0.2);
  ctx.lineTo(cx + r * 0.42, cy - r * 0.2);
  ctx.lineTo(cx, cy + r * 0.24);
  ctx.lineTo(cx - r * 0.42, cy - r * 0.2);
  ctx.lineTo(cx - r * 0.18, cy - r * 0.2);
  ctx.closePath();
  ctx.fillStyle = COL.gold;
  ctx.fill();
  ctx.stroke();
  // impact ticks
  ctx.strokeStyle = COL.text;
  ctx.lineWidth = r * 0.11;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.62, cy + r * 0.02);
  ctx.lineTo(cx - r * 0.86, cy - r * 0.12);
  ctx.moveTo(cx + r * 0.62, cy + r * 0.02);
  ctx.lineTo(cx + r * 0.86, cy - r * 0.12);
  ctx.stroke();
}

/** Mud Coat: a brown dripping blob with a shine. */
export function iconMud(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.78, cy + r * 0.05);
  ctx.bezierCurveTo(cx - r * 0.86, cy - r * 0.7, cx + r * 0.86, cy - r * 0.7, cx + r * 0.78, cy + r * 0.05);
  // drips along the bottom
  ctx.lineTo(cx + r * 0.66, cy + r * 0.62);
  ctx.quadraticCurveTo(cx + r * 0.52, cy + r * 0.86, cx + r * 0.42, cy + r * 0.56);
  ctx.lineTo(cx + r * 0.3, cy + r * 0.3);
  ctx.quadraticCurveTo(cx + r * 0.12, cy + r * 0.34, cx + r * 0.04, cy + r * 0.44);
  ctx.lineTo(cx - r * 0.04, cy + r * 0.82);
  ctx.quadraticCurveTo(cx - r * 0.2, cy + r * 1.02, cx - r * 0.32, cy + r * 0.78);
  ctx.lineTo(cx - r * 0.4, cy + r * 0.36);
  ctx.quadraticCurveTo(cx - r * 0.62, cy + r * 0.36, cx - r * 0.78, cy + r * 0.05);
  ctx.closePath();
  ctx.fillStyle = COL.mud;
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.13;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.3, cy - r * 0.22, r * 0.2, r * 0.11, -0.5, 0, TAU);
  ctx.fillStyle = 'rgba(255,232,194,0.55)';
  ctx.fill();
  circle(ctx, cx + r * 0.28, cy - r * 0.02, r * 0.09);
  ctx.fillStyle = COL.mudDark;
  ctx.fill();
}

/** Fruit Magnet charm: a crossed pair of drum-sticks with red tips. */
export function iconMagnet(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.lineCap = 'round';
  for (let i = 0; i < 2; i++) {
    const sgn = i === 0 ? -1 : 1;
    const x0 = cx + sgn * r * 0.55;
    const y0 = cy + r * 0.62;
    const x1 = cx - sgn * r * 0.35;
    const y1 = cy - r * 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = r * 0.34;
    ctx.stroke();
    ctx.strokeStyle = '#E9C46A';
    ctx.lineWidth = r * 0.16;
    ctx.stroke();
    circle(ctx, x1, y1, r * 0.24);
    ctx.fillStyle = COL.red;
    ctx.fill();
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = r * 0.11;
    ctx.stroke();
  }
}

/** Phone outline being rotated (portrait hint). `t` 0..1 animates the rotation (0 when static). */
export function iconRotate(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, t: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-t * Math.PI * 0.5);
  rrect(ctx, -r * 0.34, -r * 0.6, r * 0.68, r * 1.2, r * 0.14);
  ctx.fillStyle = COL.ink;
  ctx.fill();
  ctx.lineWidth = r * 0.1;
  ctx.strokeStyle = COL.text;
  ctx.stroke();
  circle(ctx, 0, r * 0.46, r * 0.05);
  ctx.fillStyle = COL.text;
  ctx.fill();
  ctx.restore();
  // curved arrow
  ctx.strokeStyle = COL.gold;
  ctx.fillStyle = COL.gold;
  ctx.lineWidth = r * 0.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.86, -Math.PI * 0.95, -Math.PI * 0.55);
  ctx.stroke();
  const ax = cx + Math.cos(-Math.PI * 0.55) * r * 0.86;
  const ay = cy + Math.sin(-Math.PI * 0.55) * r * 0.86;
  ctx.beginPath();
  ctx.moveTo(ax + r * 0.2, ay - r * 0.02);
  ctx.lineTo(ax - r * 0.08, ay - r * 0.18);
  ctx.lineTo(ax - r * 0.02, ay + r * 0.16);
  ctx.closePath();
  ctx.fill();
}

/** Simple arrow (up = -1 or down = +1) used by tutorial pills. */
export function iconArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  dir: number,
  color: string,
): void {
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.22, cy - dir * r * 0.8);
  ctx.lineTo(cx + r * 0.22, cy - dir * r * 0.8);
  ctx.lineTo(cx + r * 0.22, cy - dir * r * 0.05);
  ctx.lineTo(cx + r * 0.62, cy - dir * r * 0.05);
  ctx.lineTo(cx, cy + dir * r * 0.8);
  ctx.lineTo(cx - r * 0.62, cy - dir * r * 0.05);
  ctx.lineTo(cx - r * 0.22, cy - dir * r * 0.05);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.16;
  ctx.stroke();
  ctx.fill();
}

/** Music note glyph (decoration). */
export function iconNote(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // stem + flag
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.3, cy + r * 0.5);
  ctx.lineTo(cx + r * 0.3, cy - r * 0.8);
  ctx.quadraticCurveTo(cx + r * 0.75, cy - r * 0.55, cx + r * 0.7, cy - r * 0.15);
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.4;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.18;
  ctx.stroke();
  // head
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.55, r * 0.36, r * 0.27, -0.4, 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.14;
  ctx.stroke();
}

/** Check mark (goal done). */
export function iconCheck(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  circle(ctx, cx, cy, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.45, cy + r * 0.02);
  ctx.lineTo(cx - r * 0.12, cy + r * 0.36);
  ctx.lineTo(cx + r * 0.5, cy - r * 0.34);
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.26;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/* ------------------------------------------------------------------ */
/* Medal                                                               */
/* ------------------------------------------------------------------ */

const MEDAL_FILL: { [K in Medal]: string } = {
  none: 'rgba(255,255,255,0.06)',
  bronze: '#D98A4E',
  silver: '#D9E1EC',
  gold: '#FFD34D',
};
const MEDAL_RIM: { [K in Medal]: string } = {
  none: 'rgba(199,210,254,0.5)',
  bronze: '#A35A2A',
  silver: '#93A1B5',
  gold: '#D99A1C',
};
const MEDAL_STAR: { [K in Medal]: string } = {
  none: 'rgba(199,210,254,0.35)',
  bronze: '#F2B07E',
  silver: '#FFFFFF',
  gold: '#FFF3A3',
};

/**
 * Medal disc with ribbon tails. `medal === 'none'` draws an empty dashed slot.
 * shine 0..1 sweeps a highlight across the disc.
 */
export function drawMedal(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  medal: Medal,
  shine: number,
): void {
  ctx.lineJoin = 'round';
  if (medal !== 'none') {
    // ribbon tails
    for (let i = 0; i < 2; i++) {
      const sgn = i === 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + sgn * r * 0.18, cy - r * 0.2);
      ctx.lineTo(cx + sgn * r * 0.78, cy + r * 1.25);
      ctx.lineTo(cx + sgn * r * 0.48, cy + r * 1.08);
      ctx.lineTo(cx + sgn * r * 0.3, cy + r * 1.38);
      ctx.lineTo(cx - sgn * r * 0.1, cy + r * 0.2);
      ctx.closePath();
      ctx.fillStyle = CHAIN_HUES[i === 0 ? 0 : 3];
      ctx.fill();
      ctx.strokeStyle = COL.ink;
      ctx.lineWidth = r * 0.1;
      ctx.stroke();
    }
  }
  circle(ctx, cx, cy, r);
  ctx.fillStyle = MEDAL_FILL[medal];
  ctx.fill();
  if (medal === 'none') {
    DASH[0] = r * 0.34;
    DASH[1] = r * 0.3;
    ctx.setLineDash(DASH);
    ctx.strokeStyle = MEDAL_RIM.none;
    ctx.lineWidth = r * 0.1;
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    starPath(ctx, cx, cy, r * 0.25, r * 0.55, 5, 0);
    ctx.fillStyle = MEDAL_STAR.none;
    ctx.fill();
    return;
  }
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = r * 0.14;
  ctx.stroke();
  circle(ctx, cx, cy, r * 0.76);
  ctx.strokeStyle = MEDAL_RIM[medal];
  ctx.lineWidth = r * 0.1;
  ctx.stroke();
  starPath(ctx, cx, cy + r * 0.02, r * 0.24, r * 0.52, 5, 0);
  ctx.fillStyle = MEDAL_STAR[medal];
  ctx.fill();
  ctx.strokeStyle = MEDAL_RIM[medal];
  ctx.lineWidth = r * 0.07;
  ctx.stroke();
  if (shine > 0 && shine < 1) {
    ctx.save();
    circle(ctx, cx, cy, r * 0.93);
    ctx.clip();
    const sx = cx - r * 1.4 + shine * r * 2.8;
    ctx.beginPath();
    ctx.moveTo(sx - r * 0.25, cy - r);
    ctx.lineTo(sx + r * 0.1, cy - r);
    ctx.lineTo(sx - r * 0.25, cy + r);
    ctx.lineTo(sx - r * 0.6, cy + r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fill();
    ctx.restore();
  }
}

/** Scratch dash patterns (overwritten before every use; carry nothing between calls). */
const DASH: number[] = [4, 4];
const NO_DASH: number[] = [];

/* ------------------------------------------------------------------ */
/* Widgets                                                             */
/* ------------------------------------------------------------------ */

/** Keyboard keycap (tutorial "SPACE"). Draws the cap; caller draws the label. */
export function keycap(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  press: number,
): void {
  const depth = h * 0.16 * (1 - press);
  const r = h * 0.22;
  rrect(ctx, cx - w / 2, cy - h / 2 + h * 0.16, w, h, r);
  ctx.fillStyle = '#9CA3D9';
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = h * 0.07;
  ctx.stroke();
  rrect(ctx, cx - w / 2, cy - h / 2 + h * 0.16 - depth, w, h, r);
  ctx.fillStyle = '#F4F5FF';
  ctx.fill();
  ctx.stroke();
}

/** Toggle switch (track + knob). on 0..1 (animated). */
export function toggleSwitch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  on: number,
): void {
  rrect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = on > 0.5 ? COL.green : 'rgba(248,250,252,0.18)';
  ctx.fill();
  ctx.strokeStyle = COL.ink;
  ctx.lineWidth = h * 0.12;
  ctx.stroke();
  const kr = h * 0.36;
  const kx = x + h / 2 + (w - h) * on;
  circle(ctx, kx, y + h / 2, kr);
  ctx.fillStyle = COL.white;
  ctx.fill();
  ctx.lineWidth = h * 0.08;
  ctx.stroke();
}
