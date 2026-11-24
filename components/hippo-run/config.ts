/**
 * Every tunable from docs/GAME_DESIGN.md, as typed exported consts.
 *
 * Ownership: GAMEPLAY engineer during the parallel phase (ADDITIVE changes only; other
 * engineers request new keys in their report instead of editing). Values are the spec's
 * starting values; objects are plain (mutable at runtime) so numbers can be tuned live
 * from devtools while the game runs.
 *
 * Section numbers (§) refer to the spec.
 */
import type { DeathCause, EntityKind, TemplateId } from './types';

/* ================================================================== */
/* §2 Coordinate space and scaling                                     */
/* ================================================================== */

/** Logical view height (u). */
export const VIEW_H = 540;
/** Ground line y (u). y grows downward. */
export const GROUND_Y = 430;
/** World units per metre. */
export const U_PER_M = 50;

export const VIEW = {
  /** Minimum logical width (u) — guarantees look-ahead. */
  minW: 760,
  /** Maximum logical width before rescaling. */
  maxW: 1300,
  /** Minimum logical height when width-limited; below it pillarbox. */
  minHPillar: 480,
  /** Portrait: extra height split 60% sky above / 40% soil below. */
  offsetYFactor: 0.6,
  heroXMin: 167,
  heroXFrac: 0.22,
  /** Backing-store DPR cap. */
  dprMax: 2,
  /** Adaptive quality DPR. */
  dprLow: 1.5,
  /** Pillarbox / page background. */
  pillarColor: '#0B0B1E',
};

/* ================================================================== */
/* §3 Controls                                                         */
/* ================================================================== */

/** If true: left 40% of the screen = SLAM only, right 60% = jump only. Ship false. */
export const TWO_ZONE_TOUCH = false;
export const TWO_ZONE_SPLIT = 0.4;

/* ================================================================== */
/* §4 Physics (fixed step)                                             */
/* ================================================================== */

/** Fixed sim step (s). */
export const DT = 1 / 120;
/** Frame dt clamp (s). */
export const MAX_FRAME_DT = 0.1;
/** Max sim steps per rendered frame. */
export const MAX_STEPS_PER_FRAME = 6;

export const PHYS = {
  gravityUp: 2600,
  gravityDown: 3500,
  terminalVy: 1500,
  jumpVy: -900,
  /** Release cut: vy = max(vy, this). -420 gives a ~83 u tap hop (suite band 60-90 u). */
  jumpCutVy: -420,
  /**
   * Minimum rise time before a release may cut the jump (s). A tap delivered as press+release in
   * the same step still gives the spec's ~74 u "tap" hop (spec: tap ~60 ms). Gameplay may tune.
   */
  jumpMinHold: 0.06,
  coyote: 0.09,
  jumpBuffer: 0.13,
  /** Smart buffer: press while falling with predicted time-to-ground <= this -> buffered jump. */
  smartBuffer: 0.11,
  /** Press ignored this long after takeoff/bounce (protects a nervous second tap). */
  slamLockout: 0.18,
  /** ...and this long after a BOING launch (kills the slam -> boing mash loop). */
  slamLockoutAfterBoing: 0.35,
  slamHang: 0.05,
  slamVy: 1500,
  boingVy: -1120,
  /** Boing accepted within this long after a slam hits the ground. */
  boingWindow: 0.12,
  drumVy: -900,
  boomVy: -1100,
  mudRescueVy: -900,
  /** Mud Coat geyser out of a pit. */
  shieldGeyserVy: -1100,
  /** Landing rule: feet were at/above targetTop + this on the previous step. */
  landTolerance: 14,
  /** Landing rule: target x-range widened this much each side. */
  landWiden: 10,
};

export const HERO = {
  spriteW: 76,
  spriteH: 60,
  hurtW: 48,
  hurtH: 42,
  /** Hurtbox bottom sits this far above the feet. */
  hurtBottom: 4,
  /** Pickup box = hurtbox expanded by this on every side. */
  pickupPad: 18,
};

export const HITBOX = {
  /** Hazard hitbox = drawn shape inset by this fraction of width (total, split both sides). */
  insetWFrac: 0.15,
  /** ... and this many u off the top. */
  insetTop: 8,
  /** Thorn bush only: wider tap window (hitbox ~30.8 x 22 u). Use geom insetWFracFor/insetTopFor. */
  bushInsetWFrac: 0.3,
  bushInsetTop: 12,
};

/** v(t) = start + gain * (1 - exp(-t / tau)). */
export const SPEED = {
  start: 340,
  gain: 280,
  tau: 75,
  max: 620,
};

/* ================================================================== */
/* §5 Objects                                                          */
/* ================================================================== */

export const OUTLINE = {
  color: '#1B1B3A',
  width: 3,
};

export const DRUM = {
  w: 84,
  h: 40,
  /** Kite drum top above ground (u). */
  kiteTop: 170,
  /** Skin dent/wobble damped sine duration (s). */
  wobbleDur: 0.3,
  wobbleHz: 14,
  /** Dent depth at hit (u). */
  dentDepth: 8,
};

export const BUSH = { w: 44, h: 34, thorns: 7 };
export const MOUND = { w: 44, h: 84 };

export const HORNBILL = {
  w: 50,
  h: 30,
  /** Body (bottom..top) altitude band above ground (u): bottom >= 78, top <= 108. */
  minAlt: 78,
  maxAlt: 108,
  /** World-relative speed (u/s), leftwards. */
  speed: 80,
  bobAmp: 6,
  bobHz: 1.4,
};

export const LOG = {
  d: 46,
  /** World-relative speed (u/s), leftwards. */
  speed: 140,
  /** Edge warning lead (s) before entering the screen. */
  warnLead: 0.6,
};

export const PIT = {
  /** Width = v * U(minS, maxS). */
  minWidthS: 0.26,
  maxWidthS: 0.4,
  /** Grounded test uses [x + lipInset, x + w - lipInset]. */
  lipInset: 6,
  /** Mud surface below ground (u). */
  mudDepth: 26,
  /** Far-lip ledge forgiveness: feet <= this far below ground snap up. */
  ledgeSnap: 16,
  /** Fence post look. */
  postW: 6,
  postH: 30,
};

export const MELON = {
  w: 40,
  h: 34,
  /** Slam shockwave reach that bursts melons (u). */
  shockRadius: 120,
  burstMangoes: 5,
};

export const MANGO = {
  size: 18,
  bobAmp: 3,
  bobHz: 1.2,
};

export const GOLDEN = {
  size: 26,
  /** Placed this high above ground (centre, u). */
  minAlt: 230,
  maxAlt: 260,
  /** About one per this many seconds. */
  period: 20,
};

export const PICKUP = {
  /** Soap bubble diameter (u). */
  size: 40,
  /**
   * Bubble centre altitude above ground (u). Bottom (incl. 4 u bob) >= 68 u, above the standing
   * pickup-box top (64 u), so a bubble needs a hop: a tap hop (apex >= 74 u) collects it.
   */
  alt: 92,
};

export const BEST_FLAG = {
  poleH: 120,
  pennantW: 54,
  pennantH: 32,
};

/** Hazard kinds that can end a run (side contact). */
export const LETHAL_KINDS: ReadonlyArray<EntityKind> = ['bush', 'mound', 'hornbill', 'log'];

/** Distance (m) at which each hazard type unlocks. */
export const UNLOCK_M: { [K in DeathCause]: number } = {
  bush: 0,
  mound: 120,
  hornbill: 200,
  pit: 260,
  log: 380,
};

/* ================================================================== */
/* §6 Core systems                                                     */
/* ================================================================== */

export const SCORE = {
  perMetre: 1,
  drumPerChain: 20,
  drumMax: 200,
  hornbill: 100,
  log: 75,
  melonRun: 20,
  melonSlam: 60,
  mango: 10,
  golden: 100,
  nearMiss: 25,
  boing: 30,
  /** Chain bank = min(bankMax, bankPerChainSq * chain^2) when chain >= bankMinChain. */
  bankPerChainSq: 10,
  bankMax: 2000,
  bankMinChain: 2,
  multMax: 5,
  /** TOTOTO TIME: everything x2 and each smashed hazard +50. */
  feverMult: 2,
  feverSmash: 50,
  bestFlag: 250,
};

export const GROOVE = {
  max: 100,
  /**
   * Tuned with drum (plan G3): mango 0.4 + drum 5 put a bot that jumps onto every ground drum at a
   * median first fever of ~43 s (1.3 fevers/min) and plain autopilot at ~113 s (16 seeds x 120 s).
   */
  mango: 0.4,
  drum: 5,
  boom: 10,
  stomp: 8,
  nearMiss: 8,
  melon: 4,
  /** 0: boings score (SCORE.boing) but never feed the meter (no slam -> boing mash fever). */
  boing: 0,
  golden: 15,
  /** A lethal hazard (bush/mound/log/hornbill) passed unhit, or a pit cleared by landing beyond it. */
  hazardClear: 2,
  /** Decay per second while grounded or while airborne with no chain; frozen during TOTOTO TIME. */
  decayPerS: 1.5,
  /** HUD flashes above this. */
  flashAbove: 85,
};

export const FEVER = {
  duration: 6,
  /** Final warning window (Toto blinks, music filter closes). */
  warn: 1.5,
  /** On exit, hazards within this many u ahead poof away. */
  clearAhead: 500,
  exitInvuln: 1.0,
  /** Natural fills (addGroove) cannot start TOTOTO TIME before this run time (s). */
  notBefore: 15,
};

export const NEAR_MISS = {
  /** Track while hazard overlaps hero x-range extended by this (u). */
  xExtend: 14,
  /** Award when min clearance <= this (u). */
  clearance: 14,
  slowScale: 0.6,
  slowDur: 0.08,
  sweatDur: 0.6,
  flashDur: 0.1,
};

export const POWERUP = {
  /** Never within this many seconds (travel time) of a hazard. */
  hazardClearS: 0.8,
  /** First Mud Coat guaranteed in the first breather after this run time (s)... */
  shieldFirstAt: 12,
  /** ...which is forced after this many hazard chunks once due, or at this run time at the latest. */
  shieldFirstChunks: 3,
  shieldFirstLateAt: 20,
  /** Afterwards about one per this many s while none is held. */
  shieldEvery: 60,
  shieldInvuln: 1.0,
  magnetDur: 8,
  magnetRadius: 220,
  magnetAccel: 2400,
  magnetEvery: 45,
  magnetNotBefore: 40,
  /** Feature flag (first cut, §16). */
  magnetEnabled: true,
};

export const DEATH = {
  /** Slow-mo after the death hit-stop. */
  slowDur: 0.5,
  slowScale: 0.25,
  /** Summary card appears this long (real s) after the hit. */
  cardAt: 0.65,
  /** Input accepted this long (real s) after the card appears. */
  inputLockout: 0.35,
  /** Music low-pass target (Hz). */
  musicFilterHz: 300,
};

/** Death captions by cause (pick one at random with the cosmetic RNG). */
export const DEATH_CAPTIONS: { [K in DeathCause]: ReadonlyArray<string> } = {
  bush: ['Toto found the pointy bit.', 'Thorns: still pointy.', 'Toto hugged a bush. The bush hugged back.'],
  mound: ['The termites send their regards.', 'That mound was taller up close.', 'Termite tower: 1. Toto: 0.'],
  hornbill: ['The hornbill is not sorry.', 'Beaked. Thoroughly beaked.', 'Toto tried to befriend a hornbill.'],
  log: ['Timber: 1. Toto: 0.', 'Rolled over by a log. Rude.', 'Toto got logged out.'],
  pit: ['Toto decided this mud was a fine bed.', 'Nap time in the mud pit.', 'Sploosh. Toto lives here now.'],
};

/* ================================================================== */
/* §7 Difficulty and onboarding                                        */
/* ================================================================== */

export const DIFFICULTY = {
  /** restGap = lerp(restGapStart, restGapEnd, clamp(t / restGapRampT, 0, 1)) seconds (x v). */
  restGapStart: 0.95,
  restGapEnd: 0.5,
  restGapRampT: 120,
  restGapFloor: 0.5,
  /** One breather after this many hazard chunks (breatherEveryLate after breatherLateM). */
  breatherEvery: 4,
  breatherEveryLate: 5,
  breatherLateM: 500,
  breatherMinS: 2.2,
  breatherMaxS: 3.0,
};

/** Tier weights by distance (m), linear between keys. weights = [T1, T2, T3] in %. */
export const TIER_KEYS: ReadonlyArray<{ m: number; w: ReadonlyArray<number> }> = [
  { m: 0, w: [100, 0, 0] },
  { m: 120, w: [70, 30, 0] },
  { m: 500, w: [30, 50, 20] },
  { m: 1000, w: [10, 40, 50] },
  { m: 1600, w: [0, 30, 70] },
];

/** Template ids by tier (§8.3). Weight 1 each unless TEMPLATE_WEIGHT says otherwise. */
export const TEMPLATE_TIERS: {
  t1: ReadonlyArray<TemplateId>;
  t2: ReadonlyArray<TemplateId>;
  t3: ReadonlyArray<TemplateId>;
  breather: ReadonlyArray<TemplateId>;
} = {
  t1: ['bush', 'bush2', 'drumHello', 'drumPair', 'bushDrum', 'melonSlam'],
  t2: ['mound', 'moundBush', 'hornbillLow', 'hornbillStep', 'pit', 'pitDrum', 'drumLine3', 'log'],
  t3: ['bushHornbill', 'pitMound', 'logDrums', 'drumBridge'],
  breather: ['alleyDrums', 'alleyMelons', 'alleyKite', 'alleyPickup'],
};

/** Optional per-template weight overrides (default 1). */
export const TEMPLATE_WEIGHT: { [id: string]: number } = {};

/** Solo intro template for each hazard type's first appearance in a run. */
export const INTRO_TEMPLATE: { [K in DeathCause]: TemplateId } = {
  bush: 'bush',
  mound: 'mound',
  hornbill: 'hornbillLow',
  pit: 'pit',
  log: 'log',
};

export const OPENING = {
  /** First 5 s hazard-free; first thorn bush no earlier than this run time (s). */
  safeUntil: 5.0,
  /** Mango hop arc at this run time (s). */
  mangoArcAt: 1.2,
  /** One ground drum at this run time (s) with arcs onto and off it. */
  drumAt: 2.6,
};

export const TUTORIAL = {
  /**
   * Teaching freeze: if no jump has started by this long before contact (time to the bush hitbox)...
   * Eased in, the hero stops at ~0.24 s (~0.16 s after freezeMax): always inside the full-jump
   * clear window, and the first-run jump over this bush is never cut (assisted jump, game.ts).
   */
  freezeLead: 0.3,
  /** ...timeScale eases to this until ACTION (max freezeMax s)... */
  freezeScale: 0.02,
  freezeMax: 4,
  freezeEaseIn: 0.12,
  /** ...then eases back over this long. */
  freezeEaseOut: 0.3,
  slamPromptAt: 9,
  boingPromptAt: 14,
  /** First-run prompts stop after this run time (s). */
  promptsEnd: 45,
  /** Lesson slow-mo (SLAM / BOING prompts): timeScale while the lesson timer runs (real s). */
  lessonScale: 0.25,
  slamSlowMax: 1.0,
  boingSlowMax: 0.6,
  /**
   * First-run assisted jump: a ground jump pressed within this long (s) of touching the lesson bush
   * is never cut, so any tap clears it (sim state only; also in reduced motion, where there is no freeze).
   */
  assistS: 0.4,
  /** HOLD prompt over the first mound on runs 1..holdRuns; mound death caption on runs 1..holdCaptionRuns. */
  holdRuns: 3,
  holdCaptionRuns: 5,
};

/* ================================================================== */
/* §8 Procedural generation                                            */
/* ================================================================== */

export const GEN = {
  /** XOR for the cosmetic RNG stream seed. */
  cosmeticXor: 0x9e3779b9,
  /**
   * Content is generated up to hero.x + aheadU (fixed, NOT view-dependent, so the course is
   * identical on every screen size). 3000 >= cameraRight + 1.5 * viewW for viewW <= 1300.
   */
  aheadU: 3000,
  /** Recycle entities this far past the view's left edge (u). */
  recycleBehindU: 200,
  /** Exclude the last N template ids from selection. */
  avoidRepeat: 2,
  /** +/- jitter on optional items only. */
  jitter: 0.06,
  /** Optional golden mango flag probability per eligible template. */
  goldenChance: 0.3,
  /** Required-jump flat-ground gap (s x v) by tier 1/2/3. */
  reqGapS: [0.45, 0.35, 0.25] as ReadonlyArray<number>,
  pitMaxS: 0.4,
  pitFlatBeforeS: 0.5,
  pitClearAfterS: 0.25,
  hornbillJumpClearS: 0.6,
  /** Nothing lethal within +/- this of a drum-chain exit landing (u). */
  exitSafeU: 60,
  /** No hazard within this long after shield break, rescue, resume, fever exit. */
  safeAfterEventS: 1.0,
  /** Mango arcs: drop every arcStep s between arcFrom..arcTo of the flight. */
  arcStep: 0.08,
  arcFrom: 0.15,
  arcTo: 0.85,
  /** Foreground tufts skipped within this of any hazard (u). */
  tuftHazardClear: 60,
};

/* ================================================================== */
/* §9 Art direction                                                    */
/* ================================================================== */

export const PAL = {
  outline: '#1B1B3A',
  // Toto
  totoBody: '#A9A4F5',
  totoBelly: '#CFCBFF',
  totoCheek: '#FF9EC4',
  totoBandana: '#FF5A5F',
  totoEye: '#1B1B3A',
  totoTooth: '#FFFFFF',
  totoUnder: '#8A84E0',
  mudCoat: '#7A5236',
  mudCoatDark: '#5A3A24',
  // UI
  uiText: '#F8FAFC',
  uiAccent: '#818CF8',
  uiStroke: '#1B1B3A',
  /** #030712 at 72%. */
  panel: 'rgba(3,7,18,0.72)',
  grooveA: '#FF5A5F',
  grooveB: '#FFB627',
  bg: '#0B0B1E',
  // Drums
  drumShell: '#E8833A',
  drumShellDark: '#B9601F',
  drumLacing: '#7A3E1D',
  drumSkin: '#FFE8C2',
  kite: '#FF5A5F',
  kiteAlt: '#FFD166',
  kiteString: '#F8FAFC',
  // Hazards
  bush: '#2E5E4E',
  bushDark: '#1F4437',
  thorn: '#F25C54',
  mound: '#B5651D',
  moundDark: '#8C4A12',
  moundCrown: '#F97316',
  hornbill: '#2B2D42',
  hornbillBeak: '#FFD166',
  hornbillWing: '#3D405B',
  mud: '#5B3A8C',
  mudDark: '#3A2A3F',
  postA: '#F97316',
  postB: '#FFFFFF',
  log: '#8D5A3B',
  logRing: '#C08457',
  logBark: '#6B4128',
  // Friendly
  melonRind: '#3FA34D',
  melonStripe: '#2C7A3A',
  melonFlesh: '#FF6B6B',
  melonSeed: '#1B1B3A',
  mango: '#FFB627',
  mangoLeaf: '#5BD08A',
  golden: '#FFE45E',
  goldenGlow: '#FFF3A3',
  bubble: 'rgba(191,233,255,0.35)',
  bubbleRim: '#E0F4FF',
  flag: '#818CF8',
  flagPole: '#F8FAFC',
  // Night
  nightRim: '#C7D2FE',
  moon: '#FDF6E3',
  sun: '#FFE8A3',
  firefly: '#E8FF8A',
  star: '#F8FAFC',
};

/** Chain hues (step i uses CHAIN_HUES[i % 5]). */
export const CHAIN_HUES: ReadonlyArray<string> = ['#FF5A5F', '#FFB627', '#5BD08A', '#4FA8F6', '#B78CFF'];

/** Multiplier colours for bank text (index = multiplier 1..5). */
export const MULT_COLORS: ReadonlyArray<string> = ['#F8FAFC', '#F8FAFC', '#FFB627', '#5BD08A', '#4FA8F6', '#B78CFF'];

export interface DayPhaseDef {
  name: string;
  skyTop: string;
  skyBottom: string;
  mesa: string;
  hills: string;
  trees: string;
  groundTop: string;
  groundBody: string;
  /** Tint over gameplay ground ('' = none) and its alpha. */
  tint: string;
  tintAlpha: number;
  /** Night extras (rim light, stars, moon, fireflies). */
  night: boolean;
}

/** Each phase lasts PHASE_LEN_M; cross-fade over the last PHASE_FADE_M; loops after night. */
export const PHASE_LEN_M = 250;
export const PHASE_FADE_M = 50;

export const PHASES: ReadonlyArray<DayPhaseDef> = [
  {
    name: 'DAWN',
    skyTop: '#2B2D6E',
    skyBottom: '#FF9E7A',
    mesa: '#8A5A8C',
    hills: '#B5677A',
    trees: '#5A3A5E',
    groundTop: '#F2C57C',
    groundBody: '#C98F4E',
    tint: '',
    tintAlpha: 0,
    night: false,
  },
  {
    name: 'NOON',
    skyTop: '#4FA8F6',
    skyBottom: '#BFE9FF',
    mesa: '#C9B79A',
    hills: '#9CC27A',
    trees: '#5E8C4E',
    groundTop: '#F2C57C',
    groundBody: '#C98F4E',
    tint: '',
    tintAlpha: 0,
    night: false,
  },
  {
    name: 'DUSK',
    skyTop: '#3A1C71',
    skyBottom: '#FF7E5F',
    mesa: '#8E3B46',
    hills: '#A8483F',
    trees: '#4A2440',
    groundTop: '#E0A060',
    groundBody: '#A8683A',
    tint: '#FF7E5F',
    tintAlpha: 0.1,
    night: false,
  },
  {
    name: 'NIGHT',
    skyTop: '#0B0B1E',
    skyBottom: '#27306B',
    mesa: '#1E1B4B',
    hills: '#2A2558',
    trees: '#15133A',
    groundTop: '#8C79A8',
    groundBody: '#4A3A6B',
    tint: '',
    tintAlpha: 0,
    night: true,
  },
];

export const NIGHT = {
  rimWidth: 2,
  stars: 40,
  fireflies: 20,
};

/** Parallax scroll factors and background sampling. */
export const PARALLAX = {
  sky: 0,
  sunMoon: 0.02,
  mesas: 0.1,
  hills: 0.25,
  trees: 0.5,
  game: 1.0,
  tufts: 1.3,
  tuftAlpha: 0.6,
  /** Hills = sum of 3 sines sampled every this many u. */
  hillSampleU: 16,
  /** Sky gradient cache: quantise phase blend into this many steps. */
  skyQuant: 64,
  /** Decoration tile widths per layer (u in layer space). */
  tileMesa: 520,
  tileTree: 260,
  tileTuft: 90,
  tileRock: 180,
};

/** Toto drawing dimensions (u, around feet origin). */
export const TOTO_ART = {
  bodyW: 64,
  bodyH: 46,
  headW: 44,
  headH: 36,
  snoutW: 30,
  snoutH: 22,
  /** Ear angle = clamp(vy * earK, -earMax, earMax) degrees. */
  earK: 0.02,
  earMax: 25,
  pupilMax: 3,
  /** Bandana verlet ribbon points. */
  ribbonPoints: 6,
  ribbonSeg: 7,
  /** Blink every blinkMin..blinkMax s (cosmetic). */
  blinkMin: 2,
  blinkMax: 5,
  blinkDur: 0.12,
  /** Leg cycle: runPhase advances by distance * legK (radians per u). */
  legK: 0.075,
};

/** Glow sprite (pre-rendered radial, drawn with 'lighter'). */
export const GLOW = {
  spriteSize: 128,
};

/* ================================================================== */
/* §10 Juice                                                           */
/* ================================================================== */

export const JUICE = {
  /** Squash spring. */
  squashK: 380,
  squashDamp: 22,
  takeoffX: 0.82,
  takeoffY: 1.22,
  /** Landing: width 1 + min(landMax, vy / landDiv). */
  landMax: 0.4,
  landDiv: 2600,
  slamImpactX: 1.5,
  slamImpactY: 0.55,
  boingX: 0.72,
  boingY: 1.34,
  /** Fallback simple ease if the spring misbehaves (s). */
  squashEase: 0.12,
};

/** Hit-stop durations (real s). Capped at reducedMotionCap in reduced motion. */
export const HITSTOP = {
  slam: 0.06,
  boom: 0.05,
  stomp: 0.04,
  smash: 0.04,
  /** TOTOTO TIME entry beat. */
  fever: 0.18,
  shield: 0.08,
  death: 0.12,
  reducedMotionCap: 0.04,
};

/** Trauma shake: offset = maxOffset * trauma^2 (summed sines), decay per s. */
export const SHAKE = {
  maxOffset: 12,
  decay: 2.2,
  freqX: 37,
  freqY: 43,
  slam: 0.35,
  boom: 0.3,
  stomp: 0.2,
  shield: 0.5,
  death: 0.7,
  smash: 0.15,
  fever: 0.5,
};

export const FX = {
  /** Slam shockwave 0 -> radius in dur. */
  shockRadius: 120,
  shockDur: 0.22,
  shockParticles: 12,
  drumRingRadius: 70,
  drumRingDur: 0.3,
  /** Popup: scale 0 -> 1.2 -> 1 in scaleT, drift up drift u, life s. */
  popupScaleT: 0.15,
  popupDrift: 30,
  popupLife: 0.7,
  popupLifeBig: 1.1,
  mangoSparks: 4,
  /** Mango pitch streak window (s). */
  mangoStreakWindow: 0.4,
  /** Footstep dust every other footfall. */
  dustEvery: 2,
  confetti: 48,
  speedLines: 18,
  vignetteAlpha: 0.28,
  vignetteColor: '#FF7E3F',
};

/** navigator.vibrate durations (ms); off in reduced motion. */
export const HAPTIC = {
  slam: 12,
  death: 30,
};

/* ================================================================== */
/* §11 Audio                                                           */
/* ================================================================== */

export const AUDIO = {
  sfxBus: 0.7,
  musicBus: 0.32,
  compThresholdDb: -18,
  compRatio: 4,
  /** Mute ramp (s). */
  muteRamp: 0.05,
  noiseSeconds: 1,
  /** Look-ahead scheduler. */
  tickMs: 25,
  lookAhead: 0.12,
  stepsPerBar: 16,
  /** Tempo = bpmBase + bpmRange * (v - 340) / 280, changed at bar lines only. */
  bpmBase: 112,
  bpmRange: 16,
  titleBpm: 96,
  /** Layers. */
  l2After: 15,
  l3After: 60,
  l3MinChain: 2,
  l3RestChance: 0.3,
  /** Music filter (Hz). */
  filterOpen: 18000,
  filterPlaying: 9000,
  filterFeverWarn: 1200,
  filterDeath: 300,
  filterPaused: 600,
  /** Title music level multiplier. */
  titleLevel: 0.6,
  gameOverLevel: 0.5,
};

/** Note ladder root A2 (Hz); A minor pentatonic semitone steps; octave up every 5; 3 octaves cap. */
export const NOTE_ROOT_HZ = 110;
export const PENTA: ReadonlyArray<number> = [0, 3, 5, 7, 10];
export const LADDER_OCTAVES = 3;
/** Chords Am–C–Dm–Em: root semitone (from A2) and fifth, one bar each. */
export const CHORD_ROOTS: ReadonlyArray<number> = [0, 3, 5, 7];
export const CHORD_FIFTHS: ReadonlyArray<number> = [7, 10, 12, 14];
/** Chord tones (semitones from A, inside the pentatonic) for marimba snapping on steps 0/8. */
export const CHORD_TONES: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 3, 7],
  [3, 7, 10],
  [5, 12, 15],
  [7, 10, 14],
];

export const SFX_NOTES = {
  golden: [659.25, 880, 1318.51] as ReadonlyArray<number>,
  goldenStep: 0.07,
  bestFlag: [440, 523.25, 659.25, 880, 1046.5] as ReadonlyArray<number>,
  death: [392, 370, 349, 330] as ReadonlyArray<number>,
  /** Mango: A5 pentatonic base. */
  mangoBase: 880,
};

/** Per-sfx gains (before sfxBus). */
export const SFX_GAIN = {
  footstep: 0.06,
  jump: 0.18,
  slamStart: 0.2,
  slamImpact: 0.5,
  boing: 0.25,
  drum: 0.4,
  mango: 0.12,
  golden: 0.2,
  melon: 0.3,
  stomp: 0.3,
  nearMiss: 0.18,
  chainBank: 0.25,
  shield: 0.25,
  logWarn: 0.15,
  fever: 0.25,
  bestFlag: 0.22,
  death: 0.25,
  land: 0.2,
  click: 0.1,
  countdown: 0.2,
};

/* ================================================================== */
/* §12 UI                                                              */
/* ================================================================== */

export const FONT_STACK = 'ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif';

export const UI = {
  /** Light fill over a dark stroke of this width (u). */
  strokeW: 4,
  /** Minimum button hit area (CSS px). */
  buttonMinCss: 48,
  grooveMaxW: 280,
  grooveFrac: 0.4,
  grooveH: 16,
  /** Pause 3-2-1, each step (real s). */
  countdownStep: 0.4,
  countdownFrom: 3,
  /** Summary score count-up (s). */
  countUp: 0.8,
  bannerDur: 2.2,
  toastDur: 1.6,
  portraitHintDur: 3,
  /** HUD margin from the safe-area edge (u). */
  margin: 16,
  /** Next build: keep this CSS-px box clear at top-left on title/paused/gameover (DOM back link). */
  domLinkClearW: 170,
  domLinkClearH: 44,
};

export const UI_TEXT = {
  logo: 'HIPPO TOTOTO',
  subtitle: 'Stomp the Beat',
  howTo1: 'TAP: jump · HOLD: higher',
  howTo2: 'TAP in the air: SLAM · SLAM, then TAP: BOING',
  start: 'Tap or press Space',
  paused: 'PAUSED',
  retry: 'Tap / Space to retry',
  newBest: 'NEW BEST!',
  portraitHint: 'Rotate for a wider view',
  tutTap: 'TAP',
  tutSpace: 'SPACE',
  tutSlam: 'TAP AGAIN NOW = SLAM',
  tutSlamKey: 'SPACE AGAIN NOW = SLAM',
  tutBoing: 'TAP NOW = BOING!',
  tutBoingKey: 'SPACE NOW = BOING!',
  tutHold: 'HOLD = HIGHER',
  tutHoldKey: 'HOLD SPACE = HIGHER',
  tutDrum: 'JUMP ON THE DRUM',
  /** Game-over caption after a mound death on the first runs. */
  holdCaption: 'Hold longer to jump higher.',
  fever: 'TOTOTO TIME!',
  close: 'CLOSE!',
  record: '+NEW RECORD',
  copied: 'Copied!',
  copyFail: 'Copy failed',
};

/* ================================================================== */
/* §13 Meta                                                            */
/* ================================================================== */

export const STORAGE_KEY = 'hippotototo.v1';

export const MEDALS = {
  bronze: 1500,
  silver: 5000,
  gold: 12000,
};

export interface GoalDef {
  id: 'chain3' | 'noon' | 'boom' | 'stomp' | 'fever' | 'chain6' | 'dusk' | 'night';
  label: string;
}

/** Fixed ordered list; save.goalIndex points at the current one (8 = all done). */
export const GOALS: ReadonlyArray<GoalDef> = [
  { id: 'chain3', label: 'Chain 3 drums' },
  { id: 'noon', label: 'Reach noon' },
  { id: 'boom', label: 'BOOM-bounce a drum' },
  { id: 'stomp', label: 'Stomp a hornbill' },
  { id: 'fever', label: 'Trigger TOTOTO TIME' },
  { id: 'chain6', label: 'Chain 6' },
  { id: 'dusk', label: 'Reach dusk' },
  { id: 'night', label: 'Reach night' },
];

/* ================================================================== */
/* §14 Technical                                                       */
/* ================================================================== */

export const POOLS = {
  entities: 96,
  mangoes: 160,
  particles: 256,
  popups: 16,
  rings: 24,
  inputEvents: 32,
};

export const PERF = {
  /** If the 2 s average frame time exceeds this (ms), drop DPR to 1.5 and halve particles (once). */
  slowFrameMs: 20,
  windowS: 2,
};

export const TITLE = {
  /** Parallax drift speed on the title (u/s). */
  driftSpeed: 60,
  /** Toto idle bounce on the title drum. */
  bounceVy: -620,
};

export const AUTOPILOT = {
  /** Jump (full hold) when time to the hazard's leading edge <= this (s). */
  leadS: 0.3,
  /** Pits: jump at the lip minus this (u). */
  pitLipU: 12,
  /** Tap-hop for a power-up bubble whose centre is this many s (x speed) ahead (+/- 0.02 s). */
  bubbleLeadS: 0.2,
};

/** Sentinel for Entity.hitT / HeroState.postSlamT "never". */
export const NEVER = 99;
