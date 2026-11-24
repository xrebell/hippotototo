/**
 * Hippo Tototo: Stomp the Beat — shared types (the contract between modules).
 *
 * Ownership: GAMEPLAY engineer during the parallel phase. ADDITIVE changes only
 * (new fields / new union members). Never rename or remove a field others read.
 *
 * Conventions (see CONTRACTS.md for the long version):
 *  - "u" = world units. 1 m = 50 u. y grows DOWNWARD. GROUND_Y = 430.
 *  - World x grows to the right and is 0 at the hero's start position each run,
 *    so distance in metres = hero.x / 50.
 *  - Screen (logical) x = worldX - cam.x. Logical y of a world point = worldY + view.offsetY.
 *  - "sim s" = simulated seconds (scaled by timeScale, frozen in hit-stop).
 *    "real s" = wall-clock seconds (frame dt, clamped to 0.1).
 *  - Every field doc says WHO writes it:  [G]=gameplay (game/hero/world),
 *    [A]=art (fx.ts only; render.ts never writes), [AU]=audio, [S]=shell
 *    (game.ts loop/resize code, also gameplay-owned). Render and UI are READ-ONLY.
 */

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */

/** Deep read-only view used by render, ui and audio.update. GameState is assignable to it. */
export type DeepReadonly<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Axis-aligned box, left/top origin, world u (or logical u for UI). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ------------------------------------------------------------------ */
/* String-literal unions                                               */
/* ------------------------------------------------------------------ */

/** Top-level state machine. title -> playing -> (paused <-> playing) -> dying -> gameover -> playing */
export type GameMode = 'title' | 'playing' | 'paused' | 'dying' | 'gameover';

export type EntityKind =
  | 'drum'
  | 'kiteDrum'
  | 'bush'
  | 'mound'
  | 'hornbill'
  | 'pit'
  | 'log'
  | 'melon'
  | 'mango'
  | 'goldenMango'
  | 'pickupShield'
  | 'pickupMagnet'
  | 'bestFlag';

/** Per-entity sticky visual/logic flag. Meaning per kind:
 *  - 'none'    default
 *  - 'split'   melon: run through (drawn as two halves, no longer interactive)
 *  - 'burst'   melon: slam-smashed (render may skip drawing; fx did the burst)
 *  - 'rescued' pit: SPLORCH rescue already used (once per pit)
 *  - 'passed'  bestFlag: hero passed it (pennant waves / celebrates)
 *  - 'popped'  pickup bubble: collected (render may draw a pop for a few frames via stateT)
 *  - 'smashed' hazard: destroyed by fever / shield / stomp; kept alive briefly for a poof (stateT)
 *  - 'stomped' hornbill/log: stomped from above; falls/rolls away (stateT), harmless
 */
export type EntityFlag = 'none' | 'split' | 'burst' | 'rescued' | 'passed' | 'popped' | 'smashed' | 'stomped';

/** Lethal causes. 'pit' = sank in mud. */
export type DeathCause = 'bush' | 'mound' | 'hornbill' | 'log' | 'pit';

/** Hero logic state (gameplay internal but readable). */
export type HeroAction =
  | 'idle' // title screen
  | 'run' // grounded
  | 'air' // jump / fall / bounce flight (not slamming)
  | 'slamHang' // 0.05 s hang before the dive
  | 'slam' // diving at +1500
  | 'dead'; // run over (tumble/sit/sink is in pose)

/** What render draws. Written by gameplay every sim step. */
export type HeroPose =
  | 'idle' // title: standing / bouncing on the title drum
  | 'run' // legs cycle with runPhase
  | 'air' // legs tucked, body tilt from vy
  | 'slamHang' // belly-down, cheeks puffed
  | 'slam' // belly-down dive (rot ~ 0.2 rad), speed streaks
  | 'tumble' // death: spinning (rot) during slow-mo
  | 'sit' // death: sitting dizzy, stars orbit (deathT)
  | 'sink'; // pit death: half-sunk in mud, napping

/** Face. Written by gameplay; render adds blinks itself (cosmetic). */
export type HeroExpr =
  | 'serious' // run (serious brow)
  | 'o' // jump (mouth "o")
  | 'squint' // slam (eyes "> <", puffed cheeks)
  | 'joy' // boing / bounce (open-mouth joy)
  | 'sweat' // near miss (sweat drop)
  | 'star' // TOTOTO TIME (star eyes)
  | 'dizzy' // dead (spiral eyes)
  | 'sleep'; // sunk in pit (closed eyes, Zzz)

export type Medal = 'none' | 'bronze' | 'silver' | 'gold';

export type TutorialPrompt = 'none' | 'tap' | 'slam' | 'boing';

export type PauseReason = 'none' | 'user' | 'blur' | 'hidden' | 'resize';

export type InputDevice = 'keyboard' | 'mouse' | 'touch' | 'synthetic';

/** Canvas button ids. One id may appear in several screens (e.g. 'sound' in HUD + pause + title). */
export type ButtonId = 'pause' | 'sound' | 'motion' | 'resume' | 'restart' | 'copy';

/** Raw semantic input events produced by input.ts. */
export type InputKind =
  | 'actionDown' // Space/ArrowUp/W keydown (no repeat), or pointerdown NOT on a button
  | 'actionUp' // emitted when the LAST held action key/pointer is released
  | 'slam' // ArrowDown / S keydown (explicit slam; ignored on ground)
  | 'pause' // P / Esc
  | 'mute' // M
  | 'restart' // R
  | 'confirm' // Enter (start from title, retry from summary)
  | 'button'; // pointerdown on a canvas button (see InputEvent.button)

export type TemplateId =
  // opening / scripted
  | 'opening'
  | 'tutorial'
  // tier 1
  | 'bush'
  | 'bush2'
  | 'drumHello'
  | 'drumPair'
  | 'bushDrum'
  | 'melonSlam'
  // tier 2
  | 'mound'
  | 'moundBush'
  | 'hornbillLow'
  | 'hornbillStep'
  | 'pit'
  | 'pitDrum'
  | 'drumLine3'
  | 'log'
  // tier 3
  | 'bushHornbill'
  | 'pitMound'
  | 'logDrums'
  | 'drumBridge'
  // breathers
  | 'alleyDrums'
  | 'alleyMelons'
  | 'alleyKite'
  | 'alleyPickup';

/** Particle families (fx.ts decides look: colour, gravity, drag, life). */
export type ParticleKind =
  | 'dust' // footsteps, landings (ground colour)
  | 'pebble' // slam impact debris
  | 'feather' // hornbill stomp (navy + yellow), slow tumbling fall
  | 'chip' // log stomp wood chips
  | 'seed' // melon seeds (dark)
  | 'juice' // melon juice (pink-red drops)
  | 'mud' // shield break, pit splorch, geyser (violet/brown)
  | 'confetti' // best flag, new record (chain hues)
  | 'spark' // mango pickup (4 sparks), golden (more)
  | 'poof' // smoke puff: fever exit hazard removal, fever smash
  | 'note' // little music-note glyph rising from drums (hue)
  | 'star'; // small star twinkles (fever, boing apex)

/** Ring/shockwave families. */
export type RingKind =
  | 'drum' // drum hit ring in chain hue, ~0.3 s
  | 'shock' // slam shockwave 0 -> 120 u in 0.22 s (ground level)
  | 'boing' // vertical-ish springy ring at take-off
  | 'pickup'; // bubble pop / golden collect

export type PopupSize = 'sm' | 'md' | 'lg';

/** Every sound effect. `param` meaning per id is documented in SFX_PARAM_DOC (CONTRACTS.md too). */
export type SfxId =
  | 'footstep' // param: current speed u/s (pitch x1..1.5 over 340..620)
  | 'jump' // -
  | 'slamStart' // -
  | 'slamImpact' // - (ground slam)
  | 'boing' // -
  | 'drum' // param: chain value AFTER this bounce (1 = first ladder note A2)
  | 'drumBoom' // param: chain value AFTER this bounce (BOOM: +sub-octave)
  | 'stomp' // param: chain value AFTER this stomp
  | 'mango' // param: quick-pickup streak index (0 = first; +1 per pickup within 0.4 s)
  | 'golden' // -
  | 'melon' // -
  | 'nearMiss' // -
  | 'chainBank' // param: banked chain length (volume scales with it)
  | 'shieldGet' // -
  | 'shieldBreak' // -
  | 'magnetGet' // -
  | 'logWarn' // - (0.6 s rumble)
  | 'feverStart' // -
  | 'feverEnd' // -
  | 'bestFlag' // - (5-note fanfare)
  | 'death' // - ("wah-wah")
  | 'splorch' // - (mud rescue bounce)
  | 'smash' // - (fever smash of a hazard)
  | 'land' // param: impact vy u/s (soft thud, volume scales)
  | 'click' // - (UI)
  | 'countdown' // param: 3, 2 or 1
  | 'go'; // - (countdown finished)

/* ------------------------------------------------------------------ */
/* View metrics                                                        */
/* ------------------------------------------------------------------ */

/**
 * [S] Written by game.ts on resize (computeView in state.ts). Everyone else reads.
 * Logical units == world units. Transform used for ALL drawing:
 *   ctx.setTransform(dpr*s, 0, 0, dpr*s, dpr*padX, 0)
 * so logical (lx, ly) maps to CSS px (padX + lx*s, ly*s).
 */
export interface ViewMetrics {
  /** CSS px size of the canvas box. */
  cssW: number;
  cssH: number;
  /** Device pixel ratio actually used for the backing store (<= 2, may drop to 1.5 adaptively). */
  dpr: number;
  /** CSS px per logical unit. */
  s: number;
  /** Logical size of the visible play view (viewW <= 1300, viewH >= 480). */
  viewW: number;
  viewH: number;
  /** Logical y added to every world y when drawing (portrait: >0 extra sky; short: <0 crops sky). */
  offsetY: number;
  /** CSS px of horizontal pillarbox on EACH side (0 unless pillarboxed). */
  padX: number;
  /** Hero screen x in logical units: max(167, 0.22 * viewW). */
  heroX: number;
  /** Safe-area insets converted to logical units (read from env(safe-area-inset-*) via probe). */
  safeL: number;
  safeR: number;
  safeT: number;
  safeB: number;
  /** cssH > cssW. */
  portrait: boolean;
  /** Bumped on every resize; render/ui caches compare against it. */
  version: number;
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

/**
 * One pooled record shape for BOTH pools (state.entities: 96, state.mangoes: 160).
 * [G] all fields written by world.ts (spawn/step/collide). Render/UI read.
 * Geometry: (x, y, w, h) is the DRAWN bounding box, left/top, world u.
 *   - Ground props/hazards: y + h === GROUND_Y.
 *   - kiteDrum: y = GROUND_Y - 170 (drum top); render draws the kite above it.
 *   - pit: x = near lip, w = width, y = GROUND_Y, h = mud depth (26). Mud surface at y + h.
 *   - hornbill: y oscillates (bob) around baseY; body 78–108 u above ground.
 *   - log: w = h = 46; rot = roll angle.
 *   - mango/golden/pickups: centre = (x + w/2, y + h/2).
 *   - bestFlag: x = pole x, y = pole top, h = pole height to ground.
 * Hitboxes are NOT stored: use geom.ts entityHitbox(e, out).
 */
export interface Entity {
  /** Slot in use. Inactive slots are ignored by everyone. */
  active: boolean;
  kind: EntityKind;
  /** Spawn serial, unique within a run (debug + once-per-entity bookkeeping). */
  serial: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** World-relative velocity u/s (hornbill -80, log -140; magnet-pulled mangoes both axes). */
  vx: number;
  vy: number;
  /** Rest top y for bobbing kinds (hornbill, mangoes, pickups). */
  baseY: number;
  /** Cosmetic phase in radians, random at spawn (bob/flap/sway offsets). */
  phase: number;
  /** Sim seconds since spawn. */
  age: number;
  /** Sim seconds since last bounce/stomp/contact on THIS entity (drum wobble/dent, 300 ms). 99 = never. */
  hitT: number;
  /** Chain hue index 0..4 of the last bounce ring (drum skin flash); -1 = none. */
  hue: number;
  /** Rotation radians (log roll; kite sway may be derived by render instead). */
  rot: number;
  /** Sticky state flag (see EntityFlag). */
  flag: EntityFlag;
  /** Sim seconds since `flag` last changed. */
  stateT: number;
  /** Lethal on contact (bush, mound, hornbill, log) unless stomped from above. */
  hazard: boolean;
  /** Can be landed on from above for a bounce (drum, kiteDrum, hornbill, log, melon-as-slam-target). */
  stompable: boolean;
  /** Generator: optional (high-score line) item; jitter applies. */
  optional: boolean;
  /** Log edge warning remaining (sim s); > 0 while the "!" bubble shows at the right screen edge. */
  warnT: number;
  /** Near-miss tracking: minimum clearance so far (u); 1e9 when not tracked yet. */
  nearMin: number;
  /** Near miss already resolved (awarded or disqualified) for this entity. */
  nearDone: boolean;
  /** Template that spawned this entity ('' if none). Debug overlay label. */
  template: TemplateId | '';
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

/** [G] hero.ts writes everything here. Render reads pose/expr/squash/rot/etc. */
export interface HeroState {
  /** World x of feet centre (u). Advances by speed * dt. */
  x: number;
  /** World y of feet (u). GROUND_Y when standing. */
  y: number;
  /** y at the previous sim step (render interpolates prevY -> y by alpha). */
  prevY: number;
  /** Vertical velocity u/s, + = down. */
  vy: number;
  /** Standing on ground (or bridged pit during fever) this step. */
  grounded: boolean;
  action: HeroAction;

  /* --- control timers (gameplay internal, exposed for debug) --- */
  /** Sim s since leaving the ground (coyote) — 0 while grounded. */
  coyoteT: number;
  /** Sim s since takeoff/bounce (slam lockout 0.12 s). */
  airT: number;
  /** Remaining buffered-jump validity (sim s), 0 = none. */
  bufferT: number;
  /** Slam already used this airtime. */
  slamUsed: boolean;
  /** Slam hang remaining (sim s). */
  hangT: number;
  /** A BOING press is queued for the next slam impact. */
  boingQueued: boolean;
  /** Sim s since a slam hit the GROUND (boing window 0.12 s); 99 = n/a. */
  postSlamT: number;
  /** ACTION currently held (copied from input each step; used for jump cut). */
  held: boolean;
  /** Sim s ACTION has been held since the current jump press (variable-height bookkeeping). */
  holdT: number;
  /** Pending jump-cut: release arrived before JUMP_MIN_HOLD elapsed; cut when holdT reaches it. */
  cutPending: boolean;
  /** Pit currently under the feet (index into state.entities) or -1. */
  pitIndex: number;

  /* --- visuals (written by gameplay, read by render) --- */
  pose: HeroPose;
  expr: HeroExpr;
  /** Sim s left before expr reverts to the default for the pose. */
  exprT: number;
  /** Squash/stretch scale (1 = rest), spring k=380 d=22, integrated on sim dt. */
  squashX: number;
  squashY: number;
  /** Spring velocities (internal). */
  squashVX: number;
  squashVY: number;
  /** Body rotation radians (slam dive tilt, death tumble). + = clockwise. */
  rot: number;
  /** Run-cycle phase radians, advanced by distance (legs + footsteps). */
  runPhase: number;
  /** World point the pupil looks toward (nearest hazard ahead); defaults to (x + 300, GROUND_Y - 30). */
  lookX: number;
  lookY: number;
  /** Near-miss white outline flash remaining (sim s). Render ignores in reduced motion. */
  flashT: number;
  /** Sweat drop remaining (sim s). */
  sweatT: number;
  /** Cheek puff 0..1 (slam hang). */
  cheekPuff: number;
  /** Bandana whip impulse 0..1 (slam start / boing); render's ribbon reads and decays visually. */
  whip: number;

  /* --- powers --- */
  /** Mud Coat held (absorbs one hit or one sink). */
  shield: boolean;
  /** Invulnerability remaining (sim s) after shield break / fever exit (blink or 50% alpha). */
  invulnT: number;
  /** Fruit Magnet remaining (sim s). */
  magnetT: number;

  /* --- death --- */
  /** Sim s since the fatal hit (drives tumble/sit/stars); 0 while alive. */
  deathT: number;
  /** Pit sink depth below ground (u) while sinking. */
  sinkDepth: number;
}

/* ------------------------------------------------------------------ */
/* Run, systems, UI-facing state                                       */
/* ------------------------------------------------------------------ */

/** [G] Per-run counters and scoring. Reset in place on every start/restart. */
export interface RunStats {
  /** Sim seconds since run start (drives speed curve, rest gaps, tutorial timings). */
  time: number;
  /** Metres travelled = hero.x / 50 (float). */
  distance: number;
  /** Current forward speed u/s = 340 + 280 * (1 - exp(-time / 75)). */
  speed: number;
  /** Total score (integer). */
  score: number;
  /** Current chain (bounces without touching ground; BOOM = +2). */
  chain: number;
  /** Best chain this run. */
  chainBest: number;
  /** min(5, 1 + floor(chain / 2)). */
  multiplier: number;
  /** Groove meter 0..100. */
  groove: number;
  mangoes: number;
  golden: number;
  stomps: number;
  booms: number;
  boings: number;
  drums: number;
  nearMisses: number;
  smashes: number;
  /** Quick mango pickup streak index (audio pitch); resets when > 0.4 s since last pickup. */
  mangoStreak: number;
  /** Sim s since last mango pickup. */
  mangoStreakT: number;
  /** Whole metres already converted into distance points. */
  metresScored: number;
  /** Best flag passed this run (celebration fired). */
  bestPassed: boolean;
  /** Bit mask of day phases entered this run (bit i = phase i). Soak test reads it. */
  phasesSeen: number;
  /** Goal (save.goalIndex at run start) completed this run. */
  goalDone: boolean;
}

/** [G] TOTOTO TIME. */
export interface FeverState {
  active: boolean;
  /** Remaining sim s (6 -> 0). Last 1.5 s = warning (Toto blinks, music filter closes). */
  t: number;
  /** Times triggered this run. */
  count: number;
}

/** [G] Day phase derived from distance every step. 0 dawn, 1 noon, 2 dusk, 3 night. */
export interface PhaseState {
  /** Current phase index 0..3. */
  index: number;
  /** Next phase index (index + 1) % 4. */
  next: number;
  /** Cross-fade 0..1 toward `next` (over the last 50 m of each 250 m). */
  blend: number;
  /** Completed full day cycles (dawn again after night). */
  loop: number;
}

/** [S]/[A] Camera. x/prevX by gameplay; shake fields by fx.ts ONLY. */
export interface CameraState {
  /** [G] World x of the view's left edge = hero.x - view.heroX. */
  x: number;
  /** [G] x at previous sim step (render lerps by alpha). */
  prevX: number;
  /** [A] Shake offset in logical u (fx.update writes; 0 in reduced motion). */
  shakeX: number;
  shakeY: number;
  /** [A] Trauma 0..1 (fx.shake adds; decays 2.2/s). */
  trauma: number;
}

/** [G] Tutorial (first-ever run only) + generic prompt anchor. */
export interface TutorialState {
  /** This run shows tutorial prompts (no save data / tutorialSeen false). */
  active: boolean;
  prompt: TutorialPrompt;
  /** World anchor of the prompt (u). UI converts to screen. */
  promptX: number;
  promptY: number;
  /** Real s since the current prompt appeared (fade/pulse). */
  promptT: number;
  /** Teaching freeze engaged (timeScale easing to 0.15). */
  freeze: boolean;
}

/** [G] Pause sub-state. */
export interface PauseState {
  /** 3-2-1 remaining real s (1.2 -> 0). 0 = not counting down. mode stays 'paused' until it ends. */
  countdown: number;
  reason: PauseReason;
}

/** [G] Phase/record banner ("NOON · 250 m"). UI slides it in/out. */
export interface BannerState {
  text: string;
  /** Real s since shown; banner hidden when t >= dur. */
  t: number;
  dur: number;
}

/** [G] Small toast ("Copied!", "Sound off"). */
export interface ToastState {
  text: string;
  t: number;
  dur: number;
}

/** [G] Filled once when entering 'gameover' (strings built then, never per frame). */
export interface SummaryState {
  score: number;
  /** Whole metres. */
  distance: number;
  chainBest: number;
  mangoes: number;
  stomps: number;
  /** Score beat the previous best. */
  newBest: boolean;
  /** Points above the previous best (newBest) — "New best by 312!". */
  bestBy: number;
  /** Metres short of best distance (not newBest) — "Only 86 m short of your best". 0 if n/a. */
  shortBy: number;
  medal: Medal;
  /** Death caption, chosen by cause at death. */
  caption: string;
  /** Next-goal line text (label of save.goalIndex AFTER this run). '' when all done. */
  goalText: string;
  /** A goal was completed this run (tick shown). */
  goalDone: boolean;
  /** Label of the goal completed this run ('' if none). */
  goalDoneText: string;
}

/** [AU] Music clock (audio.update writes; falls back to a performance.now clock when silent). */
export interface MusicState {
  bpm: number;
  /** 0..1 within the current beat (quarter note). */
  beatPhase: number;
  /** Beat counter since audio start. */
  beat: number;
}

/** Persisted save (localStorage "hippotototo.v1"). [G] writes via storage.ts. */
export interface SaveData {
  v: 1;
  best: number;
  /** Best distance in whole metres (best flag position). */
  bestDist: number;
  bestChain: number;
  runs: number;
  totalMangoes: number;
  muted: boolean;
  reducedMotion: boolean;
  tutorialSeen: boolean;
  /** Index into GOALS (0..8; 8 = all done). */
  goalIndex: number;
}

/** [S] Frame clock. */
export interface ClockState {
  /** Real s since createGame. */
  now: number;
  /** Real dt of this frame (clamped 0..0.1). */
  frameDt: number;
  /** Interpolation alpha 0..1 for render (accumulator / DT). */
  alpha: number;
  /** Smoothed frames per second. */
  fps: number;
  frame: number;
  /** Adaptive quality dropped (DPR 1.5, half particles). One-way. */
  lowQuality: boolean;
}

/** [S] Debug flags (?debug=1 and window.__hippoRun). */
export interface DebugFlags {
  /** ?debug=1: render draws hitboxes, template id, speed, fps. */
  overlay: boolean;
  invincible: boolean;
  autopilot: boolean;
  /** Last spawned template id (overlay label). */
  template: TemplateId | '';
}

/**
 * THE single mutable game state. Created ONCE per createGame (createGameState in state.ts),
 * reset IN PLACE on every start/restart (resetRun). Never replaced, so modules may keep
 * the reference. Pools are allocated once here.
 */
export interface GameState {
  /** [G] State machine. */
  mode: GameMode;
  /** [G] Real s since entering `mode`. */
  modeT: number;
  /** [G] Seed of the current run. */
  seed: number;
  /** [G] Seed for the next start/restart (forceSeed / ?seed=N); -1 = derive. */
  nextSeed: number;
  /** [S] Standalone build (Copy score button). */
  standalone: boolean;
  /** [G] True when this run is the first-ever (no save / tutorial not seen). */
  firstRun: boolean;

  view: ViewMetrics;
  clock: ClockState;
  cam: CameraState;
  hero: HeroState;
  run: RunStats;
  fever: FeverState;
  phase: PhaseState;

  /** [G] Pool of 96 world entities (everything except mangoes). Fixed length. */
  entities: Entity[];
  /** [G] Pool of 160 mangoes / golden mangoes. Fixed length. */
  mangoes: Entity[];
  /** [G] Active counts (debug getState().entities = sum). */
  entityCount: number;
  mangoCount: number;
  /** [G] Next Entity.serial to hand out (reset to 1 every run). */
  nextSerial: number;

  /** [G] Sim time multiplier now (hit-stop is separate). 1 = normal. */
  timeScale: number;
  /** [G] Hit-stop remaining (real s). Sim frozen while > 0; fx keeps running. */
  hitStop: number;

  /** [G] Set on death, null while alive. */
  deathCause: DeathCause | null;

  tutorial: TutorialState;
  pause: PauseState;
  banner: BannerState;
  toast: ToastState;
  summary: SummaryState;
  music: MusicState;

  /** [G] Persisted data (also holds settings muted/reducedMotion). */
  save: SaveData;
  /** [G] Last input device (tutorial says "TAP" vs "SPACE"). */
  lastDevice: InputDevice;
  debug: DebugFlags;
}

/** What render / ui / audio.update receive. */
export type ReadState = DeepReadonly<GameState>;

/* ------------------------------------------------------------------ */
/* Module APIs                                                         */
/* ------------------------------------------------------------------ */

/** Seeded RNG (rng.ts). */
export interface Rng {
  /** Seed this stream was created / last reset with. */
  readonly seed: number;
  /** Float in [0, 1). */
  next(): number;
  /** Float in [a, b). */
  range(a: number, b: number): number;
  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number;
  /** true with probability p. */
  chance(p: number): boolean;
  /** -1 or +1. */
  sign(): number;
  /** Restart the stream with a new seed. */
  reset(seed: number): void;
}

/** One pooled input record (input.ts ring buffer, 32 slots). */
export interface InputEvent {
  kind: InputKind;
  /**
   * performance.now() ms at the DOM event (synthetic: at injection). INFORMATIONAL ONLY (latency
   * diagnostics / ordering): sim logic must not derive durations from it — hold time is measured
   * in sim time (hero.holdT) so debug advance() runs stay deterministic.
   */
  time: number;
  device: InputDevice;
  /** For kind === 'button' only; null otherwise. */
  button: ButtonId | null;
  /** Pointer position in CSS px relative to the canvas (0 for keyboard). */
  x: number;
  y: number;
}

/** Hooks game.ts gives input.ts. Called synchronously inside DOM handlers. */
export interface InputHooks {
  /** Return the canvas button under a pointer (CSS px rel. canvas) or null. Checked BEFORE action. */
  hitTest(cssX: number, cssY: number): ButtonId | null;
  /** Called inside EVERY keydown/pointerdown handler (user-gesture context) before queuing: audio.unlock(). */
  onGesture(): void;
}

/** input.ts */
export interface InputApi {
  /**
   * Pop the oldest pending event. Returns a POOLED record (valid until the next call) or null when
   * empty. Consumers copy what they need. Never allocates.
   */
  next(): InputEvent | null;
  /** Number of pending events. */
  pending(): number;
  /** Drop all pending events (e.g. after restart to avoid stale presses). Held state is kept. */
  clear(): void;
  /** True while at least one action key or action pointer is down (synthetic press counts). */
  isHeld(): boolean;
  /** Device of the most recent input. */
  lastDevice(): InputDevice;
  /** Push a synthetic event (debug API press/release/slam). Updates held state for action kinds. */
  inject(kind: InputKind, button?: ButtonId | null): void;
  /** Force-release everything (window blur): clears held keys/pointers, queues one 'actionUp' if held. */
  releaseAll(): void;
  /** Remove every listener. Idempotent. */
  destroy(): void;
}

/** audio.ts */
export interface AudioApi {
  /** Create (first call) or resume the AudioContext. MUST be called inside a user-gesture handler. Idempotent, cheap. */
  unlock(): void;
  /** Fire a sound effect now. Never throws; no-op when muted/suppressed/unavailable. See SfxId for `param`. */
  play(id: SfxId, param?: number): void;
  /**
   * Once per rendered frame: reads mode, run.time/speed/chain, fever, timeScale to drive the music
   * (layers, tempo at bar lines, filter) and writes state.music (beat clock) — the ONLY GameState
   * field audio writes. Must work (beat clock advancing) even with no AudioContext.
   */
  update(state: GameState, realDt: number): void;
  /** Mute: ramps master to 0 over 50 ms (or back up). Persisting is game.ts's job. */
  setMuted(muted: boolean): void;
  /** Suspend the context (pause / blur / hidden). */
  suspend(): void;
  /** Resume after suspend (call from a gesture path when possible). */
  resume(): void;
  /** While true, play() is a no-op (debug advance()). Music scheduling unaffected. */
  setSuppressed(on: boolean): void;
  /** True when a working AudioContext exists. */
  isAvailable(): boolean;
  /** Close the context, clear the scheduler timer. Idempotent. */
  destroy(): void;
}

/** fx.ts — particles, popups, rings, shake, flashes, fever screen effects. */
export interface FxApi {
  /** Spawn `count` particles of `kind` at world (x, y). hue: chain hue index 0..4 or -1 (kind default). */
  burst(kind: ParticleKind, x: number, y: number, count: number, hue?: number): void;
  /**
   * Floating text at world (x, y): scale 0 -> 1.2 -> 1 in 150 ms, drift up 30 u, fade 0.7 s.
   * `text` is built by the caller at EVENT time (never per frame). color: CSS colour (palette const).
   */
  popup(x: number, y: number, text: string, color: string, size: PopupSize): void;
  /** Expanding ring at world (x, y). hue: chain hue index or -1 (white). */
  ring(kind: RingKind, x: number, y: number, hue: number): void;
  /** Add trauma (0..1, clamped). Ignored in reduced motion. Writes state.cam.trauma. */
  shake(amount: number): void;
  /** Full-screen flash (white near-miss, warm fever start). Ignored in reduced motion. */
  flash(color: string, alpha: number): void;
  /**
   * Advance on REAL dt. game.ts calls it every frame EXCEPT while mode === 'paused' (so particles
   * freeze under the pause menu) — it therefore keeps running during hit-stop, slow-mo, dying,
   * gameover and title. Writes state.cam.shakeX/shakeY/trauma.
   */
  update(realDt: number): void;
  /** Draw world-space fx (particles, rings, popups). ctx already has the camera transform (world -> logical). */
  drawWorld(ctx: CanvasRenderingContext2D): void;
  /** Draw screen-space fx (fever speed lines + warm vignette, flash) in logical view space. */
  drawScreen(ctx: CanvasRenderingContext2D): void;
  /** Kill everything (restart). Resets trauma. */
  clear(): void;
  /** Halve particle spawns (adaptive quality). */
  setLowQuality(on: boolean): void;
  /** Active particle count (debug overlay). */
  count(): number;
}

/** render.ts */
export interface Renderer {
  /** View changed (backing store already resized by game.ts). Rebuild size-dependent caches. */
  resize(view: ViewMetrics): void;
  /**
   * Draw one frame of the world: clears, sets ctx transform, pillarbox sides, sky, parallax,
   * ground/pits, decorations, entities, mangoes, Toto, fx.drawWorld, foreground tufts,
   * night/fever overlays, fx.drawScreen, debug overlay. alpha = interpolation 0..1.
   * MUST leave ctx with the base logical transform (dpr*s, offset padX, no shake), globalAlpha 1,
   * globalCompositeOperation 'source-over' so ui.draw can draw on top.
   */
  draw(state: ReadState, alpha: number): void;
  destroy(): void;
}

/** A canvas button (ui.ts owns the array; positions in LOGICAL units, top-left origin). */
export interface UiButton {
  id: ButtonId;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  visible: boolean;
}

/** ui.ts */
export interface UiApi {
  /** Rebuild layout (button rects etc.) for a new view. */
  layout(view: ViewMetrics): void;
  /** Advance UI-private animations (logo bounce, count-up easing, button press) on real dt. Read-only on state. */
  update(state: ReadState, realDt: number): void;
  /** Draw HUD / screens / buttons. ctx has the base logical transform (see Renderer.draw). */
  draw(ctx: CanvasRenderingContext2D, state: ReadState): void;
  /** Visible button at LOGICAL (lx, ly) for the current state.mode, or null. Hit area >= 48 CSS px. */
  hitTest(state: ReadState, lx: number, ly: number): ButtonId | null;
  /** Current buttons (read-only for others). */
  readonly buttons: ReadonlyArray<UiButton>;
}

/** Services bag passed into gameplay step functions (hero/world). */
export interface Services {
  fx: FxApi;
  audio: AudioApi;
  /** Course RNG: ONLY the generator consumes it (determinism). */
  rng: Rng;
  /** Cosmetic RNG (seed ^ 0x9E3779B9): particles, blinks, phases. Never affects the course. */
  crng: Rng;
}

/* ------------------------------------------------------------------ */
/* Public engine API (spec 14.2) + debug API (spec 14.6)               */
/* ------------------------------------------------------------------ */

export interface GameOptions {
  seed?: number;
  /** Enables the Copy score button. */
  standalone?: boolean;
  onStateChange?: (state: GameMode) => void;
}

export interface GameHandle {
  destroy(): void;
  pause(): void;
  resume(): void;
  setMuted(m: boolean): void;
}

export interface DebugState {
  state: GameMode;
  score: number;
  /** metres */
  distance: number;
  /** u/s */
  speed: number;
  /** run sim seconds */
  time: number;
  chain: number;
  multiplier: number;
  groove: number;
  fever: boolean;
  shield: boolean;
  /** Height of the feet ABOVE the ground line in u (GROUND_Y - hero.y). + = up. */
  heroY: number;
  /** Raw hero.vy u/s (+ = down; jump = -900). */
  heroVy: number;
  grounded: boolean;
  seed: number;
  fps: number;
  /** Active entities + active mangoes. */
  entities: number;
  deathCause: string | null;
  /* ---- integration/test extras (additive) ---- */
  /** Hero feet world x (u). */
  heroX: number;
  /** Sim time multiplier right now (slow-mo / teaching freeze), and hit-stop remaining (real s). */
  timeScale: number;
  hitStop: number;
  /** Screen-shake trauma 0..1 (always 0 in reduced motion). */
  trauma: number;
  /** TOTOTO TIME remaining (sim s). */
  feverT: number;
  /** Current day phase index 0..3 and the bit mask of phases entered this run. */
  phase: number;
  phasesSeen: number;
  bestPassed: boolean;
  /** Tutorial prompts active this run / teaching freeze engaged. */
  tutorial: boolean;
  freeze: boolean;
  /** ACTION presses consumed by the sim since mount (dropped-input checks). */
  presses: number;
  /** Persisted settings / records. */
  muted: boolean;
  reducedMotion: boolean;
  best: number;
  bestDist: number;
  /** View metrics: logical view size, hero screen x, CSS px per logical u. */
  viewW: number;
  viewH: number;
  heroScreenX: number;
  scale: number;
}

/** Lightweight entity snapshot for tests (getEntities). */
export interface DebugEntity {
  kind: EntityKind;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  flag: EntityFlag;
  hazard: boolean;
  serial: number;
}

/** Visible canvas button in CSS px relative to the canvas (getButtons). */
export interface DebugButton {
  id: ButtonId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DebugApi {
  getState(): DebugState;
  /** Applies to the next start/restart. */
  forceSeed(seed: number): void;
  /** Skip title / summary lockouts. */
  start(): void;
  restart(): void;
  /** Synthetic ACTION press / release (consumed on the next sim step). */
  press(): void;
  release(): void;
  slam(): void;
  pause(): void;
  /** Resumes immediately (skips 3-2-1). */
  resume(): void;
  /** Run sim steps synchronously: no rendering, no audio. */
  advance(seconds: number): void;
  /** Ground-jump-only bot (fairness test). */
  setAutopilot(on: boolean): void;
  setInvincible(on: boolean): void;
  /* ---- integration/test extras (additive; allocate freely, never called by the game) ---- */
  /** Active entities and mangoes (copies). */
  getEntities(): DebugEntity[];
  /** Visible canvas buttons for the current mode, in CSS px relative to the canvas. */
  getButtons(): DebugButton[];
  /** Set the groove meter (0..100); 100 starts TOTOTO TIME on the next sim step. */
  setGroove(v: number): void;
}
