/**
 * Particles, floating popups, rings/shockwaves, trauma shake, flashes, confetti,
 * fever speed lines + warm vignette. Owner: ART engineer.
 *
 * Behaviour (spec §10):
 *  - Pools created once in createFx: particles 256, popups 16, rings 24 (config POOLS).
 *    When a pool is full the least recently allocated slot is recycled. burst/popup/ring/update/
 *    draw never allocate (popup text is passed in, built by the caller at event time).
 *  - All positions are WORLD u (x right, y down, GROUND_Y = 430). drawWorld() is called by
 *    render with the camera transform already applied (world -> logical, incl. offsetY + shake).
 *  - update(realDt) runs on REAL dt (keeps going in hit-stop / slow-mo; game.ts skips it while
 *    paused). Writes state.cam.trauma / shakeX / shakeY ONLY:
 *      offset = 12 u * trauma^2 using summed sines; trauma decays 2.2 / s.
 *  - Reduced motion (state.save.reducedMotion): shake() and flash() are ignored, speed lines off,
 *    vignette steady (no beat pulse), popups fade in instead of scaling.
 *  - Popups: scale 0 -> 1.2 -> 1 in 150 ms, drift up 30 u, fade out over the end of their life
 *    ('lg' lives longer). They partly follow the camera so text stays readable next to Toto.
 *  - Rings: 'drum' (hue, 0.3 s), 'shock' (0 -> 120 u in 0.22 s), 'boing', 'pickup'.
 *  - drawScreen(): fever speed lines + warm vignette (state.fever.active), full-screen flash.
 *  - setLowQuality(true): halve every burst count (adaptive DPR fallback).
 *  - Randomness: event-time spawns use the COSMETIC rng; frame-driven cosmetics (speed lines) use
 *    a private LCG so the cosmetic stream's sequence does not depend on the frame rate.
 */
import { CHAIN_HUES, FONT_STACK, FX, GROUND_Y, PAL, PHASES, POOLS, SHAKE } from './config';
import type { FxApi, GameState, ParticleKind, PopupSize, RingKind, Rng } from './types';

/* ------------------------------------------------------------------ */
/* Static tables (immutable, module-level is fine)                     */
/* ------------------------------------------------------------------ */

const K_DUST = 0;
const K_PEBBLE = 1;
const K_FEATHER = 2;
const K_CHIP = 3;
const K_SEED = 4;
const K_JUICE = 5;
const K_MUD = 6;
const K_CONFETTI = 7;
const K_SPARK = 8;
const K_POOF = 9;
const K_NOTE = 10;
const K_STAR = 11;

const R_DRUM = 0;
const R_SHOCK = 1;
const R_BOING = 2;
const R_PICKUP = 3;

const PEBBLE_COLORS: ReadonlyArray<string> = ['#7A5A3A', '#A67B4F', '#5C4330', '#C9A27A'];
const FEATHER_COLORS: ReadonlyArray<string> = [PAL.hornbill, PAL.hornbillWing, PAL.hornbill, PAL.hornbillBeak, '#F8FAFC'];
const CHIP_COLORS: ReadonlyArray<string> = [PAL.logRing, PAL.log, PAL.logBark, '#E0B184'];
const SEED_COLORS: ReadonlyArray<string> = [PAL.melonSeed, '#3B2A20', PAL.melonSeed];
const JUICE_COLORS: ReadonlyArray<string> = [PAL.melonFlesh, '#FF8E8E', '#E84A5F'];
const MUD_COLORS: ReadonlyArray<string> = [PAL.mud, PAL.mudDark, PAL.mudCoat, '#7B55B0', PAL.mudCoatDark];
const SPARK_COLORS: ReadonlyArray<string> = ['#FFF3A3', '#FFE45E', '#FFFFFF', '#FFB627'];
const POOF_COLORS: ReadonlyArray<string> = ['#F8FAFC', '#E6E3F5', '#FFF6E8'];
const STAR_COLORS: ReadonlyArray<string> = ['#FFE45E', '#FFFFFF', '#FFF3A3'];

const POPUP_FONTS: ReadonlyArray<string> = [
  'bold 17px ' + FONT_STACK,
  'bold 23px ' + FONT_STACK,
  'bold 33px ' + FONT_STACK,
];
const POPUP_STROKE: ReadonlyArray<number> = [5, 6, 8];
/** How much of the camera motion a popup follows (0 = pinned to the world, 1 = pinned to screen). */
const POPUP_FOLLOW: ReadonlyArray<number> = [0.55, 0.7, 0.86];

const SHOCK_COLOR = '#FFF8E7';
const WHITE = '#FFFFFF';
const INK = PAL.outline;
const VIGNETTE_CLEAR = 'rgba(255,126,63,0)';
const VIGNETTE_MID = 'rgba(255,126,63,0.35)';
const VIGNETTE_EDGE = 'rgba(255,110,50,1)';
const SPEED_LINE_WARM = '#FFE2B8';

/* ------------------------------------------------------------------ */
/* Pooled records                                                      */
/* ------------------------------------------------------------------ */

interface Particle {
  on: boolean;
  k: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  size: number;
  rot: number;
  vr: number;
  color: string;
  g: number;
  drag: number;
  seed: number;
  /** Came to rest on the ground (splat / settled). */
  rest: boolean;
}

interface Popup {
  on: boolean;
  x: number;
  y: number;
  cam0: number;
  text: string;
  color: string;
  size: number;
  t: number;
  life: number;
  lift: number;
}

interface Ring {
  on: boolean;
  k: number;
  x: number;
  y: number;
  color: string;
  t: number;
  dur: number;
}

function makeParticle(): Particle {
  return {
    on: false,
    k: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    t: 0,
    life: 1,
    size: 1,
    rot: 0,
    vr: 0,
    color: WHITE,
    g: 0,
    drag: 0,
    seed: 0,
    rest: false,
  };
}

function kindCode(kind: ParticleKind): number {
  switch (kind) {
    case 'dust':
      return K_DUST;
    case 'pebble':
      return K_PEBBLE;
    case 'feather':
      return K_FEATHER;
    case 'chip':
      return K_CHIP;
    case 'seed':
      return K_SEED;
    case 'juice':
      return K_JUICE;
    case 'mud':
      return K_MUD;
    case 'confetti':
      return K_CONFETTI;
    case 'spark':
      return K_SPARK;
    case 'poof':
      return K_POOF;
    case 'note':
      return K_NOTE;
    case 'star':
      return K_STAR;
  }
  return K_DUST;
}

function ringCode(kind: RingKind): number {
  switch (kind) {
    case 'drum':
      return R_DRUM;
    case 'shock':
      return R_SHOCK;
    case 'boing':
      return R_BOING;
    case 'pickup':
      return R_PICKUP;
  }
  return R_DRUM;
}

function sizeCode(size: PopupSize): number {
  return size === 'sm' ? 0 : size === 'md' ? 1 : 2;
}

function pick(list: ReadonlyArray<string>, r: number): string {
  let i = Math.floor(r * list.length);
  if (i >= list.length) i = list.length - 1;
  return list[i];
}

/** Create the fx system bound to the (single, never replaced) game state. */
export function createFx(state: GameState, crng: Rng): FxApi {
  const NP = POOLS.particles;
  const NPOP = POOLS.popups;
  const NR = POOLS.rings;
  const parts: Particle[] = [];
  for (let i = 0; i < NP; i++) parts.push(makeParticle());
  const pops: Popup[] = [];
  for (let i = 0; i < NPOP; i++) {
    pops.push({ on: false, x: 0, y: 0, cam0: 0, text: '', color: WHITE, size: 0, t: 0, life: 1, lift: 0 });
  }
  const rings: Ring[] = [];
  for (let i = 0; i < NR; i++) rings.push({ on: false, k: 0, x: 0, y: 0, color: WHITE, t: 0, dur: 1 });

  let pCursor = 0;
  let popCursor = 0;
  let ringCursor = 0;
  let activeParticles = 0;
  let lowQ = false;
  let time = 0;

  // Flash
  let flashColor = WHITE;
  let flashA = 0;
  let flashA0 = 0;
  // Fever screen fx
  let feverVis = 0;
  const NL = FX.speedLines;
  const lineX = new Float32Array(NL);
  const lineY = new Float32Array(NL);
  const lineLen = new Float32Array(NL);
  const lineSpd = new Float32Array(NL);
  const lineW = new Float32Array(NL);
  let linesInit = false;
  let lcg = 0x2f6b1d3 ^ (state.seed | 0);
  // Vignette cache
  let vignette: CanvasGradient | null = null;
  let vignetteVersion = -1;
  let vignetteCtx: CanvasRenderingContext2D | null = null;

  function rand(): number {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) | 0;
    return (lcg >>> 8) / 16777216;
  }

  function allocParticle(): Particle {
    for (let n = 0; n < NP; n++) {
      const i = (pCursor + n) % NP;
      if (!parts[i].on) {
        pCursor = (i + 1) % NP;
        return parts[i];
      }
    }
    const p = parts[pCursor];
    pCursor = (pCursor + 1) % NP;
    return p;
  }

  function hueColor(hue: number, fallback: string): string {
    if (hue >= 0 && hue < CHAIN_HUES.length) return CHAIN_HUES[hue | 0];
    return fallback;
  }

  function spawnOne(k: number, x: number, y: number, hue: number, i: number, n: number): void {
    const p = allocParticle();
    p.on = true;
    p.k = k;
    p.x = x;
    p.y = y;
    p.t = 0;
    p.rot = crng.range(0, Math.PI * 2);
    p.vr = 0;
    p.g = 0;
    p.drag = 0;
    p.seed = crng.range(0, 100);
    p.rest = false;
    const r = crng.next();
    switch (k) {
      case K_DUST: {
        const dir = (i & 1) === 0 ? -1 : 1;
        p.vx = dir * crng.range(20, 110) - 30;
        p.vy = -crng.range(20, 90);
        p.x += crng.range(-10, 10);
        p.y -= crng.range(0, 6);
        p.size = crng.range(4.5, 9);
        p.life = crng.range(0.32, 0.55);
        p.g = -40;
        p.drag = 4.5;
        const ph = PHASES[state.phase.index];
        p.color = r < 0.6 ? ph.groundTop : ph.groundBody;
        break;
      }
      case K_PEBBLE: {
        const a = Math.PI + (i + 0.5) * (Math.PI / n) + crng.range(-0.2, 0.2);
        const sp = crng.range(160, 420);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - crng.range(80, 220);
        p.size = crng.range(2.2, 4.6);
        p.life = crng.range(0.6, 0.95);
        p.g = 1900;
        p.drag = 0.6;
        p.vr = crng.range(-12, 12);
        p.color = r < 0.25 ? PHASES[state.phase.index].groundBody : pick(PEBBLE_COLORS, crng.next());
        break;
      }
      case K_FEATHER: {
        const a = crng.range(0, Math.PI * 2);
        const sp = crng.range(80, 260);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - 120;
        p.size = crng.range(6, 10);
        p.life = crng.range(0.9, 1.4);
        p.g = 240;
        p.drag = 2.8;
        p.vr = crng.range(-7, 7);
        p.color = pick(FEATHER_COLORS, r);
        break;
      }
      case K_CHIP: {
        const a = Math.PI + crng.range(0.15, Math.PI - 0.15);
        const sp = crng.range(180, 420);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - 60;
        p.size = crng.range(3.5, 7);
        p.life = crng.range(0.55, 0.9);
        p.g = 1500;
        p.drag = 0.8;
        p.vr = crng.range(-16, 16);
        p.color = pick(CHIP_COLORS, r);
        break;
      }
      case K_SEED: {
        const a = Math.PI + crng.range(0.2, Math.PI - 0.2);
        const sp = crng.range(140, 360);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - 80;
        p.size = crng.range(2.2, 3.4);
        p.life = crng.range(0.5, 0.85);
        p.g = 1500;
        p.drag = 0.6;
        p.vr = crng.range(-10, 10);
        p.color = pick(SEED_COLORS, r);
        break;
      }
      case K_JUICE: {
        const a = Math.PI + crng.range(0.1, Math.PI - 0.1);
        const sp = crng.range(120, 330);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - 60;
        p.size = crng.range(2.8, 5.5);
        p.life = crng.range(0.45, 0.75);
        p.g = 1300;
        p.drag = 0.8;
        p.color = pick(JUICE_COLORS, r);
        break;
      }
      case K_MUD: {
        const a = Math.PI + crng.range(0.1, Math.PI - 0.1);
        const sp = crng.range(180, 520);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - 100;
        p.size = crng.range(3.5, 8.5);
        p.life = crng.range(0.7, 1.1);
        p.g = 1700;
        p.drag = 0.5;
        p.color = pick(MUD_COLORS, r);
        break;
      }
      case K_CONFETTI: {
        const a = -Math.PI / 2 + crng.range(-1.1, 1.1);
        const sp = crng.range(260, 700);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.size = crng.range(4, 7);
        p.life = crng.range(1.3, 2.0);
        p.g = 520;
        p.drag = 1.8;
        p.vr = crng.range(-12, 12);
        p.color = hue >= 0 ? hueColor((hue + i) % CHAIN_HUES.length, WHITE) : CHAIN_HUES[i % CHAIN_HUES.length];
        break;
      }
      case K_SPARK: {
        const a = (i / n) * Math.PI * 2 + crng.range(-0.35, 0.35);
        const sp = crng.range(170, 380);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.size = crng.range(2, 3.4);
        p.life = crng.range(0.22, 0.38);
        p.drag = 5.5;
        p.color = hue >= 0 ? hueColor(hue, WHITE) : pick(SPARK_COLORS, r);
        break;
      }
      case K_POOF: {
        const a = (i / n) * Math.PI * 2 + crng.range(-0.4, 0.4);
        const sp = crng.range(40, 140);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp - 30;
        p.x += Math.cos(a) * 6;
        p.y += Math.sin(a) * 6;
        p.size = crng.range(7, 13);
        p.life = crng.range(0.38, 0.6);
        p.g = -60;
        p.drag = 3.5;
        p.color = pick(POOF_COLORS, r);
        break;
      }
      case K_NOTE: {
        p.vx = crng.range(-50, 50);
        p.vy = -crng.range(90, 160);
        p.x += crng.range(-24, 24);
        p.size = crng.range(7.5, 10.5);
        p.life = crng.range(0.75, 1.05);
        p.g = -20;
        p.drag = 1.2;
        p.rot = crng.range(-0.3, 0.3);
        p.color = hueColor(hue, PAL.drumSkin);
        break;
      }
      case K_STAR: {
        const a = (i / n) * Math.PI * 2 + crng.range(-0.5, 0.5);
        const sp = crng.range(60, 220);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.size = crng.range(4, 7.5);
        p.life = crng.range(0.4, 0.75);
        p.drag = 3;
        p.vr = crng.range(-5, 5);
        p.color = hue >= 0 ? hueColor(hue, WHITE) : pick(STAR_COLORS, r);
        break;
      }
      default:
        p.on = false;
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Drawing helpers                                                     */
  /* ------------------------------------------------------------------ */

  function drawParticle(ctx: CanvasRenderingContext2D, p: Particle): void {
    const u = p.t / p.life;
    const fadeOut = u > 0.65 ? 1 - (u - 0.65) / 0.35 : 1;
    ctx.fillStyle = p.color;
    switch (p.k) {
      case K_DUST:
      case K_POOF: {
        const grow = 1 + u * (p.k === K_POOF ? 1.3 : 0.9);
        ctx.globalAlpha = (p.k === K_POOF ? 0.9 : 0.75) * (1 - u) * (1 - u * 0.3);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * grow, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case K_PEBBLE:
      case K_SEED: {
        ctx.globalAlpha = fadeOut;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size, p.size * (p.k === K_SEED ? 0.62 : 0.8), p.rot, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case K_JUICE: {
        ctx.globalAlpha = fadeOut;
        const s = p.size * (1 - u * 0.5);
        ctx.beginPath();
        if (p.rest) ctx.ellipse(p.x, p.y - 1, s * 1.6, s * 0.45, 0, 0, Math.PI * 2);
        else ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case K_MUD: {
        ctx.globalAlpha = fadeOut;
        ctx.beginPath();
        if (p.rest) {
          ctx.ellipse(p.x, p.y - 1, p.size * 1.7, p.size * 0.5, 0, 0, Math.PI * 2);
        } else {
          const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
          const st = 1 + (sp > 900 ? 900 : sp) * 0.0011;
          ctx.ellipse(p.x, p.y, p.size * st, p.size / st, Math.atan2(p.vy, p.vx), 0, Math.PI * 2);
        }
        ctx.fill();
        break;
      }
      case K_FEATHER: {
        ctx.globalAlpha = fadeOut;
        const c = Math.cos(p.rot);
        const s = Math.sin(p.rot);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.36, p.rot, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1;
        ctx.globalAlpha = fadeOut * 0.45;
        ctx.beginPath();
        ctx.moveTo(p.x - c * p.size * 1.25, p.y - s * p.size * 1.25);
        ctx.lineTo(p.x + c * p.size * 0.8, p.y + s * p.size * 0.8);
        ctx.stroke();
        break;
      }
      case K_CHIP:
      case K_CONFETTI: {
        ctx.globalAlpha = fadeOut;
        const flip = p.k === K_CONFETTI ? Math.cos(p.seed + p.t * 13) : 1;
        const hw = p.size * 0.5;
        const hh = p.size * (p.k === K_CONFETTI ? 0.32 : 0.45) * (flip < 0 ? -flip : flip) + 0.4;
        const c = Math.cos(p.rot);
        const s = Math.sin(p.rot);
        ctx.beginPath();
        ctx.moveTo(p.x - c * hw + s * hh, p.y - s * hw - c * hh);
        ctx.lineTo(p.x + c * hw + s * hh, p.y + s * hw - c * hh);
        ctx.lineTo(p.x + c * hw - s * hh, p.y + s * hw + c * hh);
        ctx.lineTo(p.x - c * hw - s * hh, p.y - s * hw + c * hh);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case K_SPARK: {
        ctx.globalAlpha = 1 - u * u;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size * (1 - u * 0.6);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045);
        ctx.stroke();
        break;
      }
      case K_NOTE: {
        ctx.globalAlpha = fadeOut;
        const sway = Math.sin(p.seed + p.t * 7) * 4;
        const x = p.x + sway;
        const s = p.size;
        // outline first, then fill (head + stem + flag)
        ctx.strokeStyle = INK;
        ctx.lineCap = 'round';
        ctx.lineWidth = 2.2 + s * 0.28;
        ctx.beginPath();
        ctx.moveTo(x + s * 0.42, p.y - s * 0.1);
        ctx.lineTo(x + s * 0.42, p.y - s * 1.35);
        ctx.quadraticCurveTo(x + s * 1.15, p.y - s * 1.05, x + s * 1.05, p.y - s * 0.55);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(x, p.y, s * 0.55, s * 0.4, -0.45, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fill();
        ctx.strokeStyle = p.color;
        ctx.lineWidth = s * 0.24;
        ctx.beginPath();
        ctx.moveTo(x + s * 0.42, p.y - s * 0.1);
        ctx.lineTo(x + s * 0.42, p.y - s * 1.35);
        ctx.quadraticCurveTo(x + s * 1.15, p.y - s * 1.05, x + s * 1.05, p.y - s * 0.55);
        ctx.stroke();
        break;
      }
      case K_STAR: {
        const tw = 0.6 + 0.4 * Math.sin(p.seed + p.t * 24);
        ctx.globalAlpha = (1 - u) * tw + 0.15 * (1 - u);
        const r = p.size * (u < 0.2 ? u / 0.2 : 1);
        const ri = r * 0.38;
        ctx.beginPath();
        for (let j = 0; j < 8; j++) {
          const rr = (j & 1) === 0 ? r : ri;
          const a = p.rot + (j * Math.PI) / 4;
          const px = p.x + Math.cos(a) * rr;
          const py = p.y + Math.sin(a) * rr;
          if (j === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      default:
        break;
    }
  }

  function drawRing(ctx: CanvasRenderingContext2D, r: Ring): void {
    const u = r.t / r.dur;
    const e = 1 - (1 - u) * (1 - u) * (1 - u);
    ctx.strokeStyle = r.color;
    switch (r.k) {
      case R_DRUM: {
        const rad = 26 + (FX.drumRingRadius - 26) * e;
        ctx.globalAlpha = 1 - u;
        ctx.lineWidth = 6 * (1 - u) + 1;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, rad, rad * 0.3, 0, 0, Math.PI * 2);
        ctx.stroke();
        if (u > 0.15) {
          const u2 = (u - 0.15) / 0.85;
          const e2 = 1 - (1 - u2) * (1 - u2);
          const rad2 = 18 + (FX.drumRingRadius * 0.75 - 18) * e2;
          ctx.globalAlpha = (1 - u2) * 0.7;
          ctx.lineWidth = 3 * (1 - u2) + 1;
          ctx.beginPath();
          ctx.ellipse(r.x, r.y, rad2, rad2 * 0.3, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case R_SHOCK: {
        const rad = 8 + (FX.shockRadius - 8) * e;
        ctx.globalAlpha = 0.28 * (1 - u);
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, rad, rad * 0.24, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1 - u * u;
        ctx.lineWidth = 8 * (1 - u) + 1.5;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, rad, rad * 0.24, 0, 0, Math.PI * 2);
        ctx.stroke();
        // vertical "crack" lines kicked up from the impact
        ctx.globalAlpha = (1 - u) * 0.8;
        ctx.lineWidth = 3 * (1 - u) + 1;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let j = 0; j < 6; j++) {
          const a = Math.PI + 0.25 + (j * (Math.PI - 0.5)) / 5;
          const ix = r.x + Math.cos(a) * rad * 0.65;
          const iy = r.y + Math.sin(a) * rad * 0.18;
          const ox = r.x + Math.cos(a) * (rad * 0.65 + 18 * (1 - u));
          const oy = r.y + Math.sin(a) * (rad * 0.18 + 22 * (1 - u)) - 6;
          ctx.moveTo(ix, iy);
          ctx.lineTo(ox, oy);
        }
        ctx.stroke();
        break;
      }
      case R_BOING: {
        for (let j = 0; j < 2; j++) {
          const uj = u - j * 0.18;
          if (uj <= 0) continue;
          const uu = uj / (1 - j * 0.18);
          const ee = 1 - (1 - uu) * (1 - uu);
          const rad = 12 + 46 * ee;
          const wob = 1 + Math.sin(uu * 22) * 0.18 * (1 - uu);
          ctx.globalAlpha = (1 - uu) * (j === 0 ? 1 : 0.6);
          ctx.lineWidth = 5 * (1 - uu) + 1;
          ctx.beginPath();
          ctx.ellipse(r.x, r.y + 4 - 10 * ee * j, rad * wob, rad * 0.34 / wob, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case R_PICKUP: {
        const rad = 10 + 40 * e;
        ctx.globalAlpha = 1 - u;
        ctx.lineWidth = 5 * (1 - u) + 1;
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let j = 0; j < 8; j++) {
          const a = (j * Math.PI) / 4 + 0.2;
          ctx.moveTo(r.x + Math.cos(a) * (rad + 4), r.y + Math.sin(a) * (rad + 4));
          ctx.lineTo(r.x + Math.cos(a) * (rad + 4 + 10 * (1 - u)), r.y + Math.sin(a) * (rad + 4 + 10 * (1 - u)));
        }
        ctx.stroke();
        break;
      }
      default:
        break;
    }
  }

  function drawPopup(ctx: CanvasRenderingContext2D, p: Popup, camNow: number, reduced: boolean): void {
    const t = p.t;
    let sc = 1;
    if (!reduced) {
      const st = FX.popupScaleT;
      if (t < st * 0.55) sc = (t / (st * 0.55)) * 1.2;
      else if (t < st) sc = 1.2 - 0.2 * ((t - st * 0.55) / (st * 0.45));
    }
    const u = t / p.life;
    let a = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
    if (reduced && t < 0.12) a *= t / 0.12;
    const drift = FX.popupDrift * (1 - (1 - u) * (1 - u));
    const x = p.x + (camNow - p.cam0) * POPUP_FOLLOW[p.size];
    const y = p.y - drift - p.lift;
    if (sc <= 0.01 || a <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    ctx.globalAlpha = a;
    ctx.font = POPUP_FONTS[p.size];
    ctx.lineWidth = POPUP_STROKE[p.size];
    ctx.strokeStyle = INK;
    ctx.fillStyle = p.color;
    ctx.strokeText(p.text, 0, 0);
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }

  function initLines(viewW: number, viewH: number): void {
    for (let i = 0; i < NL; i++) {
      lineX[i] = rand() * (viewW + 200);
      lineY[i] = viewH * (0.06 + 0.88 * rand());
      lineLen[i] = 60 + rand() * 150;
      lineSpd[i] = 1300 + rand() * 1000;
      lineW[i] = 1.5 + rand() * 2.5;
    }
    linesInit = true;
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  const api: FxApi = {
    burst(kind: ParticleKind, x: number, y: number, count: number, hue?: number): void {
      let n = count | 0;
      if (lowQ) n = (n + 1) >> 1;
      if (n <= 0) return;
      if (n > NP) n = NP;
      const k = kindCode(kind);
      const h = hue === undefined ? -1 : hue;
      for (let i = 0; i < n; i++) spawnOne(k, x, y, h, i, n);
    },

    popup(x: number, y: number, text: string, color: string, size: PopupSize): void {
      const sz = sizeCode(size);
      // Stack on top of fresh popups that spawned nearby so texts never overlap.
      let lift = 0;
      for (let i = 0; i < NPOP; i++) {
        const q = pops[i];
        if (!q.on || q.t > 0.35) continue;
        const dx = q.x - x;
        const dy = q.y - q.lift - (y - lift);
        if (dx < 90 && dx > -90 && dy < 26 && dy > -26) lift += sz === 2 || q.size === 2 ? 34 : 24;
      }
      let p = pops[popCursor];
      for (let n = 0; n < NPOP; n++) {
        const i = (popCursor + n) % NPOP;
        if (!pops[i].on) {
          p = pops[i];
          popCursor = (i + 1) % NPOP;
          break;
        }
        if (n === NPOP - 1) popCursor = (popCursor + 1) % NPOP;
      }
      p.on = true;
      p.x = x;
      p.y = y;
      p.cam0 = state.cam.x;
      p.text = text;
      p.color = color;
      p.size = sz;
      p.t = 0;
      p.life = sz === 2 ? FX.popupLifeBig : FX.popupLife;
      p.lift = lift;
    },

    ring(kind: RingKind, x: number, y: number, hue: number): void {
      let r = rings[ringCursor];
      for (let n = 0; n < NR; n++) {
        const i = (ringCursor + n) % NR;
        if (!rings[i].on) {
          r = rings[i];
          ringCursor = (i + 1) % NR;
          break;
        }
        if (n === NR - 1) ringCursor = (ringCursor + 1) % NR;
      }
      const k = ringCode(kind);
      r.on = true;
      r.k = k;
      r.x = x;
      r.y = y;
      r.t = 0;
      switch (k) {
        case R_DRUM:
          r.dur = FX.drumRingDur;
          r.color = hueColor(hue, WHITE);
          break;
        case R_SHOCK:
          r.dur = FX.shockDur;
          r.color = hue >= 0 ? hueColor(hue, SHOCK_COLOR) : SHOCK_COLOR;
          break;
        case R_BOING:
          r.dur = 0.38;
          r.color = hueColor(hue, WHITE);
          break;
        default:
          r.dur = 0.3;
          r.color = hueColor(hue, '#FFF3A3');
          break;
      }
    },

    shake(amount: number): void {
      if (state.save.reducedMotion) return;
      const t = state.cam.trauma + amount;
      state.cam.trauma = t > 1 ? 1 : t < 0 ? 0 : t;
    },

    flash(color: string, alpha: number): void {
      if (state.save.reducedMotion) return;
      flashColor = color;
      const a = alpha > 1 ? 1 : alpha;
      if (a > flashA) {
        flashA = a;
        flashA0 = a;
      }
    },

    update(realDt: number): void {
      const dt = realDt > 0.1 ? 0.1 : realDt < 0 ? 0 : realDt;
      time += dt;

      // Trauma shake (spec §10.3): 12 u * trauma^2, summed sines, decay 2.2/s.
      const cam = state.cam;
      cam.trauma -= SHAKE.decay * dt;
      if (cam.trauma < 0) cam.trauma = 0;
      if (state.save.reducedMotion || cam.trauma === 0) {
        cam.shakeX = 0;
        cam.shakeY = 0;
        if (state.save.reducedMotion) cam.trauma = 0;
      } else {
        const amp = SHAKE.maxOffset * cam.trauma * cam.trauma;
        cam.shakeX = amp * (Math.sin(time * SHAKE.freqX) * 0.6 + Math.sin(time * SHAKE.freqX * 2.3 + 1.7) * 0.4);
        cam.shakeY = amp * (Math.sin(time * SHAKE.freqY + 0.5) * 0.6 + Math.sin(time * SHAKE.freqY * 1.9 + 2.9) * 0.4);
      }

      // Particles
      let n = 0;
      for (let i = 0; i < NP; i++) {
        const p = parts[i];
        if (!p.on) continue;
        p.t += dt;
        if (p.t >= p.life) {
          p.on = false;
          continue;
        }
        n++;
        if (p.rest) {
          p.vx *= 1 / (1 + 10 * dt);
          p.x += p.vx * dt;
          continue;
        }
        p.vy += p.g * dt;
        if (p.drag > 0) {
          const d = 1 / (1 + p.drag * dt);
          p.vx *= d;
          p.vy *= d;
        }
        if (p.k === K_FEATHER) p.vx += Math.sin(p.seed + p.t * 5) * 260 * dt;
        else if (p.k === K_CONFETTI) p.vx += Math.sin(p.seed + p.t * 4) * 180 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (p.y > GROUND_Y && p.vy > 0) {
          switch (p.k) {
            case K_PEBBLE:
            case K_CHIP:
            case K_SEED:
              p.y = GROUND_Y;
              if (p.vy > 220) {
                p.vy *= -0.38;
                p.vx *= 0.6;
                p.vr *= 0.5;
              } else {
                p.vy = 0;
                p.g = 0;
                p.vr = 0;
                p.rest = true;
              }
              break;
            case K_JUICE:
            case K_MUD:
            case K_CONFETTI:
            case K_FEATHER:
              p.y = GROUND_Y;
              p.vy = 0;
              p.g = 0;
              p.vr = 0;
              p.rest = true;
              break;
            default:
              break;
          }
        }
      }
      activeParticles = n;

      for (let i = 0; i < NPOP; i++) {
        const p = pops[i];
        if (!p.on) continue;
        p.t += dt;
        if (p.t >= p.life) p.on = false;
      }
      for (let i = 0; i < NR; i++) {
        const r = rings[i];
        if (!r.on) continue;
        r.t += dt;
        if (r.t >= r.dur) r.on = false;
      }

      if (flashA > 0) {
        flashA -= (flashA0 > 0 ? flashA0 : 1) * dt * 5.5;
        if (flashA < 0) flashA = 0;
      }

      const target = state.fever.active ? 1 : 0;
      if (feverVis < target) feverVis = Math.min(target, feverVis + dt * 3.5);
      else if (feverVis > target) feverVis = Math.max(target, feverVis - dt * 2.2);

      if (feverVis > 0 && !state.save.reducedMotion) {
        const v = state.view;
        if (!linesInit) initLines(v.viewW, v.viewH);
        for (let i = 0; i < NL; i++) {
          lineX[i] -= lineSpd[i] * dt;
          if (lineX[i] + lineLen[i] < 0) {
            lineX[i] = v.viewW + rand() * 240;
            lineY[i] = v.viewH * (0.06 + 0.88 * rand());
            lineLen[i] = 60 + rand() * 150;
            lineSpd[i] = 1300 + rand() * 1000;
          }
        }
      }
    },

    drawWorld(ctx: CanvasRenderingContext2D): void {
      const reduced = state.save.reducedMotion;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (let i = 0; i < NR; i++) {
        const r = rings[i];
        if (r.on) drawRing(ctx, r);
      }
      for (let i = 0; i < NP; i++) {
        const p = parts[i];
        if (p.on) drawParticle(ctx, p);
      }
      let anyPop = false;
      for (let i = 0; i < NPOP; i++) {
        if (pops[i].on) {
          anyPop = true;
          break;
        }
      }
      if (anyPop) {
        const cam = state.cam;
        const camNow = cam.prevX + (cam.x - cam.prevX) * state.clock.alpha;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        for (let i = 0; i < NPOP; i++) {
          const p = pops[i];
          if (p.on) drawPopup(ctx, p, camNow, reduced);
        }
      }
      ctx.globalAlpha = 1;
    },

    drawScreen(ctx: CanvasRenderingContext2D): void {
      const v = state.view;
      const reduced = state.save.reducedMotion;
      if (feverVis > 0) {
        // Warm vignette (cached radial gradient, rebuilt only on resize).
        if (vignette === null || vignetteVersion !== v.version || vignetteCtx !== ctx) {
          const cx = v.viewW * 0.5;
          const cy = v.viewH * 0.5;
          const outer = Math.sqrt(cx * cx + cy * cy);
          const g = ctx.createRadialGradient(cx, cy, Math.min(cx, cy) * 0.55, cx, cy, outer);
          g.addColorStop(0, VIGNETTE_CLEAR);
          g.addColorStop(0.55, VIGNETTE_MID);
          g.addColorStop(1, VIGNETTE_EDGE);
          vignette = g;
          vignetteVersion = v.version;
          vignetteCtx = ctx;
        }
        let a = FX.vignetteAlpha * feverVis;
        if (!reduced) {
          const bp = state.music.beatPhase;
          const pulse = (1 - bp) * (1 - bp);
          a *= 0.85 + 0.35 * pulse;
          if (state.fever.active && state.fever.t < 1.5) a *= 0.75 + 0.25 * Math.sin(time * 18);
        }
        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, v.viewW, v.viewH);

        if (!reduced) {
          if (!linesInit) initLines(v.viewW, v.viewH);
          ctx.lineCap = 'round';
          for (let i = 0; i < NL; i++) {
            ctx.globalAlpha = 0.45 * feverVis;
            ctx.strokeStyle = (i & 1) === 0 ? WHITE : SPEED_LINE_WARM;
            ctx.lineWidth = lineW[i];
            ctx.beginPath();
            ctx.moveTo(lineX[i], lineY[i]);
            ctx.lineTo(lineX[i] + lineLen[i], lineY[i]);
            ctx.stroke();
          }
        }
      }
      if (flashA > 0 && !reduced) {
        ctx.globalAlpha = flashA;
        ctx.fillStyle = flashColor;
        ctx.fillRect(0, 0, v.viewW, v.viewH);
      }
      ctx.globalAlpha = 1;
    },

    clear(): void {
      for (let i = 0; i < NP; i++) parts[i].on = false;
      for (let i = 0; i < NPOP; i++) pops[i].on = false;
      for (let i = 0; i < NR; i++) rings[i].on = false;
      activeParticles = 0;
      flashA = 0;
      feverVis = 0;
      state.cam.trauma = 0;
      state.cam.shakeX = 0;
      state.cam.shakeY = 0;
    },

    setLowQuality(on: boolean): void {
      lowQ = on;
    },

    count(): number {
      return activeParticles;
    },
  };
  return api;
}
