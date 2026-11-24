/**
 * Toto, the hero: procedural drawing, verlet bandana ribbons, blinks. Owner: ART engineer.
 *
 * Everything is drawn around the FEET origin (x right, y down, so the body is at negative y),
 * facing right. The caller fills a TotoView every frame from hero state (render.ts) and calls
 * rig.step() (ribbon + blink, real dt) then rig.draw(). No allocation after createTotoRig().
 *
 * Layering (back to front): ribbons -> far legs -> far ear -> tail -> near legs ->
 * silhouette (body + head + snout union: rim light, outline, fill) -> belly + underside ->
 * snout details, mouth, tooth -> cheek -> eye + brow -> near ear -> bandana -> Mud Coat ->
 * extras (sweat drop, orbiting stars, Zzz + nose bubble, slam streaks).
 */
import { PAL, TOTO_ART } from './config';
import type { HeroExpr, HeroPose } from './types';
import { TAU, clampN, dot, oval, starPath, undersidePath } from './render-util';
import { hash01 } from './rng';

/** Per-frame inputs for one Toto drawing (filled by the caller, reused). */
export interface TotoView {
  pose: HeroPose;
  expr: HeroExpr;
  squashX: number;
  squashY: number;
  /** Extra body rotation (radians, + clockwise) about the body centre. */
  rot: number;
  runPhase: number;
  vy: number;
  /** Pupil direction (unit-ish, -1..1) toward the look target. */
  lookX: number;
  lookY: number;
  cheekPuff: number;
  sweatT: number;
  /** White outline (near-miss flash). */
  flash: boolean;
  shield: boolean;
  fever: boolean;
  deathT: number;
  /** 0..1 night rim light. */
  night: number;
  /** Render time (s) for idle wobbles. */
  time: number;
  /** Uniform draw scale about the feet (TOTOTO TIME entry pop; 1 otherwise). Cosmetic only. */
  scale: number;
}

export function makeTotoView(): TotoView {
  return {
    pose: 'run',
    expr: 'serious',
    squashX: 1,
    squashY: 1,
    rot: 0,
    runPhase: 0,
    vy: 0,
    lookX: 1,
    lookY: 0,
    cheekPuff: 0,
    sweatT: 0,
    flash: false,
    shield: false,
    fever: false,
    deathT: 0,
    night: 0,
    time: 0,
    scale: 1,
  };
}

/* ------------------------------------------------------------------ */
/* Geometry (local u, feet origin)                                      */
/* ------------------------------------------------------------------ */

const BODY_CX = -6;
const BODY_CY = -29;
const BODY_RX = TOTO_ART.bodyW / 2;
const BODY_RY = TOTO_ART.bodyH / 2;
const HEAD_CX = 14;
const HEAD_CY = -42;
const HEAD_RX = TOTO_ART.headW / 2;
const HEAD_RY = TOTO_ART.headH / 2;
const SNOUT_CX = 31;
const SNOUT_CY = -33;
const SNOUT_RX = TOTO_ART.snoutW / 2;
const SNOUT_RY = TOTO_ART.snoutH / 2;
/** Rotation pivot (body centre). */
const PIVOT_X = -4;
const PIVOT_Y = -30;
const EYE_X = 20;
const EYE_Y = -48;
const EYE_RX = 6.3;
const EYE_RY = 7.4;
/** Bandana knot: on the collar at the back of the head (angle 1.1 pi of the head ellipse). */
const KNOT_X = -5.5;
const KNOT_Y = -48;

const INK = PAL.outline;
const TOTO_DARK = '#4B448F';
const MOUTH_IN = '#5A1E3A';
const TONGUE = '#FF7FA8';
const SWEAT = '#8FD8FF';
const WHITE = '#FFFFFF';
const NAIL = '#EEEAFF';
const ZZZ_FONT = 'bold 13px ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif';
const RIM = PAL.nightRim;
const RIBBON_B = '#E8484E';

/* Leg table: hip x/y and run-phase offset; near legs first two entries are FAR legs. */
const LEG_HX: ReadonlyArray<number> = [19, -16, 12, -22];
const LEG_HY: ReadonlyArray<number> = [-18, -17, -16, -15];
const LEG_OFF: ReadonlyArray<number> = [Math.PI, 0, 0, Math.PI];
const LEG_FAR: ReadonlyArray<boolean> = [true, true, false, false];
const LEG_FRONT: ReadonlyArray<boolean> = [true, false, true, false];

/* Ribbon */
const RIB_A_N = TOTO_ART.ribbonPoints;
const RIB_A_SEG = TOTO_ART.ribbonSeg;
const RIB_B_N = 5;
const RIB_B_SEG = 5.5;
/** Minimum effective wind for the bandana (u/s). */
const MIN_BREEZE = 240;
/** Share of the knot's own motion the tails follow rigidly (the rest becomes secondary motion). */
const CARRY_X = 0.85;
const CARRY_Y = 0.7;

export interface TotoRig {
  /** Advance ribbons/blinks. feetX/feetY = logical screen position of the feet; wind = scroll speed u/s. */
  step(dt: number, v: TotoView, feetX: number, feetY: number, wind: number, whip: number): void;
  /** Snap ribbons to rest (after a teleport / restart). */
  reset(v: TotoView, feetX: number, feetY: number): void;
  /**
   * Draw Toto. Device transform for logical (lx, ly) = (K * lx + ox, K * ly + oy); feet at logical
   * (x, y). `feetRefX/Y` = the logical feet position the ribbons were simulated at (so the same
   * rig can be drawn into an offscreen buffer at another position).
   */
  draw(ctx: CanvasRenderingContext2D, v: TotoView, K: number, ox: number, oy: number, x: number, y: number): void;
}

export function createTotoRig(blinkSalt: number): TotoRig {
  const ax = new Float32Array(RIB_A_N);
  const ay = new Float32Array(RIB_A_N);
  const apx = new Float32Array(RIB_A_N);
  const apy = new Float32Array(RIB_A_N);
  const bx = new Float32Array(RIB_B_N);
  const by = new Float32Array(RIB_B_N);
  const bpx = new Float32Array(RIB_B_N);
  const bpy = new Float32Array(RIB_B_N);
  let simFeetX = 0;
  let simFeetY = 0;
  let ready = false;
  let lastWhip = 0;
  // blink
  let blinkCount = 0;
  let nextBlink = 2.5;
  let blinkStart = -10;
  let clock = 0;
  // scratch for pin transform
  let pinX = 0;
  let pinY = 0;
  let lastPinX = 0;
  let lastPinY = 0;
  // body ellipse in screen space (ribbon collider)
  let colX = 0;
  let colY = 0;
  let colRX = 1;
  let colRY = 1;
  let bob = 0;
  let tilt = 0;

  /** Body bob + derived tilt for the current pose (shared by step and draw). */
  function poseMotion(v: TotoView): void {
    bob = 0;
    tilt = 0;
    switch (v.pose) {
      case 'run':
        bob = -Math.abs(Math.sin(v.runPhase)) * 2.6;
        tilt = Math.sin(v.runPhase * 2) * 0.025;
        break;
      case 'idle':
        bob = Math.sin(v.time * 2.4) * 0.9;
        break;
      case 'air':
        tilt = clampN(v.vy * 0.00017, -0.15, 0.2);
        break;
      case 'sit':
        bob = 3;
        tilt = -0.2;
        break;
      case 'sink':
        bob = 2;
        tilt = -0.1;
        break;
      default:
        break;
    }
  }

  /** Local point -> logical screen, through bob, rotation about the pivot and squash. */
  function toScreen(v: TotoView, lx: number, ly: number, feetX: number, feetY: number): void {
    const r = v.rot + tilt;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const dx = lx - PIVOT_X;
    const dy = ly + bob - PIVOT_Y;
    const rx = PIVOT_X + dx * c - dy * s;
    const ry = PIVOT_Y + dx * s + dy * c;
    pinX = feetX + rx * v.squashX;
    pinY = feetY + ry * v.squashY;
  }

  function resetRibbon(feetX: number, feetY: number): void {
    for (let i = 0; i < RIB_A_N; i++) {
      ax[i] = pinX - i * RIB_A_SEG;
      ay[i] = pinY + i * 1.5;
      apx[i] = ax[i];
      apy[i] = ay[i];
    }
    for (let i = 0; i < RIB_B_N; i++) {
      bx[i] = pinX - i * RIB_B_SEG;
      by[i] = pinY + 2 + i * 2.5;
      bpx[i] = bx[i];
      bpy[i] = by[i];
    }
    simFeetX = feetX;
    simFeetY = feetY;
    lastPinX = pinX;
    lastPinY = pinY;
    ready = true;
  }

  function integrate(
    px: Float32Array,
    py: Float32Array,
    ox: Float32Array,
    oy: Float32Array,
    n: number,
    seg: number,
    h: number,
    wind: number,
    phase: number,
    kick: number,
    carryX: number,
    carryY: number,
  ): void {
    px[0] = pinX;
    py[0] = pinY;
    ox[0] = pinX;
    oy[0] = pinY;
    const windAcc = -(380 + wind * 3.4);
    for (let i = 1; i < n; i++) {
      const f = i / (n - 1);
      // Most of Toto's own motion is carried by the tails (they are tied to him); the rest lags.
      px[i] += carryX;
      py[i] += carryY;
      ox[i] += carryX;
      oy[i] += carryY;
      const vx = (px[i] - ox[i]) * 0.982;
      const vy = (py[i] - oy[i]) * 0.982;
      ox[i] = px[i];
      oy[i] = py[i];
      const flutter = Math.sin(clock * (13 + wind * 0.012) + i * 1.35 + phase) * (260 + wind * 1.6) * f;
      px[i] += vx + windAcc * h * h;
      py[i] += vy + (700 + flutter) * h * h;
      if (kick !== 0) {
        oy[i] += kick * f * 7;
        ox[i] -= kick * f * 3;
      }
    }
    for (let it = 0; it < 3; it++) {
      for (let i = 1; i < n; i++) {
        const dx = px[i] - px[i - 1];
        const dy = py[i] - py[i - 1];
        const d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
        const corr = (d - seg) / d;
        if (i === 1) {
          px[i] -= dx * corr;
          py[i] -= dy * corr;
        } else {
          px[i] -= dx * corr * 0.5;
          py[i] -= dy * corr * 0.5;
          px[i - 1] += dx * corr * 0.5;
          py[i - 1] += dy * corr * 0.5;
        }
      }
      // drape: keep the tails outside the body ellipse so they lie along his back
      for (let i = 1; i < n; i++) {
        const ex = (px[i] - colX) / colRX;
        const ey = (py[i] - colY) / colRY;
        const nd = ex * ex + ey * ey;
        if (nd < 1 && nd > 1e-6) {
          const k = 1 / Math.sqrt(nd);
          px[i] = colX + ex * k * colRX;
          py[i] = colY + ey * k * colRY;
        }
      }
    }
  }

  /* -------------------------- drawing helpers -------------------------- */

  function leg(
    ctx: CanvasRenderingContext2D,
    hx: number,
    hy: number,
    fx: number,
    fy: number,
    color: string,
    ink: string,
    nails: boolean,
  ): void {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 14.5;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(fx, fy);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 9;
    ctx.stroke();
    if (nails) {
      ctx.fillStyle = NAIL;
      ctx.beginPath();
      dot(ctx, fx + 2.2, fy + 4.2, 1.5);
      dot(ctx, fx + 4.6, fy + 2.4, 1.3);
      ctx.fill();
    }
  }

  function ear(ctx: CanvasRenderingContext2D, bx0: number, by0: number, ang: number, ink: string, far: boolean): void {
    const dxu = Math.sin(ang);
    const dyu = -Math.cos(ang);
    const cx = bx0 + dxu * 4.6;
    const cy = by0 + dyu * 4.6;
    ctx.beginPath();
    oval(ctx, cx, cy, 4.6, 6.4, ang);
    ctx.fillStyle = far ? PAL.totoUnder : PAL.totoBody;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.6;
    ctx.stroke();
    ctx.beginPath();
    oval(ctx, cx + dxu * 0.7, cy + dyu * 0.7, 2.2, 3.8, ang);
    ctx.fillStyle = PAL.totoCheek;
    ctx.fill();
  }

  function silhouette(ctx: CanvasRenderingContext2D, snoutScale: number): void {
    ctx.beginPath();
    oval(ctx, BODY_CX, BODY_CY, BODY_RX, BODY_RY, 0);
    ctx.moveTo(HEAD_CX + HEAD_RX, HEAD_CY);
    oval(ctx, HEAD_CX, HEAD_CY, HEAD_RX, HEAD_RY, 0);
    ctx.moveTo(SNOUT_CX + SNOUT_RX * snoutScale, SNOUT_CY);
    oval(ctx, SNOUT_CX, SNOUT_CY, SNOUT_RX * snoutScale, SNOUT_RY * snoutScale, 0);
  }

  function brow(ctx: CanvasRenderingContext2D, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): void {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }

  function drawEye(ctx: CanvasRenderingContext2D, v: TotoView, ink: string, blinking: boolean): void {
    const ex = EYE_X;
    const ey = EYE_Y;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const expr = v.expr;
    // ---- special eyes ----
    if (expr === 'star') {
      const pulse = 1 + Math.sin(v.time * 10) * 0.08;
      ctx.beginPath();
      starPath(ctx, ex, ey, 8.6 * pulse, 4.1 * pulse, 5, Math.sin(v.time * 3) * 0.2);
      ctx.fillStyle = PAL.golden;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      dot(ctx, ex - 2, ey - 2.6, 1.5);
      ctx.fill();
      return;
    }
    if (expr === 'dizzy') {
      ctx.beginPath();
      oval(ctx, ex, ey, EYE_RX, EYE_RY, 0);
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      const spin = v.time * 7;
      for (let j = 0; j <= 22; j++) {
        const a = spin + j * 0.62;
        const r = 0.25 * j;
        const px = ex + Math.cos(a) * r;
        const py = ey + Math.sin(a) * r * 1.1;
        if (j === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      return;
    }
    if (expr === 'sleep') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(ex - 5.5, ey);
      ctx.quadraticCurveTo(ex, ey + 4.5, ex + 5.5, ey - 0.5);
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(ex - 4.5, ey + 2);
      ctx.lineTo(ex - 6.5, ey + 4.5);
      ctx.moveTo(ex - 1.5, ey + 3.4);
      ctx.lineTo(ex - 2.4, ey + 6);
      ctx.stroke();
      return;
    }
    if (expr === 'squint') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ex - 5, ey - 5);
      ctx.lineTo(ex + 4, ey);
      ctx.lineTo(ex - 5, ey + 5);
      ctx.stroke();
      ctx.lineWidth = 2.6;
      brow(ctx, ex - 7, ey - 9, ex, ey - 11, ex + 7, ey - 7.5);
      return;
    }
    if (expr === 'joy') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ex - 6, ey + 1.5);
      ctx.quadraticCurveTo(ex, ey - 7.5, ex + 6, ey + 1.5);
      ctx.stroke();
      ctx.lineWidth = 2.4;
      brow(ctx, ex - 6, ey - 11, ex + 1, ey - 15, ex + 7, ey - 11);
      return;
    }
    if (blinking) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(ex - 6, ey + 0.5);
      ctx.quadraticCurveTo(ex, ey + 3.5, ex + 6, ey + 0.5);
      ctx.stroke();
      ctx.lineWidth = 3;
      brow(ctx, ex - 7, ey - 10, ex, ey - 11, ex + 7, ey - 7.5);
      return;
    }
    // ---- open eye (serious / o / sweat) ----
    const wide = expr === 'o' || expr === 'sweat' ? 1.08 : 1;
    ctx.beginPath();
    oval(ctx, ex, ey, EYE_RX * wide, EYE_RY * wide, 0);
    ctx.fillStyle = WHITE;
    ctx.fill();
    const pr = expr === 'sweat' ? 2.6 : expr === 'o' ? 3.3 : 3.6;
    const pm = TOTO_ART.pupilMax;
    const px = ex + 0.6 + v.lookX * pm;
    const py = ey + 0.4 + v.lookY * pm;
    ctx.fillStyle = PAL.totoEye;
    ctx.beginPath();
    dot(ctx, px, py, pr);
    ctx.fill();
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    dot(ctx, px - 1.3, py - 1.6, pr * 0.42);
    ctx.fill();
    ctx.beginPath();
    dot(ctx, px + 1.3, py + 1.3, pr * 0.18);
    ctx.fill();
    if (expr === 'serious') {
      // heavy, determined upper lid
      const a0 = Math.PI + 0.42;
      const a1 = TAU - 0.42;
      ctx.beginPath();
      ctx.ellipse(ex, ey, EYE_RX + 0.4, EYE_RY + 0.4, 0, a0, a1, false);
      ctx.closePath();
      ctx.fillStyle = PAL.totoBody;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(ex + Math.cos(a0) * (EYE_RX + 0.4), ey + Math.sin(a0) * (EYE_RY + 0.4));
      ctx.lineTo(ex + Math.cos(a1) * (EYE_RX + 0.4), ey + Math.sin(a1) * (EYE_RY + 0.4));
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    oval(ctx, ex, ey, EYE_RX * wide, EYE_RY * wide, 0);
    ctx.stroke();
    // brow
    ctx.lineWidth = 3.2;
    if (expr === 'serious') brow(ctx, ex - 7.5, ey - 10.5, ex, ey - 10, ex + 7.5, ey - 6.5);
    else if (expr === 'o') brow(ctx, ex - 6.5, ey - 12.5, ex + 1, ey - 17, ex + 7.5, ey - 12);
    else brow(ctx, ex - 7, ey - 9.5, ex + 1, ey - 12, ex + 7.5, ey - 14);
  }

  function drawMouth(ctx: CanvasRenderingContext2D, v: TotoView, ink: string): void {
    const expr = v.expr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (expr === 'joy' || expr === 'star') {
      ctx.beginPath();
      ctx.moveTo(21, -27.5);
      ctx.quadraticCurveTo(31, -9, 44.5, -26);
      ctx.closePath();
      ctx.fillStyle = MOUTH_IN;
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = TONGUE;
      ctx.beginPath();
      oval(ctx, 31, -15, 7, 4.6, -0.1);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(21, -27.5);
      ctx.quadraticCurveTo(31, -9, 44.5, -26);
      ctx.closePath();
      ctx.stroke();
      // tooth on the upper lip
      ctx.fillStyle = PAL.totoTooth;
      ctx.beginPath();
      ctx.rect(36, -27, 4.2, 4.6);
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.stroke();
      return;
    }
    if (expr === 'o') {
      ctx.fillStyle = MOUTH_IN;
      ctx.beginPath();
      oval(ctx, 33, -24.5, 3.6, 4.4, 0);
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      return;
    }
    if (expr === 'dizzy' || expr === 'sweat') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(23, -26);
      const w = expr === 'dizzy' ? Math.sin(v.time * 6) * 1.2 : 0;
      ctx.quadraticCurveTo(27, -23 + w, 31, -26);
      ctx.quadraticCurveTo(35, -29 - w, 39, -26);
      ctx.quadraticCurveTo(42, -24, 44, -26.5);
      ctx.stroke();
      ctx.fillStyle = PAL.totoTooth;
      ctx.beginPath();
      ctx.rect(36.5, -26, 3.8, 4);
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.stroke();
      return;
    }
    if (expr === 'sleep') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(24, -25.5);
      ctx.quadraticCurveTo(33, -22, 43, -25.5);
      ctx.stroke();
      return;
    }
    // serious / squint: firm line with the tiny square tooth poking down
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(22, -25.5);
    ctx.quadraticCurveTo(33, expr === 'squint' ? -26.5 : -24.5, 44.5, -26.5);
    ctx.stroke();
    ctx.fillStyle = PAL.totoTooth;
    ctx.beginPath();
    ctx.rect(37, -25.6, 4, 4.4);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  function drawMudCoat(ctx: CanvasRenderingContext2D, v: TotoView, ink: string): void {
    const t = v.time;
    const a0 = ctx.globalAlpha;
    ctx.save();
    // clip to the body + head silhouette so splats wrap his outline
    ctx.beginPath();
    oval(ctx, BODY_CX, BODY_CY, BODY_RX, BODY_RY, 0);
    ctx.moveTo(HEAD_CX + HEAD_RX, HEAD_CY);
    oval(ctx, HEAD_CX, HEAD_CY, HEAD_RX, HEAD_RY, 0);
    ctx.clip();
    const d1 = 5 + Math.sin(t * 2.1) * 2.2;
    const d2 = 4 + Math.sin(t * 2.7 + 1) * 1.8;
    const d3 = 3.5 + Math.sin(t * 1.7 + 2) * 1.6;
    ctx.beginPath();
    // big splat over the back
    oval(ctx, -16, -50, 21, 13, -0.08);
    ctx.moveTo(-26 + 12, -40);
    oval(ctx, -26, -40, 12, 9, 0.3);
    ctx.moveTo(-1 + 8, -51);
    oval(ctx, -1, -51, 8, 7, 0);
    // cap on the head between the ears
    ctx.moveTo(14 + 9, -61);
    oval(ctx, 14, -61, 9, 6, 0.2);
    // drips (rounded runs hanging off the splats)
    ctx.moveTo(-31, -36);
    ctx.quadraticCurveTo(-30, -30 + d1, -27.5, -27 + d1);
    ctx.quadraticCurveTo(-25, -30 + d1, -24, -37);
    ctx.moveTo(-14, -40);
    ctx.quadraticCurveTo(-13, -35 + d2, -11, -32 + d2);
    ctx.quadraticCurveTo(-9, -35 + d2, -8, -41);
    ctx.moveTo(-3, -46);
    ctx.quadraticCurveTo(-2, -42 + d3, 0, -40 + d3);
    ctx.quadraticCurveTo(2, -42 + d3, 3, -46);
    ctx.fillStyle = PAL.mudCoat;
    ctx.fill();
    // darker specks + wet shine
    ctx.fillStyle = PAL.mudCoatDark;
    ctx.beginPath();
    dot(ctx, -24, -47, 2.2);
    dot(ctx, -9, -54, 1.6);
    dot(ctx, -30, -41, 1.5);
    dot(ctx, 15, -62, 1.4);
    ctx.fill();
    ctx.globalAlpha = a0 * 0.45;
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    oval(ctx, -19, -56, 7, 2.2, -0.15);
    oval(ctx, 11, -64, 3.2, 1.3, -0.3);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = a0;
    // a fat drop swells on the belly, lets go and falls away
    const cyc = (t * 0.8) % 1;
    const dx = -24;
    if (cyc < 0.6) {
      const r = 1.6 + cyc * 2.2;
      ctx.beginPath();
      ctx.moveTo(dx, -9 - r * 1.6);
      ctx.quadraticCurveTo(dx + r * 1.1, -9 - r * 0.2, dx, -9 + r);
      ctx.quadraticCurveTo(dx - r * 1.1, -9 - r * 0.2, dx, -9 - r * 1.6);
      ctx.fillStyle = PAL.mudCoat;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    } else {
      const u = (cyc - 0.6) / 0.4;
      ctx.globalAlpha = a0 * (1 - u);
      ctx.fillStyle = PAL.mudCoat;
      ctx.beginPath();
      ctx.arc(dx - u * 4, -7 + u * u * 26, 2.6, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a0;
    }
  }

  function drawBandana(ctx: CanvasRenderingContext2D, ink: string): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // collar hugging the back/bottom of the head where it meets the body
    ctx.beginPath();
    ctx.ellipse(HEAD_CX, HEAD_CY, HEAD_RX - 2, HEAD_RY - 1.5, 0, Math.PI * 0.52, Math.PI * 1.12, false);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.strokeStyle = PAL.totoBandana;
    ctx.lineWidth = 5;
    ctx.stroke();
    // bib triangle under the chin
    ctx.beginPath();
    ctx.moveTo(3, -29);
    ctx.lineTo(18, -26.5);
    ctx.lineTo(8.5, -14);
    ctx.closePath();
    ctx.fillStyle = PAL.totoBandana;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    // polka dots
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    dot(ctx, 9.5, -24, 1.5);
    dot(ctx, -6.4, -38, 1.2);
    ctx.fill();
    // knot
    ctx.beginPath();
    oval(ctx, KNOT_X, KNOT_Y, 4.4, 3.8, -0.5);
    ctx.fillStyle = PAL.totoBandana;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  function drawRibbons(ctx: CanvasRenderingContext2D, dx: number, dy: number, ink: string): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let r = 0; r < 2; r++) {
        const px = r === 0 ? ax : bx;
        const py = r === 0 ? ay : by;
        const n = r === 0 ? RIB_A_N : RIB_B_N;
        ctx.beginPath();
        ctx.moveTo(px[0] + dx, py[0] + dy);
        for (let i = 1; i < n - 1; i++) {
          const mx = (px[i] + px[i + 1]) * 0.5;
          const my = (py[i] + py[i + 1]) * 0.5;
          ctx.quadraticCurveTo(px[i] + dx, py[i] + dy, mx + dx, my + dy);
        }
        ctx.lineTo(px[n - 1] + dx, py[n - 1] + dy);
        if (pass === 0) {
          ctx.strokeStyle = ink;
          ctx.lineWidth = r === 0 ? 9.5 : 8.5;
        } else {
          ctx.strokeStyle = r === 0 ? PAL.totoBandana : RIBBON_B;
          ctx.lineWidth = r === 0 ? 4.6 : 3.8;
        }
        ctx.stroke();
      }
    }
  }

  function drawStars(ctx: CanvasRenderingContext2D, v: TotoView, ink: string): void {
    const cx = HEAD_CX - 2;
    const cy = HEAD_CY - 24;
    for (let i = 0; i < 3; i++) {
      const a = v.deathT * 5.5 + v.time * 1.5 + (i * TAU) / 3;
      const depth = Math.sin(a);
      const sx = cx + Math.cos(a) * 20;
      const sy = cy + depth * 6;
      const r = 5.2 + depth * 1.2;
      ctx.beginPath();
      starPath(ctx, sx, sy, r, r * 0.45, 5, a * 0.5);
      ctx.fillStyle = PAL.golden;
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
  }

  function drawZzz(ctx: CanvasRenderingContext2D, v: TotoView, ink: string): void {
    ctx.font = ZZZ_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (let i = 0; i < 3; i++) {
      const u = (v.time * 0.45 + i / 3) % 1;
      const x = HEAD_CX + 6 + u * 16 + Math.sin(u * 6 + i) * 3;
      const y = HEAD_CY - 26 - u * 26;
      const sc = 0.6 + u * 0.7;
      ctx.globalAlpha = u < 0.15 ? u / 0.15 : u > 0.75 ? (1 - u) / 0.25 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(sc, sc);
      ctx.lineWidth = 4;
      ctx.strokeStyle = ink;
      ctx.strokeText('z', 0, 0);
      ctx.fillStyle = WHITE;
      ctx.fillText('z', 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // nose bubble
    const b = 2.5 + (0.5 + 0.5 * Math.sin(v.time * 1.7)) * 5;
    ctx.beginPath();
    dot(ctx, 46 + b * 0.6, -40 - b * 0.2, b);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#DDF3FF';
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    dot(ctx, 46 + b * 0.3, -40 - b * 0.6, b * 0.25);
    ctx.fill();
  }

  function drawSweat(ctx: CanvasRenderingContext2D, v: TotoView, ink: string): void {
    const u = clampN(1 - v.sweatT / 0.6, 0, 1);
    const x = HEAD_CX - 12 - u * 3;
    const y = HEAD_CY - 16 + u * 12;
    ctx.globalAlpha = u > 0.8 ? (1 - u) / 0.2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.quadraticCurveTo(x + 4.5, y - 1, x, y + 3.5);
    ctx.quadraticCurveTo(x - 4.5, y - 1, x, y - 7);
    ctx.fillStyle = SWEAT;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    dot(ctx, x - 1.2, y - 0.5, 1.1);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Toto local transform: feet origin -> squash -> rotation about the pivot (-> bob). */
  function applyLocal(
    ctx: CanvasRenderingContext2D,
    v: TotoView,
    K: number,
    ox: number,
    oy: number,
    x: number,
    y: number,
    withBob: boolean,
  ): void {
    const k = K * (v.scale > 0 ? v.scale : 1);
    ctx.setTransform(k, 0, 0, k, ox + x * K, oy + y * K);
    ctx.scale(v.squashX, v.squashY);
    const r = v.rot + tilt;
    if (r !== 0) {
      ctx.translate(PIVOT_X, PIVOT_Y);
      ctx.rotate(r);
      ctx.translate(-PIVOT_X, -PIVOT_Y);
    }
    if (withBob && bob !== 0) ctx.translate(0, bob);
  }

  /* -------------------------- the rig -------------------------- */

  const rig: TotoRig = {
    reset(v: TotoView, feetX: number, feetY: number): void {
      poseMotion(v);
      toScreen(v, KNOT_X, KNOT_Y, feetX, feetY);
      resetRibbon(feetX, feetY);
    },

    step(dt: number, v: TotoView, feetX: number, feetY: number, wind: number, whip: number): void {
      const d = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt;
      clock += d;
      // blinks (cosmetic, deterministic hash schedule)
      if (clock >= nextBlink) {
        blinkStart = clock;
        blinkCount++;
        nextBlink =
          clock + TOTO_ART.blinkMin + (TOTO_ART.blinkMax - TOTO_ART.blinkMin) * hash01(blinkCount, blinkSalt, 3);
        // occasional double blink
        if (hash01(blinkCount, blinkSalt, 7) < 0.18) nextBlink = clock + 0.26;
      }
      poseMotion(v);
      toScreen(v, BODY_CX, BODY_CY, feetX, feetY);
      colX = pinX;
      colY = pinY;
      colRX = BODY_RX * Math.abs(v.squashX) + 2.5;
      colRY = BODY_RY * Math.abs(v.squashY) + 2.5;
      toScreen(v, KNOT_X, KNOT_Y, feetX, feetY);
      if (!ready) resetRibbon(feetX, feetY);
      // Teleports (restart, resize) snap the ribbons instead of whipping them across the screen.
      const jx = feetX - simFeetX;
      const jy = feetY - simFeetY;
      if (jx * jx + jy * jy > 120 * 120) resetRibbon(feetX, feetY);
      simFeetX = feetX;
      simFeetY = feetY;
      let kick = 0;
      if (whip > lastWhip + 0.15) kick = whip;
      lastWhip = whip;
      // a festival breeze keeps the tails streaming back even when the world is slow / stopped
      const w = wind > MIN_BREEZE ? (wind < 1400 ? wind : 1400) : MIN_BREEZE;
      if (d <= 0) return;
      const steps = Math.min(8, Math.max(1, Math.ceil(d / (1 / 120))));
      const h = d / steps;
      const endX = pinX;
      const endY = pinY;
      const stepX = (endX - lastPinX) / steps;
      const stepY = (endY - lastPinY) / steps;
      for (let s = 0; s < steps; s++) {
        pinX = lastPinX + stepX * (s + 1);
        pinY = lastPinY + stepY * (s + 1);
        const cx = stepX * CARRY_X;
        const cy = stepY * CARRY_Y;
        integrate(ax, ay, apx, apy, RIB_A_N, RIB_A_SEG, h, w, 0, s === 0 ? kick : 0, cx, cy);
        integrate(bx, by, bpx, bpy, RIB_B_N, RIB_B_SEG, h, w * 0.9, 2.1, s === 0 ? kick * 0.8 : 0, cx, cy);
      }
      lastPinX = endX;
      lastPinY = endY;
    },

    draw(ctx: CanvasRenderingContext2D, v: TotoView, K: number, ox: number, oy: number, x: number, y: number): void {
      const ink = v.flash ? WHITE : INK;
      const pose = v.pose;
      const expr = v.expr;
      const blinking =
        clock - blinkStart < TOTO_ART.blinkDur && (expr === 'serious' || expr === 'o' || expr === 'sweat');
      poseMotion(v);

      // Bandana tails (simulated in screen space, draped around the body) go behind everything.
      if (ready) {
        // screen-space tails, scaled about the feet with the body (v.scale)
        const sc = v.scale > 0 ? v.scale : 1;
        ctx.setTransform(K * sc, 0, 0, K * sc, ox + x * K * (1 - sc), oy + y * K * (1 - sc));
        drawRibbons(ctx, x - simFeetX, y - simFeetY, ink);
      }
      // Toto local transform: feet -> squash -> rotate about pivot (bob added after the legs).
      applyLocal(ctx, v, K, ox, oy, x, y, false);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // ---- legs (behind the body) ----
      const rp = v.runPhase;
      const t = v.time;
      const fallT = clampN((v.vy + 300) / 900, 0, 1);
      for (let i = 0; i < 4; i++) {
        const hx = LEG_HX[i];
        const hy = LEG_HY[i] + bob;
        const front = LEG_FRONT[i];
        let fx = hx;
        let fy = -7;
        switch (pose) {
          case 'run': {
            const s = Math.sin(rp + LEG_OFF[i]);
            const c = Math.cos(rp + LEG_OFF[i]);
            fx = hx + s * 6.5;
            fy = -7 - (c > 0 ? c * 7 : 0);
            break;
          }
          case 'air':
            if (front) {
              fx = hx + 7 - fallT * 3;
              fy = hy + 10 + fallT * 3;
            } else {
              fx = hx - 8 + fallT * 4;
              fy = hy + 9 + fallT * 3;
            }
            break;
          case 'slamHang':
          case 'slam': {
            const tr = Math.sin(t * 40 + i) * 0.8;
            fx = hx + (front ? 12 : -12);
            fy = hy + 3 + tr;
            break;
          }
          case 'tumble':
            fx = hx + Math.sin(t * 22 + LEG_OFF[i] + i) * 8;
            fy = hy + 8 + Math.cos(t * 22 + i) * 4;
            break;
          case 'sit':
          case 'sink':
            if (front) {
              fx = hx + 12;
              fy = -7 + (LEG_FAR[i] ? -1.5 : 0);
            } else {
              fx = hx + 13;
              fy = -6.5;
            }
            break;
          default:
            fx = hx;
            fy = -7;
            break;
        }
        if (i === 2) {
          // first near leg: draw far ear + tail before the near legs
          ear(ctx, 5, -57 + bob, -0.5 + clampN(v.vy * TOTO_ART.earK, -TOTO_ART.earMax, TOTO_ART.earMax) * (Math.PI / 180) + Math.sin(rp * 2) * 0.06, ink, true);
          const wag = Math.sin(t * (expr === 'joy' || expr === 'star' ? 18 : 9)) * 0.35;
          ctx.save();
          ctx.translate(BODY_CX - BODY_RX + 2, -36 + bob);
          ctx.rotate(-0.5 + wag);
          ctx.beginPath();
          oval(ctx, -5, 0, 6.5, 3.4, 0);
          ctx.fillStyle = PAL.totoBody;
          ctx.fill();
          ctx.strokeStyle = ink;
          ctx.lineWidth = 2.4;
          ctx.stroke();
          ctx.beginPath();
          oval(ctx, -11, 0, 2.6, 2.2, 0);
          ctx.fillStyle = TOTO_DARK;
          ctx.fill();
          ctx.restore();
        }
        leg(ctx, hx, hy, fx, fy, LEG_FAR[i] ? PAL.totoUnder : PAL.totoBody, ink, !LEG_FAR[i]);
      }

      if (bob !== 0) ctx.translate(0, bob);

      // ---- silhouette: rim light, outline, fill ----
      const puff = v.cheekPuff;
      const snoutScale = 1 + puff * 0.1;
      silhouette(ctx, snoutScale);
      const baseA = ctx.globalAlpha;
      if (v.night > 0.01) {
        ctx.globalAlpha = baseA * v.night;
        ctx.strokeStyle = RIM;
        ctx.lineWidth = 6 + 4;
        ctx.stroke();
        ctx.globalAlpha = baseA;
      }
      ctx.strokeStyle = ink;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.fillStyle = PAL.totoBody;
      ctx.fill();

      // belly + soft underside (clipped to the body)
      ctx.save();
      ctx.beginPath();
      oval(ctx, BODY_CX, BODY_CY, BODY_RX, BODY_RY, 0);
      ctx.clip();
      ctx.fillStyle = PAL.totoBelly;
      ctx.beginPath();
      oval(ctx, BODY_CX + 6, BODY_CY + 15, 25, 12, -0.05);
      ctx.fill();
      undersidePath(ctx, BODY_CX, BODY_CY, BODY_RX, BODY_RY, 0.72, 0);
      ctx.globalAlpha *= 0.55;
      ctx.fillStyle = PAL.totoUnder;
      ctx.fill();
      ctx.restore();
      // underside of the head/snout
      undersidePath(ctx, SNOUT_CX, SNOUT_CY, SNOUT_RX * snoutScale, SNOUT_RY * snoutScale, 0.45, 0);
      ctx.save();
      ctx.globalAlpha *= 0.35;
      ctx.fillStyle = PAL.totoUnder;
      ctx.fill();
      ctx.restore();
      // glossy highlights
      ctx.save();
      ctx.globalAlpha *= 0.45;
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      oval(ctx, 6, -55, 7.5, 3.2, -0.35);
      oval(ctx, -22, -45, 9, 3.4, -0.3);
      oval(ctx, 28, -41.5, 4.5, 2, -0.2);
      ctx.fill();
      ctx.restore();

      if (v.shield) drawMudCoat(ctx, v, ink);

      // snout crease + nostrils
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(SNOUT_CX, SNOUT_CY, SNOUT_RX * snoutScale, SNOUT_RY * snoutScale, 0, Math.PI * 0.62, Math.PI * 1.32);
      ctx.stroke();
      ctx.fillStyle = TOTO_DARK;
      ctx.beginPath();
      oval(ctx, 37.5, -40, 1.7, 2.6, 0.5);
      oval(ctx, 43, -38, 1.5, 2.3, 0.7);
      ctx.fill();

      drawMouth(ctx, v, ink);

      // cheek blush (+ puff bulge)
      if (puff > 0.02) {
        ctx.beginPath();
        dot(ctx, 21, -31, 6 + puff * 5.5);
        ctx.fillStyle = PAL.totoBody;
        ctx.fill();
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(21, -31, 6 + puff * 5.5, Math.PI * 0.35, Math.PI * 1.05);
        ctx.stroke();
      }
      ctx.fillStyle = PAL.totoCheek;
      ctx.globalAlpha = baseA * 0.85;
      ctx.beginPath();
      oval(ctx, 22, -31, 5.6 + puff * 3, 3.4 + puff * 2, 0);
      ctx.fill();
      ctx.globalAlpha = baseA;

      drawEye(ctx, v, ink, blinking);

      // near ear (in front of the head)
      const earTilt = clampN(v.vy * TOTO_ART.earK, -TOTO_ART.earMax, TOTO_ART.earMax) * (Math.PI / 180);
      const earJig = pose === 'run' ? Math.sin(rp * 2 + 0.6) * 0.08 : 0;
      ear(ctx, 12, -59, -0.2 + earTilt + earJig, ink, false);

      drawBandana(ctx, ink);

      // ---- extras ----
      if (v.sweatT > 0 || expr === 'sweat') drawSweat(ctx, v, ink);
      if (expr === 'dizzy' || pose === 'sit' || pose === 'tumble') drawStars(ctx, v, ink);
      if (expr === 'sleep') drawZzz(ctx, v, ink);
      if (pose === 'slam') {
        // speed streaks trailing above the dive
        ctx.strokeStyle = WHITE;
        ctx.lineCap = 'round';
        for (let i = 0; i < 4; i++) {
          const sx = -24 + i * 15;
          const len = 26 + ((i * 7 + Math.floor(t * 30)) % 4) * 6;
          ctx.globalAlpha = 0.65;
          ctx.lineWidth = 3 - (i & 1);
          ctx.beginPath();
          ctx.moveTo(sx, -66 - (i & 1) * 6);
          ctx.lineTo(sx, -66 - len);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    },
  };
  return rig;
}
