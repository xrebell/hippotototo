/**
 * Game shell: lifecycle, fixed-step loop, state machine, scoring/timers, TOTOTO TIME, tutorial,
 * death sequence + run summary, resize/auto-pause, settings, debug API. Owner: GAMEPLAY.
 *
 * ===================== PER-FRAME CALL ORDER (the contract) =====================
 *
 *  frame(rafTime):                                     real dt clamped to 0.1 s
 *    0. pending resize -> computeView, backing store, renderer.resize, ui.layout
 *    1. tick(realDt)                                    (also what advance() runs, per DT)
 *       a. clock / modeT advance (real s)
 *       b. mode switch:
 *          - title:    drain input -> shell (start, buttons); Toto bounces on the title drum
 *          - paused:   drain input -> shell (3-2-1 resume, restart, buttons); countdown
 *          - gameover: drain input -> shell (retry after the lockout, buttons); Toto sits dizzy
 *          - playing / dying: hit-stop (real s) freezes the sim; else accumulator +=
 *            realDt * timeScale and run up to 6 fixed steps of DT = 1/120:
 *              simStep(DT):
 *                1. drain input  -> heroOnInput (action/slam) or shellEvent (pause/mute/buttons)
 *                   (+ autopilot press when enabled)
 *                2. hero         -> stepHero (resolver timers, physics, ground/pits, squash, pose)
 *                3. world scroll -> stepWorld (time/speed/x/cam/phase, generator to hero.x + 3000)
 *                4. entities     -> (inside stepWorld) movement, bobbing, warnings, magnet, recycle
 *                5. collisions   -> collideWorld (landings, bounces, hits, pickups, near miss)
 *                6. scoring      -> scoreStep (distance points, multiplier, groove decay, fever
 *                                    trigger, goals)
 *                7. timers       -> timerStep (fever countdown/exit, tutorial prompts + freeze)
 *            then pacing(realDt): timeScale from death slow-mo / near-miss blip / lesson slow-mo
 *            (0.25x) / teaching freeze (0.02x) (REAL time; pacing never changes the sim outcome),
 *            death card timing. The first-run assisted jump over the lesson bush (tutorialStep) is
 *            a deliberate first-run exception to that rule; it is driven only by sim state
 *            (press + jump + distance to the bush), so determinism holds.
 *       c. real-time UI timers (banner.t, toast.t, tutorial.promptT, fever.introT)
 *       d. fx.update(realDt)  — REAL dt, so particles/shake run during hit-stop (skipped when paused)
 *    2. audio.update(state, realDt)                     (not during advance())
 *    3. renderer.draw(state, alpha)                     alpha = min(1, accumulator / DT)
 *    4. ui.update(state, realDt); ui.draw(ctx, state)
 *    5. adaptive quality check (2 s average > 20 ms -> DPR 1.5 + fx.setLowQuality, once)
 *
 * Gameplay code calls fx.* and audio.play() AT THE MOMENT OF THE EVENT inside steps 2–7.
 * Render, UI and audio.update never mutate GameState (audio writes state.music only; fx writes
 * state.cam.shakeX, shakeY and trauma only).
 *
 * Determinism: the sim (steps 1–7) reads no clock, no Math.random and no view metric that changes
 * the course. timeScale only changes how many fixed steps run per real second.
 * ================================================================================
 */
import {
  DEATH,
  DEATH_CAPTIONS,
  DT,
  FEVER,
  GEN,
  GOALS,
  GROOVE,
  GROUND_Y,
  HERO,
  HITSTOP,
  MAX_FRAME_DT,
  MAX_STEPS_PER_FRAME,
  NEAR_MISS,
  PAL,
  PERF,
  PHYS,
  SCORE,
  SHAKE,
  TITLE,
  TUTORIAL,
  UI,
  UI_TEXT,
} from './config';
import type {
  ButtonId,
  DebugApi,
  DebugButton,
  DebugEntity,
  DebugState,
  GameHandle,
  GameMode,
  GameOptions,
  InputEvent,
  PauseReason,
  Services,
  Entity,
  TutorialPrompt,
} from './types';
import { cosmeticSeed, createRng, parseSeedParam, timeSeed } from './rng';
import { hasStoredSave, loadSave, writeSave } from './storage';
import { computeView, createGameState, goalLabel, medalFor, multiplierFor, resetRun } from './state';
import { createInput } from './input';
import { createAudio } from './audio';
import { createFx } from './fx';
import { createRenderer } from './render';
import { createUI } from './ui';
import { computeHeroTimings, heroOnInput, heroRelease, stepDeadHero, stepHero, stepTitleHero } from './hero';
import { autopilotStep, clearFeverLane, collideWorld, resetWorld, spawnFeverLane, spawnGallery, stepWorld } from './world';
import { createGenerator } from './world-gen';
import { addHitStop, clearHazardsAhead, createSimCtx, pitIndexAt, stillLive } from './world-sim';

type HippoWindow = { __hippoRun?: DebugApi };

const NOOP_HANDLE: GameHandle = {
  destroy(): void {},
  pause(): void {},
  resume(): void {},
  setMuted(): void {},
};

/**
 * Mount the game on a canvas. The canvas must be sized by CSS (it fills its parent box);
 * the backing store is managed here. Safe to call again after destroy() (React StrictMode).
 */
export function createGame(canvas: HTMLCanvasElement, opts?: GameOptions): GameHandle {
  const options: GameOptions = opts || {};
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) return NOOP_HANDLE;
  const ctx: CanvasRenderingContext2D = maybeCtx;

  /* ---------------- setup ---------------- */
  const search = typeof location !== 'undefined' ? location.search : '';
  let urlSeed = -1;
  try {
    urlSeed = parseSeedParam(search);
  } catch (_e) {
    // Malformed %-escape (?seed=%): hash the raw text instead, never throw out of createGame.
    const m = /[?&]seed=([^&#]*)/.exec(search);
    if (m) {
      let hsh = 2166136261;
      for (let i = 0; i < m[1].length; i++) hsh = Math.imul(hsh ^ m[1].charCodeAt(i), 16777619);
      urlSeed = hsh >>> 0;
    }
  }
  const galleryMode = /[?&]gallery=1(?:&|#|$)/.test(search);
  const forcedSeed = options.seed !== undefined ? options.seed >>> 0 : urlSeed;

  const firstEver = !hasStoredSave();
  const save = loadSave();
  const seed0 = forcedSeed >= 0 ? forcedSeed : timeSeed();
  const state = createGameState(seed0, save, !!options.standalone);
  state.nextSeed = forcedSeed;
  state.firstRun = firstEver || !save.tutorialSeen;
  state.debug.overlay = /[?&]debug=1(?:&|#|$)/.test(search);

  const rng = createRng(seed0);
  const crng = createRng(cosmeticSeed(seed0));
  const fx = createFx(state, crng);
  const audio = createAudio();
  const sv: Services = { fx, audio, rng, crng };
  const renderer = createRenderer(ctx, fx, crng);
  const ui = createUI({ standalone: state.standalone });
  audio.setMuted(state.save.muted);

  const sim = createSimCtx(computeHeroTimings());
  sim.genEnabled = !galleryMode;
  const gen = createGenerator(state, sv, sim);

  const input = createInput(canvas, {
    hitTest(cssX: number, cssY: number): ButtonId | null {
      const v = state.view;
      return ui.hitTest(state, (cssX - v.padX) / v.s, cssY / v.s);
    },
    onGesture(): void {
      audio.unlock();
    },
  });

  let destroyed = false;
  let rafId = 0;
  let lastT = -1;
  let acc = 0;
  let needsResize = true;
  /** Real seconds since the fatal hit (death sequence timing). */
  let deathReal = 0;
  /** ACTION presses consumed by the sim since mount (debug: dropped-input checks). */
  let pressCount = 0;
  // adaptive quality
  let perfSum = 0;
  let perfN = 0;

  /* ---------------- safe-area probe ---------------- */
  let probe: HTMLDivElement | null = null;
  try {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
      'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
    document.body.appendChild(probe);
  } catch (_e) {
    probe = null;
  }

  function readInset(v: string): number {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  /* ---------------- resize ---------------- */
  function doResize(): void {
    needsResize = false;
    const rect = canvas.getBoundingClientRect();
    const oldW = state.view.cssW;
    const oldH = state.view.cssH;
    let l = 0;
    let r = 0;
    let t = 0;
    let b = 0;
    if (probe) {
      const cs = getComputedStyle(probe);
      t = readInset(cs.paddingTop);
      r = readInset(cs.paddingRight);
      b = readInset(cs.paddingBottom);
      l = readInset(cs.paddingLeft);
    }
    computeView(rect.width, rect.height, window.devicePixelRatio || 1, l, r, t, b, state.clock.lowQuality, state.view);
    const v = state.view;
    const bw = Math.max(1, Math.round(v.cssW * v.dpr));
    const bh = Math.max(1, Math.round(v.cssH * v.dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    v.version++;
    // keep the camera consistent with the (possibly new) hero screen x
    state.cam.x = state.hero.x - v.heroX;
    state.cam.prevX = state.cam.x;
    renderer.resize(v);
    ui.layout(v);
    const changed = Math.abs(oldW - v.cssW) > 1 || Math.abs(oldH - v.cssH) > 1;
    if (changed && state.view.version > 1) pauseGame('resize');
  }

  function requestResize(): void {
    needsResize = true;
  }

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(requestResize);
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
  }
  window.addEventListener('resize', requestResize);
  window.addEventListener('orientationchange', requestResize);

  // devicePixelRatio changes (browser zoom, moving to another monitor) fire no resize event.
  let dprMql: MediaQueryList | null = null;
  function onDprChange(): void {
    requestResize();
    armDpr();
  }
  function disarmDpr(): void {
    const m = dprMql;
    dprMql = null;
    if (m === null) return;
    try {
      if (typeof m.removeEventListener === 'function') m.removeEventListener('change', onDprChange);
      else if (typeof m.removeListener === 'function') m.removeListener(onDprChange);
    } catch (_e) {
      /* ignore */
    }
  }
  function armDpr(): void {
    disarmDpr();
    if (destroyed) return;
    try {
      if (typeof window.matchMedia !== 'function') return;
      const m = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      if (!m) return;
      if (typeof m.addEventListener === 'function') m.addEventListener('change', onDprChange);
      else if (typeof m.addListener === 'function') m.addListener(onDprChange);
      else return;
      dprMql = m;
    } catch (_e) {
      dprMql = null;
    }
  }
  armDpr();

  /* ---------------- auto-pause ---------------- */
  /** Menus (title / dying / gameover) get their music back on return; a paused run stays silent. */
  function resumeMenuAudio(): void {
    if (state.mode !== 'paused' && state.mode !== 'playing') audio.resume();
  }
  function onVisibility(): void {
    if (document.hidden) {
      pauseGame('hidden');
      audio.suspend();
    } else resumeMenuAudio();
  }
  function onBlur(): void {
    input.releaseAll();
    pauseGame('blur');
    audio.suspend();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', resumeMenuAudio);

  /* ---------------- state machine ---------------- */
  function setMode(m: GameMode): void {
    if (state.mode === m) return;
    state.mode = m;
    state.modeT = 0;
    if (options.onStateChange) options.onStateChange(m);
  }

  function startRun(): void {
    const seed = state.nextSeed >= 0 ? state.nextSeed : timeSeed();
    rng.reset(seed);
    crng.reset(cosmeticSeed(seed));
    resetRun(state, seed);
    state.firstRun = !state.save.tutorialSeen;
    state.tutorial.active = state.firstRun;
    fx.clear();
    resetWorld(state, sv, sim, gen);
    if (galleryMode) {
      spawnGallery(state, sv);
      state.debug.invincible = true;
    }
    acc = 0;
    deathReal = 0;
    state.clock.alpha = 0;
    audio.resume();
    setMode('playing');
  }

  function pauseGame(reason: PauseReason): void {
    if (state.mode === 'paused') {
      // Interrupt a running 3-2-1: back to the full pause menu (never auto-resume).
      if (state.pause.countdown > 0) state.pause.countdown = 0;
      return;
    }
    if (state.mode !== 'playing') return;
    state.pause.reason = reason;
    state.pause.countdown = 0;
    input.releaseAll();
    setMode('paused');
    audio.suspend();
  }

  /** Fairness rule 8: no hazard within 1.0 s after a resume (poof the offenders). */
  function afterResume(): void {
    clearHazardsAhead(state, sv, sim, GEN.safeAfterEventS, 0, state.hero.pitIndex);
  }

  /** Resume: with the 3-2-1 countdown (normal) or immediately (debug). */
  function resumeGame(immediate: boolean): void {
    if (state.mode !== 'paused') return;
    audio.resume();
    if (immediate) {
      state.pause.countdown = 0;
      setMode('playing');
      afterResume();
      return;
    }
    if (state.pause.countdown > 0) return;
    state.pause.countdown = UI.countdownStep * UI.countdownFrom;
    audio.play('countdown', UI.countdownFrom);
  }

  function setMuted(m: boolean): void {
    state.save.muted = m;
    audio.setMuted(m);
    writeSave(state.save);
  }

  function toggleMotion(): void {
    state.save.reducedMotion = !state.save.reducedMotion;
    writeSave(state.save);
  }

  function showToast(text: string): void {
    state.toast.text = text;
    state.toast.t = 0;
    state.toast.dur = UI.toastDur;
  }

  function copyScore(): void {
    const text =
      'I scored ' + state.summary.score + ' and ran ' + state.summary.distance + ' m in Hippo Tototo: Stomp the Beat!';
    try {
      const clip = navigator.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(text).then(
          () => showToast(UI_TEXT.copied),
          () => showToast(UI_TEXT.copyFail),
        );
      } else {
        showToast(UI_TEXT.copyFail);
      }
    } catch (_e) {
      showToast(UI_TEXT.copyFail);
    }
  }

  function canRetry(): boolean {
    return state.mode === 'gameover' && state.modeT >= DEATH.inputLockout;
  }

  function onButton(id: ButtonId): void {
    audio.play('click');
    switch (id) {
      case 'pause':
        pauseGame('user');
        break;
      case 'sound':
        setMuted(!state.save.muted);
        break;
      case 'motion':
        toggleMotion();
        break;
      case 'resume':
        resumeGame(false);
        break;
      case 'restart':
        startRun();
        break;
      case 'copy':
        copyScore();
        break;
    }
  }

  /** Non-hero events, valid in every mode. */
  function shellEvent(ev: InputEvent): void {
    switch (ev.kind) {
      case 'button':
        if (ev.button !== null) onButton(ev.button);
        break;
      case 'mute':
        setMuted(!state.save.muted);
        break;
      case 'pause':
        if (state.mode === 'playing') pauseGame('user');
        else if (state.mode === 'paused') {
          // During the 3-2-1: back to the full pause menu (no resume).
          if (state.pause.countdown > 0) state.pause.countdown = 0;
          else resumeGame(false);
        }
        break;
      case 'restart':
        if (state.mode === 'paused' || canRetry()) startRun();
        break;
      case 'confirm':
      case 'actionDown':
        if (state.mode === 'title' || canRetry()) startRun();
        else if (state.mode === 'paused' && ev.kind === 'confirm') resumeGame(false);
        break;
      case 'actionUp':
        // Released while a menu is up (e.g. blur releaseAll): the hero must not stay "held".
        heroRelease(state, sim);
        break;
      default:
        break;
    }
  }

  function noteDevice(ev: InputEvent): void {
    if (ev.device !== 'synthetic') state.lastDevice = ev.device;
  }

  /** Menu modes: drain everything into the shell. */
  function drainMenuInput(): void {
    let ev = input.next();
    while (ev !== null) {
      noteDevice(ev);
      shellEvent(ev);
      ev = input.next();
    }
  }

  /** Sim step 1: action/slam -> hero; everything else -> shell. */
  function drainSimInput(): void {
    let ev = input.next();
    while (ev !== null) {
      noteDevice(ev);
      if (ev.kind === 'actionDown' || ev.kind === 'actionUp' || ev.kind === 'slam') {
        if (state.mode === 'playing') {
          if (ev.kind === 'actionDown') pressCount++;
          heroOnInput(state, sv, sim, ev);
        }
      } else {
        shellEvent(ev);
        if (state.mode !== 'playing' && state.mode !== 'dying') return;
      }
      ev = input.next();
    }
  }

  /* ---------------- TOTOTO TIME ---------------- */
  function startFever(): void {
    const f = state.fever;
    const h = state.hero;
    f.active = true;
    f.t = FEVER.duration;
    f.count++;
    f.introT = 0;
    state.run.groove = GROOVE.max;
    h.exprT = 0;
    h.expr = 'star';
    // Entry beat (ui draws the TOTOTO TIME banner from fever.introT).
    addHitStop(state, HITSTOP.fever);
    fx.shake(SHAKE.fever);
    fx.flash(PAL.grooveB, 0.35);
    fx.burst('star', h.x, h.y - 40, 10);
    audio.play('feverStart');
    spawnFeverLane(state, sv, sim);
  }

  function endFever(): void {
    const f = state.fever;
    const h = state.hero;
    f.active = false;
    f.t = 0;
    state.run.groove = 0;
    if (h.invulnT < FEVER.exitInvuln) h.invulnT = FEVER.exitInvuln;
    clearHazardsAhead(state, sv, sim, GEN.safeAfterEventS, FEVER.clearAhead, -1);
    clearFeverLane(state, sv, sim);
    audio.play('feverEnd');
    // One breather per fever: the chunk generated next lands just after the exit.
    sim.gen.forceBreather = true;
  }

  /* ---------------- goals ---------------- */
  /** Goal `gi` satisfied by this run's stats. */
  function goalMet(gi: number): boolean {
    const r = state.run;
    if (gi < 0 || gi >= GOALS.length) return false;
    switch (GOALS[gi].id) {
      case 'chain3':
        return r.chainBest >= 3;
      case 'noon':
        return (r.phasesSeen & 2) !== 0;
      case 'boom':
        return r.booms > 0;
      case 'stomp':
        return sim.hornbillStomps > 0;
      case 'fever':
        return state.fever.count > 0;
      case 'chain6':
        return r.chainBest >= 6;
      case 'dusk':
        return (r.phasesSeen & 4) !== 0;
      case 'night':
        return (r.phasesSeen & 8) !== 0;
    }
    return false;
  }

  function checkGoal(): void {
    const r = state.run;
    if (r.goalDone) return;
    const gi = sim.goalAtStart;
    if (goalMet(gi)) {
      r.goalDone = true;
      showToast('GOAL ✓ ' + GOALS[gi].label);
    }
  }

  /* ---------------- tutorial (first-ever run) ---------------- */
  function setPrompt(p: TutorialPrompt): void {
    const tu = state.tutorial;
    if (tu.prompt === p) return;
    tu.prompt = p;
    tu.promptT = 0;
  }

  function endFreeze(): void {
    if (!state.tutorial.freeze) return;
    state.tutorial.freeze = false;
    sim.freezeDone = true;
  }

  /**
   * BOING moment: slamming down onto plain ground (not a drum / stompable top: that is a BOOM; not a
   * pit: that is a SPLORCH), or on the ground inside the boing window after a slam.
   */
  function boingMoment(): boolean {
    const h = state.hero;
    if (h.grounded) return h.postSlamT <= PHYS.boingWindow;
    if (h.action !== 'slamHang' && h.action !== 'slam') return false;
    const dive = (h.action === 'slamHang' ? h.hangT : 0) + Math.max(0, GROUND_Y - h.y) / PHYS.slamVy;
    const lx = h.x + state.run.speed * dive;
    if (pitIndexAt(state, lx) >= 0) return false;
    const half = HERO.hurtW / 2 + PHYS.landWiden;
    const ents = state.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.active || !e.stompable || e.flag !== 'none' || e.y < h.y - 1) continue;
      if (lx + half > e.x && h.x - half < e.x + e.w) return false;
    }
    return true;
  }

  /**
   * Prompts (priority tap > slam/drum > boing > hold) + teaching freeze + lesson slow-mo triggers.
   * First run: TAP at the first bush; JUMP ON THE DRUM / SLAM (on Toto, near the apex after drum 1)
   * at the lesson drum pair; BOING on Toto during any ground slam. Runs 1-3: HOLD over the first
   * mound. Every trigger reads sim state only.
   */
  function tutorialStep(): void {
    const tu = state.tutorial;
    const h = state.hero;
    const bushLive = stillLive(sim.tutBush, sim.tutBushSerial);
    // Assisted first jump: a ground jump pressed within TUTORIAL.assistS of the lesson bush is never
    // cut, so any tap clears it (also in reduced motion, which has no freeze). Before endFreeze.
    if (state.firstRun && bushLive && sim.pressed && sim.jumped && h.action === 'air') {
      const ttc = (sim.tutBushLeft - (h.x + HERO.hurtW / 2)) / state.run.speed;
      if (ttc > 0 && ttc <= TUTORIAL.assistS) {
        sim.cuttable = false;
        h.cutPending = false;
      }
    }
    if (sim.pressed) sim.lessonSlowT = 0;
    if (tu.active && state.run.time > TUTORIAL.promptsEnd) {
      tu.active = false;
      endFreeze();
    }
    let p: TutorialPrompt = 'none';
    let px = 0;
    let py = 0;
    if (tu.active) {
      if (bushLive && h.x < sim.tutBushX + 30 && sim.tutBushX - h.x < 760) {
        p = 'tap';
        px = sim.tutBushX;
        py = sim.tutBushTop - 64;
      } else if (sim.tutSlamX0 > 0 && h.x > sim.tutSlamX0 - 760 && h.x < sim.tutSlamX1 + 40) {
        if (h.grounded && h.x < sim.tutSlamX0) {
          p = 'drum';
          px = sim.tutSlamX0;
          py = GROUND_Y - 150;
        } else if (h.action === 'air' && state.run.chain >= 1 && !h.slamUsed && h.vy > -250) {
          p = 'slam';
          px = h.x;
          py = h.y - 110;
          if (!sim.slamTaught) {
            sim.slamTaught = true;
            sim.lessonSlowT = TUTORIAL.slamSlowMax;
          }
        }
      }
      if (p === 'none' && boingMoment()) {
        p = 'boing';
        px = h.x;
        py = GROUND_Y - 120;
        // Lesson order TAP -> SLAM -> BOING: no BOING slow-mo before the TAP bush is behind Toto.
        if (!sim.boingTaught && h.x >= sim.tutBushX + 30) {
          sim.boingTaught = true;
          sim.lessonSlowT = TUTORIAL.boingSlowMax;
        }
      } else if (
        p === 'none' &&
        h.action === 'air' &&
        stillLive(sim.tutGold, sim.tutGoldSerial) &&
        h.x < sim.tutGoldX + 20 &&
        sim.tutGoldX - h.x < 820
      ) {
        // The golden mango on the BOING line (airborne only: tapping while running is a jump).
        p = 'boing';
        px = sim.tutGoldX;
        py = sim.tutGoldY + 56;
      }
    }
    // HOLD over the first live mound (runs 1-3, independent of the first-run tutorial).
    if (p === 'none' && !sim.holdShown && state.save.runs < TUTORIAL.holdRuns) {
      const ents = state.entities;
      let best: Entity | null = null;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (!e.active || e.kind !== 'mound' || e.flag !== 'none') continue;
        if (e.x + e.w / 2 < h.x) {
          if (e.serial === sim.holdSerial) sim.holdShown = true;
        } else if (best === null || e.x < best.x) best = e;
      }
      if (!sim.holdShown && best !== null && best.x + best.w / 2 - h.x <= 760) {
        p = 'hold';
        px = best.x + best.w / 2;
        py = best.y - 64;
        sim.holdSerial = best.serial;
      }
    }
    setPrompt(p);
    tu.promptX = px;
    tu.promptY = py;
    // Teaching freeze: no jump started TUTORIAL.freezeLead s before touching the first bush.
    if (p === 'tap' && bushLive && !sim.freezeDone && !tu.freeze && h.grounded && !state.save.reducedMotion) {
      const ttc = (sim.tutBushLeft - (h.x + HERO.hurtW / 2)) / state.run.speed;
      if (ttc <= TUTORIAL.freezeLead && ttc > 0) {
        tu.freeze = true;
        sim.freezeReal = 0;
      }
    }
    if (tu.freeze && (sim.pressed || !h.grounded || !bushLive)) endFreeze();
  }

  /* ---------------- simulation ---------------- */
  function scoreStep(dt: number): void {
    const r = state.run;
    const h = state.hero;
    const m = Math.floor(r.distance);
    if (m > r.metresScored) {
      r.score += (m - r.metresScored) * SCORE.perMetre * (state.fever.active ? SCORE.feverMult : 1);
      r.metresScored = m;
    }
    r.multiplier = multiplierFor(r.chain);
    // Trigger BEFORE the grounded decay, so a meter filled to 100 this step always fires.
    if (!state.fever.active && r.groove >= GROOVE.max) startFever();
    // Decays on the ground and on chainless flights (jumps / boings), never during a chain.
    if (!state.fever.active && (h.grounded || r.chain === 0) && r.groove > 0) {
      r.groove -= GROOVE.decayPerS * dt;
      if (r.groove < 0) r.groove = 0;
    }
    checkGoal();
  }

  function timerStep(dt: number): void {
    const f = state.fever;
    if (f.active) {
      f.t -= dt;
      state.run.groove = GROOVE.max;
      if (f.t <= 0) endFever();
    }
    tutorialStep();
  }

  function enterDying(): void {
    const tu = state.tutorial;
    tu.freeze = false;
    setPrompt('none');
    deathReal = 0;
    setMode('dying');
  }

  /** Summary card + save, once, when the card appears. */
  function enterGameOver(): void {
    const r = state.run;
    const s = state.save;
    const sm = state.summary;
    const dist = Math.floor(r.distance);
    const prevBest = s.best;
    const prevDist = s.bestDist;
    sm.score = r.score;
    sm.distance = dist;
    sm.chainBest = r.chainBest;
    sm.mangoes = r.mangoes + r.golden;
    sm.stomps = r.stomps;
    sm.newBest = r.score > prevBest;
    sm.bestBy = sm.newBest ? r.score - prevBest : 0;
    sm.shortBy = !sm.newBest && prevDist > dist ? prevDist - dist : 0;
    sm.medal = medalFor(r.score);
    const caps = DEATH_CAPTIONS[state.deathCause !== null ? state.deathCause : 'bush'];
    sm.caption = caps[crng.int(0, caps.length - 1)];
    if (state.deathCause === 'mound' && s.runs < TUTORIAL.holdCaptionRuns) sm.caption = UI_TEXT.holdCaption;
    // Came down on a bush from a hop (pressed too early) on the first runs: say how to fix it.
    if (state.deathCause === 'bush' && sim.deathFalling && s.runs < TUTORIAL.holdCaptionRuns) sm.caption = UI_TEXT.bushEarlyCaption;
    if (!r.goalDone && goalMet(sim.goalAtStart)) r.goalDone = true; // met on the fatal step
    sm.goalDone = r.goalDone;
    sm.goalDoneText = r.goalDone ? goalLabel(sim.goalAtStart) : '';
    if (r.goalDone && s.goalIndex === sim.goalAtStart && s.goalIndex < GOALS.length) s.goalIndex++;
    // Never show "Next:" for something this run already did.
    while (s.goalIndex < GOALS.length && goalMet(s.goalIndex)) s.goalIndex++;
    sm.goalText = goalLabel(s.goalIndex);
    if (r.score > s.best) s.best = r.score;
    if (dist > s.bestDist) s.bestDist = dist;
    if (r.chainBest > s.bestChain) s.bestChain = r.chainBest;
    s.runs++;
    s.totalMangoes += r.mangoes + r.golden;
    s.tutorialSeen = true;
    writeSave(s);
    state.timeScale = 1;
    setMode('gameover');
  }

  function simStep(dt: number): void {
    sim.pressed = false;
    sim.jumped = false;
    drainSimInput(); // 1
    if (state.mode !== 'playing' && state.mode !== 'dying') return;
    if (state.debug.autopilot && state.mode === 'playing') autopilotStep(state, sv, sim);
    stepHero(state, sv, sim, dt); // 2
    stepWorld(state, sv, sim, gen, dt); // 3 + 4
    collideWorld(state, sv, sim, dt); // 5
    if (sim.died) {
      sim.died = false;
      enterDying();
    }
    if (state.mode !== 'playing') return;
    scoreStep(dt); // 6
    timerStep(dt); // 7
  }

  function simFrame(realDt: number): void {
    if (state.hitStop > 0) {
      state.hitStop -= realDt;
      if (state.hitStop < 0) state.hitStop = 0;
      return;
    }
    acc += realDt * state.timeScale;
    // Slow-mo (teaching freeze 0.02x, lesson 0.25x, near miss 0.6x): a pending press must not wait
    // for the next slow step. Run one step now so it acts on this frame (the slow-mo then eases out).
    if (state.mode === 'playing' && state.timeScale < 1 && acc < DT && input.pending() > 0) acc = DT;
    let steps = 0;
    while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
      simStep(DT);
      acc -= DT;
      steps++;
      if (state.mode !== 'playing' && state.mode !== 'dying') {
        acc = 0;
        break;
      }
      if (state.hitStop > 0) {
        // Frozen until the hit-stop ends: never let render extrapolate past the last step.
        if (acc >= DT) acc = DT * 0.999;
        break;
      }
    }
    if (steps >= MAX_STEPS_PER_FRAME && acc >= DT) acc = 0;
    state.clock.alpha = Math.min(1, acc / DT);
  }

  /** Real-time pacing: timeScale (death slow-mo, near-miss blip, lesson slow-mo, teaching freeze) + death card. */
  function pacing(realDt: number): void {
    const rm = state.save.reducedMotion;
    const tu = state.tutorial;
    if (sim.lessonSlowT > 0) sim.lessonSlowT = Math.max(0, sim.lessonSlowT - realDt);
    if (tu.freeze) {
      sim.freezeReal += realDt;
      if (sim.freezeReal >= TUTORIAL.freezeMax) endFreeze();
    }
    if (tu.freeze && !rm) sim.freezeLevel = Math.min(1, sim.freezeLevel + realDt / TUTORIAL.freezeEaseIn);
    else sim.freezeLevel = Math.max(0, sim.freezeLevel - realDt / TUTORIAL.freezeEaseOut);
    if (state.hitStop <= 0 && sim.nearSlowT > 0) sim.nearSlowT = Math.max(0, sim.nearSlowT - realDt);
    let ts = 1;
    if (state.mode === 'dying') {
      deathReal += realDt;
      const hs = rm ? HITSTOP.reducedMotionCap : HITSTOP.death;
      if (!rm && deathReal < hs + DEATH.slowDur) ts = DEATH.slowScale;
      if (deathReal >= DEATH.cardAt) {
        enterGameOver();
        return;
      }
    } else {
      if (!rm && sim.nearSlowT > 0) ts = NEAR_MISS.slowScale;
      if (!rm && sim.lessonSlowT > 0 && state.mode === 'playing' && TUTORIAL.lessonScale < ts) ts = TUTORIAL.lessonScale;
      if (sim.freezeLevel > 0) {
        const k = sim.freezeLevel;
        const e = k * k * (3 - 2 * k);
        const f = 1 + (TUTORIAL.freezeScale - 1) * e;
        if (f < ts) ts = f;
      }
    }
    state.timeScale = ts;
  }

  function titleStep(realDt: number): void {
    state.cam.prevX = state.cam.x;
    state.cam.x += TITLE.driftSpeed * realDt;
    stepTitleHero(state, sv, sim, realDt);
    state.clock.alpha = 1;
  }

  function pausedStep(realDt: number): void {
    const p = state.pause;
    if (p.countdown <= 0) return;
    const before = Math.ceil(p.countdown / UI.countdownStep);
    p.countdown -= realDt;
    if (p.countdown <= 0) {
      p.countdown = 0;
      audio.play('go');
      setMode('playing');
      afterResume();
      return;
    }
    const after = Math.ceil(p.countdown / UI.countdownStep);
    if (after !== before) audio.play('countdown', after);
  }

  /** Everything except drawing/audio.update. advance() calls this with realDt = DT. */
  function tick(realDt: number): void {
    const c = state.clock;
    c.now += realDt;
    c.frameDt = realDt;
    c.frame++;
    state.modeT += realDt;
    switch (state.mode) {
      case 'title':
        drainMenuInput();
        if (state.mode === 'title') titleStep(realDt);
        break;
      case 'paused':
        drainMenuInput();
        if (state.mode === 'paused') pausedStep(realDt);
        break;
      case 'gameover':
        drainMenuInput();
        if (state.mode === 'gameover') {
          stepDeadHero(state, sv, sim, realDt);
          state.clock.alpha = 1;
        }
        break;
      case 'playing':
      case 'dying':
        simFrame(realDt);
        if (state.mode === 'playing' || state.mode === 'dying') pacing(realDt);
        break;
    }
    state.banner.t += realDt;
    state.toast.t += realDt;
    state.tutorial.promptT += realDt;
    if (state.fever.active && state.mode !== 'paused') state.fever.introT += realDt;
    if (state.mode !== 'paused') fx.update(realDt);
  }

  /* ---------------- frame loop ---------------- */
  function frame(t: number): void {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    let dt = lastT < 0 ? 0 : (t - lastT) / 1000;
    lastT = t;
    if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    if (dt < 0) dt = 0;
    if (dt > 0) state.clock.fps += (1 / dt - state.clock.fps) * 0.05;

    if (needsResize) doResize();
    tick(dt);
    audio.update(state, dt);
    renderer.draw(state, state.clock.alpha);
    ui.update(state, dt);
    ui.draw(ctx, state);

    // Adaptive quality (one-way): only measured while playing and visible.
    if (!state.clock.lowQuality && state.mode === 'playing' && dt > 0) {
      perfSum += dt;
      perfN++;
      if (perfSum >= PERF.windowS) {
        if ((perfSum / perfN) * 1000 > PERF.slowFrameMs) {
          state.clock.lowQuality = true;
          fx.setLowQuality(true);
          needsResize = true;
        }
        perfSum = 0;
        perfN = 0;
      }
    }
  }

  /* ---------------- debug API ---------------- */
  const debugApi: DebugApi = {
    getState(): DebugState {
      const h = state.hero;
      return {
        state: state.mode,
        score: state.run.score,
        distance: state.run.distance,
        speed: state.run.speed,
        time: state.run.time,
        chain: state.run.chain,
        multiplier: state.run.multiplier,
        groove: state.run.groove,
        fever: state.fever.active,
        shield: h.shield,
        heroY: GROUND_Y - h.y,
        heroVy: h.vy,
        grounded: h.grounded,
        seed: state.seed,
        fps: Math.round(state.clock.fps),
        entities: state.entityCount + state.mangoCount,
        deathCause: state.deathCause,
        heroX: h.x,
        timeScale: state.timeScale,
        hitStop: state.hitStop,
        trauma: state.cam.trauma,
        feverT: state.fever.t,
        phase: state.phase.index,
        phasesSeen: state.run.phasesSeen,
        bestPassed: state.run.bestPassed,
        tutorial: state.tutorial.active,
        freeze: state.tutorial.freeze,
        presses: pressCount,
        muted: state.save.muted,
        reducedMotion: state.save.reducedMotion,
        best: state.save.best,
        bestDist: state.save.bestDist,
        viewW: state.view.viewW,
        viewH: state.view.viewH,
        heroScreenX: state.view.heroX,
        scale: state.view.s,
      };
    },
    getEntities(): DebugEntity[] {
      const out: DebugEntity[] = [];
      const pools = [state.entities, state.mangoes];
      for (let p = 0; p < pools.length; p++) {
        const pool = pools[p];
        for (let i = 0; i < pool.length; i++) {
          const e = pool[i];
          if (!e.active) continue;
          out.push({ kind: e.kind, x: e.x, y: e.y, w: e.w, h: e.h, vx: e.vx, flag: e.flag, hazard: e.hazard, serial: e.serial, lane: e.lane });
        }
      }
      return out;
    },
    getButtons(): DebugButton[] {
      const v = state.view;
      ui.hitTest(state, -1e6, -1e6); // re-sync visibility with the current mode
      const out: DebugButton[] = [];
      const bs = ui.buttons;
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if (!b.visible) continue;
        out.push({ id: b.id, x: v.padX + b.x * v.s, y: b.y * v.s, w: b.w * v.s, h: b.h * v.s });
      }
      return out;
    },
    setGroove(v: number): void {
      if (state.mode !== 'playing' || state.fever.active) return;
      state.run.groove = v < 0 ? 0 : v > GROOVE.max ? GROOVE.max : v;
    },
    forceSeed(seed: number): void {
      state.nextSeed = seed >>> 0;
    },
    start(): void {
      if (state.mode !== 'playing') startRun();
    },
    restart(): void {
      startRun();
    },
    press(): void {
      input.inject('actionDown');
    },
    release(): void {
      input.inject('actionUp');
    },
    slam(): void {
      input.inject('slam');
    },
    pause(): void {
      pauseGame('user');
    },
    resume(): void {
      resumeGame(true);
    },
    advance(seconds: number): void {
      const n = Math.max(0, Math.round(seconds / DT));
      audio.setSuppressed(true);
      sim.quiet = true;
      try {
        for (let i = 0; i < n && !destroyed; i++) tick(DT);
      } finally {
        sim.quiet = false;
        audio.setSuppressed(false);
      }
    },
    setAutopilot(on: boolean): void {
      state.debug.autopilot = on;
      if (!on && state.hero.held) heroRelease(state, sim);
    },
    setInvincible(on: boolean): void {
      state.debug.invincible = on;
    },
  };
  const hw = window as unknown as HippoWindow;
  hw.__hippoRun = debugApi;

  /* ---------------- start ---------------- */
  doResize();
  if (options.onStateChange) options.onStateChange(state.mode);
  rafId = requestAnimationFrame(frame);

  /* ---------------- handle ---------------- */
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', requestResize);
      window.removeEventListener('orientationchange', requestResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', resumeMenuAudio);
      disarmDpr();
      input.destroy();
      audio.destroy();
      renderer.destroy();
      if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
      probe = null;
      if (hw.__hippoRun === debugApi) delete hw.__hippoRun;
    },
    pause(): void {
      pauseGame('user');
    },
    resume(): void {
      resumeGame(false);
    },
    setMuted(m: boolean): void {
      setMuted(m);
    },
  };
}
