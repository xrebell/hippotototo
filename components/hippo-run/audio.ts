/**
 * All audio: WebAudio synthesis only (zero files). Owner: AUDIO engineer.
 *
 * Files: audio.ts (this: context lifecycle, bus graph, mix automation, voice limiting, the
 * AudioApi), audio-synth.ts (voice primitives + every SFX recipe), audio-music.ts (look-ahead
 * music scheduler + arrangement).
 *
 * Graph (spec §11):
 *
 *   voices ──> sfxBus (0.7) ─────────────────────────────────┐
 *     └─(some)─> echo send ─> delay (1/16 note) ─> lowpass ─┬─> feedback ─> delay
 *                                                           └─> wet ─> sfxBus
 *   music voices ─> [pan L/C/R] ─> musicBus (0.32 × level) ─> musicFilter (lowpass)
 *                                                            ─> duck ──────┤
 *                                          DynamicsCompressor (-18 dB, 4:1) ┘ ─> master ─> destination
 *
 *  - One shared 1 s white-noise buffer (deterministic PRNG, never Math.random).
 *  - unlock(): the AudioContext is created lazily on the first call, which always comes from a
 *    gesture handler (input hooks.onGesture). If the browser reports no user activation yet
 *    (e.g. touch pointerdown, which only activates on pointerup) creation is deferred to the next
 *    activating event (pointerup / touchend / click / keydown listeners, removed once running)
 *    so Chrome never logs its autoplay warning. Later calls resume a suspended context — unless
 *    the game is paused (the shell resumes audio when the pause ends).
 *  - Missing / failing AudioContext: `failed`, every call is a silent no-op, isAvailable() is
 *    false and update() still advances state.music from real dt (fallback beat clock).
 *  - play(id, param): fire-and-forget voices at ctx.currentTime (never quantised). Per-id
 *    polyphony + minimum spacing (mango / melon / smash bursts are spread into a quick arpeggio
 *    instead of stacking) and a global voice cap, so nothing clips or piles up. Big hits briefly
 *    duck the music; every drum / BOOM hit ducks it 3 dB (never below a bigger duck in progress).
 *  - update(state, realDt) once per frame: copies the inputs the arrangement needs, pumps the
 *    scheduler (also pumped by a 25 ms setInterval), drives musicFilter / music level from the
 *    mode (title soft, fever open, last 1.5 s of fever closing to 1.2 kHz, slow-mo dip,
 *    paused 600 Hz, dying/gameover sweep to 300 Hz at half level), and writes state.music
 *    {bpm, beatPhase, beat} from the audio clock (latency-compensated) or the fallback clock.
 *    It allocates nothing.
 *  - setMuted(m): master ramps to 0 / back over 50 ms (persisting is game.ts's job); while muted
 *    play() is a no-op and the scheduler keeps time without creating voices.
 *  - suspend()/resume(): master fades over 30 ms, then ctx.suspend(); resume() un-suspends and
 *    fades back in. All promise rejections are swallowed.
 *  - setSuppressed(true): play() is a no-op (debug advance()); music scheduling unaffected.
 *  - destroy(): idempotent; clears the scheduler interval and pending timers, removes the
 *    deferred-unlock listeners and closes the context.
 *  - No DOM / AudioContext access at module top level (the module is evaluated during SSR).
 */
import { AUDIO, DEATH, FEVER, SPEED } from './config';
import { createMusic } from './audio-music';
import type { Music } from './audio-music';
import { playSfx } from './audio-synth';
import type { SynthEnv } from './audio-synth';
import { mulberry32Next } from './rng';
import type { AudioApi, GameState, SfxId } from './types';

export { chainNoteHz, semiHz } from './audio-synth';

/** Master level when unmuted (headroom above the compressor). */
const MASTER_LEVEL = 0.9;
/** Title music is also a little darker. */
const TITLE_CUT = 4200;
/** Lowest music cutoff during slow-mo (reached at <= 0.15x, e.g. the teaching freeze); near-miss 0.6x dips partway. */
const SLOWMO_CUT = 520;
/** Music level while paused (only audible during the 3-2-1, the context is suspended otherwise). */
const PAUSED_LEVEL = 0.55;
/**
 * Extra game-over attenuation on top of AUDIO.gameOverLevel: the kick and bass pass the 300 Hz
 * filter and the compressor's automatic makeup gain lifts quiet material by ~8 dB, so without
 * this the "quiet" loop measured only ~3 dB (K-weighted) under gameplay.
 */
const GAMEOVER_TRIM = 0.45;
/**
 * Light duck under every drum / BOOM hit so the chain notes cut through the music: -3 dB
 * (x0.71), 50 ms hold, 0.15 s release time constant. Never deeper than that on its own, and
 * never on top of a bigger duck (see softDuck), so the music never sinks below the big-hit ducks.
 */
const HIT_DUCK = 0.29;
const HIT_DUCK_HOLD = 0.05;
const HIT_DUCK_RELEASE = 0.15;
/** Fade before suspending / after resuming (s). */
const SUSPEND_FADE = 0.03;
/** Sounds may be queued for this long (ms) after asking a suspended context to resume. */
const RESUME_GRACE_MS = 400;
/** Deferred (arpeggiated) voices may start at most this far in the future (s). */
const DEFER_MAX = 0.16;
/** Global voice caps: low-priority sounds are dropped above SOFT, everything above HARD. */
const SOFT_CAP = 22;
const HARD_CAP = 36;
const GLOBAL_SLOTS = 48;
/** Echo (slapback) settings. */
const ECHO_FEEDBACK = 0.26;
const ECHO_WET = 0.2;
const ECHO_TONE = 2400;

interface VoiceLimit {
  /** Max overlapping voices of this id. */
  max: number;
  /** Minimum spacing (s) between starts. */
  gap: number;
  /** Too soon: start it `gap` after the previous one (arpeggiate) instead of dropping it. */
  defer: boolean;
  /** Low priority: dropped first when many voices are active. */
  low: boolean;
  ends: number[];
  last: number;
}

function limit(max: number, gap: number, defer: boolean, low: boolean): VoiceLimit {
  const ends: number[] = [];
  for (let i = 0; i < max; i++) ends.push(0);
  return { max, gap, defer, low, ends, last: -1e9 };
}

function noop(): void {
  /* swallow */
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** True when the browser would let an AudioContext start now (no autoplay warning). */
function activationAllowsStart(): boolean {
  try {
    if (typeof navigator === 'undefined') return true;
    const ua = (navigator as unknown as { userActivation?: { isActive: boolean; hasBeenActive: boolean } })
      .userActivation;
    if (!ua) return true;
    return ua.isActive || ua.hasBeenActive;
  } catch (_e) {
    return true;
  }
}

/** Freeze a param at its current value at time t (cancelAndHoldAtTime where supported). */
function holdParam(p: AudioParam, t: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(t);
  } else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

/** Create the audio system. Does NOT create an AudioContext until unlock(). */
export function createAudio(): AudioApi {
  let ctx: AudioContext | null = null;
  let failed = false;
  let destroyed = false;
  let muted = false;
  let muteDoneAt = 0;
  let suppressed = false;
  let wantSuspended = false;
  let resumeAskedAt = -1e9;
  let stateRef: GameState | null = null;

  let master: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let musicFilter: BiquadFilterNode | null = null;
  let musicDuck: GainNode | null = null;
  let echoDelay: DelayNode | null = null;
  let synth: SynthEnv | null = null;
  let music: Music | null = null;
  let maxCut = AUDIO.filterOpen;

  let timer = 0;
  let suspendTimer = 0;
  let gestureArmed = false;

  // Mix automation memory (only re-automate on real changes).
  let lastCut = -1;
  let lastLevel = -1;
  let lastEcho = 0;

  // Music duck: depth (amount) of the latest duck and when its hold ends (ctx seconds).
  let duckDepth = 0;
  let duckHoldEnd = 0;

  // Beat clock.
  let beatAcc = 0;
  let lastAudioBeat = -1;

  const limits: { [K in SfxId]: VoiceLimit } = {
    footstep: limit(2, 0.045, false, true),
    jump: limit(2, 0.03, false, false),
    slamStart: limit(1, 0.05, false, false),
    slamImpact: limit(2, 0.05, false, false),
    boing: limit(2, 0.05, false, false),
    drum: limit(4, 0.02, false, false),
    drumBoom: limit(2, 0.03, false, false),
    stomp: limit(3, 0.03, false, false),
    mango: limit(4, 0.035, true, true),
    golden: limit(2, 0.06, true, false),
    melon: limit(3, 0.03, true, false),
    nearMiss: limit(2, 0.08, false, true),
    chainBank: limit(2, 0.05, false, false),
    shieldGet: limit(1, 0.1, false, false),
    shieldBreak: limit(1, 0.1, false, false),
    magnetGet: limit(1, 0.1, false, false),
    logWarn: limit(2, 0.15, false, false),
    feverStart: limit(1, 0.3, false, false),
    feverEnd: limit(1, 0.3, false, false),
    bestFlag: limit(1, 0.5, false, false),
    death: limit(1, 0.5, false, false),
    splorch: limit(2, 0.05, false, false),
    smash: limit(3, 0.035, true, false),
    land: limit(2, 0.06, false, true),
    click: limit(2, 0.03, false, true),
    countdown: limit(2, 0.1, false, false),
    go: limit(1, 0.1, false, false),
  };
  const gEnds: number[] = [];
  for (let i = 0; i < GLOBAL_SLOTS; i++) gEnds.push(0);

  const gestureOpts: AddEventListenerOptions = { capture: true, passive: true };

  /* ---------------- graph ---------------- */

  function masterTarget(): number {
    return muted || wantSuspended ? 0 : MASTER_LEVEL;
  }

  function buildGraph(c: AudioContext): void {
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = AUDIO.compThresholdDb;
    comp.ratio.value = AUDIO.compRatio;
    comp.knee.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const m = c.createGain();
    m.gain.value = masterTarget();
    comp.connect(m);
    m.connect(c.destination);

    const sfx = c.createGain();
    sfx.gain.value = AUDIO.sfxBus;
    sfx.connect(comp);

    const mb = c.createGain();
    mb.gain.value = AUDIO.musicBus;
    const mf = c.createBiquadFilter();
    mf.type = 'lowpass';
    maxCut = Math.min(AUDIO.filterOpen, c.sampleRate * 0.45);
    mf.frequency.value = Math.min(AUDIO.filterPlaying, maxCut);
    mf.Q.value = 0.9;
    const duck = c.createGain();
    duck.gain.value = 1;
    mb.connect(mf);
    mf.connect(duck);
    duck.connect(comp);

    let ml: AudioNode = mb;
    let mr: AudioNode = mb;
    if (typeof c.createStereoPanner === 'function') {
      const pl = c.createStereoPanner();
      pl.pan.value = -0.22;
      pl.connect(mb);
      const pr = c.createStereoPanner();
      pr.pan.value = 0.28;
      pr.connect(mb);
      ml = pl;
      mr = pr;
    }

    const echoIn = c.createGain();
    echoIn.gain.value = 1;
    const dl = c.createDelay(1);
    dl.delayTime.value = 15 / AUDIO.bpmBase;
    const tone = c.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = ECHO_TONE;
    tone.Q.value = 0.5;
    const fb = c.createGain();
    fb.gain.value = ECHO_FEEDBACK;
    const wet = c.createGain();
    wet.gain.value = ECHO_WET;
    echoIn.connect(dl);
    dl.connect(tone);
    tone.connect(fb);
    fb.connect(dl);
    tone.connect(wet);
    wet.connect(sfx);

    const sr = c.sampleRate;
    const len = Math.max(1, Math.floor(sr * AUDIO.noiseSeconds));
    const buf = c.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    const ns = { s: 0x2f6b1d3 };
    for (let i = 0; i < len; i++) data[i] = mulberry32Next(ns) * 2 - 1;

    master = m;
    musicBus = mb;
    musicFilter = mf;
    musicDuck = duck;
    echoDelay = dl;
    synth = {
      ctx: c,
      noise: buf,
      sfx,
      echo: echoIn,
      music: mb,
      musicL: ml,
      musicR: mr,
      rs: { s: 0x6a09e667 },
      foot: 0,
      chord: 0,
    };
    music = createMusic(synth);
    lastCut = -1;
    lastLevel = -1;
    lastEcho = dl.delayTime.value;
    duckDepth = 0;
    duckHoldEnd = 0;
  }

  /** iOS unlock idiom: start a 1-sample silent buffer inside the gesture. */
  function primeOutput(c: AudioContext): void {
    const b = c.createBuffer(1, 1, c.sampleRate);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.onended = onPrimeEnded;
    s.start(0);
  }

  function onPrimeEnded(this: AudioScheduledSourceNode): void {
    try {
      this.disconnect();
    } catch (_e) {
      /* closed */
    }
  }

  function create(): void {
    if (ctx || failed || destroyed) return;
    let c: AudioContext | null = null;
    try {
      if (typeof window === 'undefined') {
        failed = true;
        return;
      }
      const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const Ctor = w.AudioContext || w.webkitAudioContext;
      if (!Ctor) {
        failed = true;
        return;
      }
      try {
        c = new Ctor({ latencyHint: 'interactive' });
      } catch (_e) {
        c = new Ctor();
      }
      buildGraph(c);
      ctx = c;
      resumeAskedAt = nowMs();
      timer = window.setInterval(onTimer, AUDIO.tickMs);
      primeOutput(c);
    } catch (_e) {
      failed = true;
      ctx = null;
      synth = null;
      music = null;
      master = null;
      musicBus = null;
      musicFilter = null;
      musicDuck = null;
      echoDelay = null;
      if (timer) {
        window.clearInterval(timer);
        timer = 0;
      }
      if (c) {
        try {
          const p = c.close();
          if (p) p.catch(noop);
        } catch (_e2) {
          /* ignore */
        }
      }
    }
  }

  /* ---------------- lifecycle helpers ---------------- */

  function rampMaster(target: number, dur: number): void {
    if (!ctx || !master) return;
    const p = master.gain;
    const t = ctx.currentTime;
    holdParam(p, t);
    p.linearRampToValueAtTime(target, t + dur);
  }

  function onResumed(): void {
    if (ctx && ctx.state === 'running') disarmGesture();
  }

  function doResume(): void {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    resumeAskedAt = nowMs();
    const p = ctx.resume();
    if (p && typeof p.then === 'function') p.then(onResumed, noop);
  }

  function doSuspend(): void {
    suspendTimer = 0;
    if (!ctx || !wantSuspended || destroyed) return;
    try {
      if (ctx.state === 'running') {
        const p = ctx.suspend();
        if (p && typeof p.then === 'function') p.then(noop, noop);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  function clearSuspendTimer(): void {
    if (suspendTimer) {
      window.clearTimeout(suspendTimer);
      suspendTimer = 0;
    }
  }

  function armGesture(): void {
    if (gestureArmed || destroyed || typeof window === 'undefined') return;
    gestureArmed = true;
    window.addEventListener('pointerup', onLateGesture, gestureOpts);
    window.addEventListener('touchend', onLateGesture, gestureOpts);
    window.addEventListener('click', onLateGesture, gestureOpts);
    window.addEventListener('keydown', onLateGesture, gestureOpts);
  }

  function disarmGesture(): void {
    if (!gestureArmed || typeof window === 'undefined') return;
    gestureArmed = false;
    window.removeEventListener('pointerup', onLateGesture, true);
    window.removeEventListener('touchend', onLateGesture, true);
    window.removeEventListener('click', onLateGesture, true);
    window.removeEventListener('keydown', onLateGesture, true);
  }

  /** Shared by unlock() and the deferred listeners. Must run inside a user-gesture handler. */
  function gestureUnlock(): void {
    if (destroyed || failed) {
      disarmGesture();
      return;
    }
    if (!ctx) {
      if (!activationAllowsStart()) {
        armGesture();
        return;
      }
      create();
      if (!ctx) {
        disarmGesture();
        return;
      }
    }
    // While the game is paused the shell resumes audio itself when the pause ends.
    if (wantSuspended) {
      if (stateRef && stateRef.mode === 'paused') return;
      wantSuspended = false;
      clearSuspendTimer();
      rampMaster(masterTarget(), SUSPEND_FADE);
    }
    if (ctx.state === 'running') {
      disarmGesture();
      return;
    }
    // resume() settles asynchronously: keep a deferred listener until onResumed() sees 'running'.
    doResume();
    armGesture();
  }

  function onLateGesture(): void {
    try {
      gestureUnlock();
    } catch (_e) {
      /* never throw out of a handler */
    }
  }

  function onTimer(): void {
    if (!ctx || !music || destroyed) return;
    try {
      const now = ctx.currentTime;
      music.pump(now, muted && now >= muteDoneAt);
    } catch (_e) {
      /* keep the game running */
    }
  }

  /* ---------------- mix ---------------- */

  function applyMix(state: GameState, now: number): void {
    if (!musicFilter || !musicBus) return;
    const mode = state.mode;
    let cut = AUDIO.filterPlaying;
    let level = 1;
    let tau = 0.08;
    if (mode === 'title') {
      cut = TITLE_CUT;
      level = AUDIO.titleLevel;
    } else if (mode === 'paused') {
      cut = AUDIO.filterPaused;
      level = PAUSED_LEVEL;
      tau = 0.05;
    } else if (mode === 'dying' || mode === 'gameover') {
      cut = DEATH.musicFilterHz;
      level = AUDIO.gameOverLevel * GAMEOVER_TRIM;
      tau = 0.25;
    } else {
      const f = state.fever;
      if (f.active) {
        if (f.t < FEVER.warn) {
          // Warning: close from fully open to 1.2 kHz over the last 1.5 s (log-linear).
          const k = f.t > 0 ? f.t / FEVER.warn : 0;
          cut = AUDIO.filterFeverWarn * Math.pow(AUDIO.filterOpen / AUDIO.filterFeverWarn, k);
          tau = 0.05;
        } else {
          cut = AUDIO.filterOpen;
        }
      }
      const ts = state.timeScale;
      if (ts < 0.95) {
        let k = (ts - 0.15) / 0.8;
        if (k < 0) k = 0;
        if (k > 1) k = 1;
        const c2 = SLOWMO_CUT + (cut - SLOWMO_CUT) * k * Math.sqrt(k);
        if (c2 < cut) cut = c2;
        tau = 0.035;
      }
    }
    if (cut > maxCut) cut = maxCut;
    if (lastCut < 0 || Math.abs(cut - lastCut) > lastCut * 0.03) {
      musicFilter.frequency.setTargetAtTime(cut, now, tau);
      lastCut = cut;
    }
    if (Math.abs(level - lastLevel) > 0.005) {
      musicBus.gain.setTargetAtTime(AUDIO.musicBus * level, now, 0.15);
      lastLevel = level;
    }
    if (echoDelay && music) {
      const sd = music.stepDur();
      if (Math.abs(sd - lastEcho) > 0.002) {
        echoDelay.delayTime.setTargetAtTime(sd, now, 0.25);
        lastEcho = sd;
      }
    }
  }

  /** Briefly pull the music down under a big hit (sidechain-style). */
  function duck(amount: number, hold: number, release: number): void {
    if (!ctx || !musicDuck) return;
    const p = musicDuck.gain;
    const t = ctx.currentTime;
    holdParam(p, t);
    p.setTargetAtTime(1 - amount, t, 0.012);
    p.setTargetAtTime(1, t + hold, release);
    duckDepth = amount;
    duckHoldEnd = t + hold;
  }

  /**
   * Light duck (drum / BOOM hits). It only ever pulls the music down to 1 - amount, and leaves
   * the gain alone when a deeper duck is still holding or the music is still releasing from one
   * below that level, so it never stacks under (or cuts short) a big-hit duck. Back-to-back hits
   * re-arm the hold.
   */
  function softDuck(amount: number, hold: number, release: number): void {
    if (!ctx || !musicDuck) return;
    const t = ctx.currentTime;
    const holding = t < duckHoldEnd;
    if (holding && duckDepth > amount) return;
    const p = musicDuck.gain;
    const target = 1 - amount;
    if (!holding && p.value < target) return;
    holdParam(p, t);
    p.setTargetAtTime(target, t, 0.012);
    p.setTargetAtTime(1, t + hold, release);
    duckDepth = amount;
    duckHoldEnd = t + hold;
  }

  function duckFor(id: SfxId): void {
    switch (id) {
      case 'slamImpact':
        duck(0.45, 0.1, 0.16);
        break;
      case 'drum':
      case 'drumBoom':
        softDuck(HIT_DUCK, HIT_DUCK_HOLD, HIT_DUCK_RELEASE);
        break;
      case 'shieldBreak':
        duck(0.4, 0.1, 0.22);
        break;
      case 'death':
        duck(0.5, 0.35, 0.5);
        break;
      case 'feverStart':
        // Build-up and drop: the riser owns the mix, then every layer lands with the cymbal.
        duck(0.7, 0.44, 0.05);
        break;
      case 'bestFlag':
        duck(0.3, 0.45, 0.3);
        break;
      default:
        break;
    }
  }

  function activeVoices(t: number): number {
    let n = 0;
    for (let i = 0; i < GLOBAL_SLOTS; i++) if (gEnds[i] > t) n++;
    return n;
  }

  function registerVoice(t: number, end: number): void {
    let slot = 0;
    let minEnd = Infinity;
    for (let i = 0; i < GLOBAL_SLOTS; i++) {
      const e = gEnds[i];
      if (e <= t) {
        slot = i;
        break;
      }
      if (e < minEnd) {
        minEnd = e;
        slot = i;
      }
    }
    gEnds[slot] = end;
  }

  function outputLatency(c: AudioContext): number {
    const ol = (c as unknown as { outputLatency?: number }).outputLatency;
    if (typeof ol === 'number' && ol > 0 && ol < 0.5) return ol;
    const bl = (c as unknown as { baseLatency?: number }).baseLatency;
    if (typeof bl === 'number' && bl > 0 && bl < 0.5) return bl;
    return 0;
  }

  /* ---------------- API ---------------- */

  const api: AudioApi = {
    unlock(): void {
      try {
        gestureUnlock();
      } catch (_e) {
        /* silent game */
      }
    },

    play(id: SfxId, param?: number): void {
      if (muted || suppressed || destroyed || failed || !ctx || !synth) return;
      try {
        const c = ctx;
        if (c.state !== 'running') {
          // Only queue while a resume we asked for is in flight (never pile up on a stuck context).
          if (wantSuspended || c.state === 'closed' || nowMs() - resumeAskedAt > RESUME_GRACE_MS) return;
        }
        const now = c.currentTime;
        const L = limits[id];
        let t = now;
        if (now - L.last < L.gap) {
          if (!L.defer) return;
          t = L.last + L.gap;
          if (t - now > DEFER_MAX) return;
        }
        let slot = -1;
        for (let k = 0; k < L.max; k++) {
          if (L.ends[k] <= t) {
            slot = k;
            break;
          }
        }
        if (slot < 0) return;
        const active = activeVoices(t);
        if (active >= HARD_CAP || (L.low && active >= SOFT_CAP)) return;
        if (id === 'chainBank' && music) synth.chord = music.chordAt(t);
        const end = playSfx(synth, id, param === undefined ? 0 : param, t);
        if (end <= 0) return;
        L.ends[slot] = end;
        L.last = t;
        registerVoice(t, end);
        duckFor(id);
      } catch (_e) {
        /* a failed voice must never break the game */
      }
    },

    update(state: GameState, realDt: number): void {
      stateRef = state;
      const m = state.music;
      const mode = state.mode;
      const r = state.run;
      let bpm = AUDIO.titleBpm;
      if (mode !== 'title') {
        bpm = AUDIO.bpmBase + (AUDIO.bpmRange * (r.speed - SPEED.start)) / SPEED.gain;
        if (bpm < AUDIO.bpmBase) bpm = AUDIO.bpmBase;
        if (bpm > AUDIO.bpmBase + AUDIO.bpmRange) bpm = AUDIO.bpmBase + AUDIO.bpmRange;
      }
      if (ctx && music && !destroyed) {
        try {
          const c = ctx;
          music.setInputs(mode, r.time, r.chain, state.fever.active, state.seed, bpm);
          const now = c.currentTime;
          music.pump(now, muted && now >= muteDoneAt);
          applyMix(state, now);
          if (c.state === 'running' && music.sample(now - outputLatency(c))) {
            m.bpm = music.bpm;
            m.beatPhase = music.phase;
            const bi = music.beatIndex;
            if (lastAudioBeat >= 0 && bi > lastAudioBeat) m.beat += bi - lastAudioBeat > 4 ? 1 : bi - lastAudioBeat;
            lastAudioBeat = bi;
            beatAcc = music.phase;
            return;
          }
        } catch (_e) {
          /* fall through to the fallback clock */
        }
      }
      // Fallback beat clock (no / suspended context): real dt, frozen while paused.
      m.bpm = bpm;
      if (mode === 'paused') return;
      beatAcc += (realDt * bpm) / 60;
      while (beatAcc >= 1) {
        beatAcc -= 1;
        m.beat++;
      }
      m.beatPhase = beatAcc;
    },

    setMuted(mu: boolean): void {
      muted = mu;
      if (!ctx) return;
      try {
        rampMaster(masterTarget(), AUDIO.muteRamp);
        muteDoneAt = ctx.currentTime + AUDIO.muteRamp + 0.02;
      } catch (_e) {
        /* ignore */
      }
    },

    suspend(): void {
      wantSuspended = true;
      if (!ctx || destroyed) return;
      try {
        rampMaster(0, SUSPEND_FADE);
        clearSuspendTimer();
        suspendTimer = window.setTimeout(doSuspend, Math.ceil(SUSPEND_FADE * 1000) + 15);
      } catch (_e) {
        /* ignore */
      }
    },

    resume(): void {
      wantSuspended = false;
      if (!ctx || destroyed) return;
      try {
        clearSuspendTimer();
        doResume();
        rampMaster(masterTarget(), SUSPEND_FADE);
      } catch (_e) {
        /* ignore */
      }
    },

    setSuppressed(on: boolean): void {
      suppressed = on;
    },

    isAvailable(): boolean {
      return !!ctx && !failed && !destroyed && ctx.state !== 'closed';
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      disarmGesture();
      clearSuspendTimer();
      if (timer) {
        window.clearInterval(timer);
        timer = 0;
      }
      const c = ctx;
      ctx = null;
      synth = null;
      music = null;
      master = null;
      musicBus = null;
      musicFilter = null;
      musicDuck = null;
      echoDelay = null;
      stateRef = null;
      if (c) {
        try {
          const p = c.close();
          if (p && typeof p.then === 'function') p.then(noop, noop);
        } catch (_e) {
          /* ignore */
        }
      }
    },
  };
  return api;
}
