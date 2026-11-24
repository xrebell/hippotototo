/**
 * Look-ahead music scheduler (spec §11 "Music"). Private helper of audio.ts. Owner: AUDIO.
 *
 * Classic "two clocks" design: audio.ts calls pump(now) from a 25 ms setInterval AND once per
 * rendered frame; pump schedules every 16th-note step whose start falls inside
 * [now, now + 120 ms) on the AudioContext clock, so timing never depends on JS timer jitter.
 *
 * Arrangement (16-step bars, A minor pentatonic, chords Am–C–Dm–Em one bar each):
 *  - Tempo 112 + 16 * (v - 340) / 280 BPM (title: 96), only ever changed at a bar line.
 *  - L1 always: sine kick 120 -> 45 Hz on steps 0/8; 7 kHz shaker on the off-beats
 *    (plus soft 16th ghosts once L2 is in).
 *  - L2 after 15 s of run time (decided at bar lines): plucked triangle bass, root on 0/8,
 *    fifth on 6/14.
 *  - L3 while chain >= 2 (with a one-bar tail so it doesn't flicker between chains) or after
 *    60 s: marimba (sine + 3x partial at 15%, 250 ms) playing a per-bar SEEDED random walk on
 *    the scale, snapped to chord tones on steps 0/8, 30% rests. Bars repeat in 4-bar phrases
 *    (A A B B ...) so the tune is hummable. Seed = run seed (title: fixed).
 *  - L4 TOTOTO TIME only: claps (1.2 kHz bandpassed noise, 3-burst + tail) on 4/12 and an
 *    octave bass on every 8th; L2 + L3 are forced on (all layers).
 *  - Title: L1 + L3 softly at 96 BPM. Leaving the title cuts straight to a fresh bar.
 *  - dying / gameover: arrangement keeps looping (audio.ts closes the filter to 300 Hz).
 *
 * Bounce notes (SFX) are NOT quantised; they share the scale so they are always in key.
 *
 * The scheduler also records when each beat starts (ring of 8) so audio.ts can derive
 * state.music.beatPhase from the audio clock, and when each bar starts (chord for the chain bank).
 * pump()/sample() allocate nothing except the WebAudio nodes of the notes they start.
 */
import { AUDIO, CHORD_FIFTHS, CHORD_ROOTS, CHORD_TONES } from './config';
import { mulberry32Next } from './rng';
import { ladderSemitone } from './state';
import { env, filter, noise, osc, semiHz } from './audio-synth';
import type { SynthEnv } from './audio-synth';
import type { GameMode } from './types';

export interface Music {
  /** Tempo of the bar currently being scheduled. */
  bpm: number;
  /** Written by sample(): phase 0..1 inside the beat sounding at `now`, and that beat's index. */
  phase: number;
  beatIndex: number;
  /** Copy the game inputs the arrangement depends on (called once per frame, no allocation). */
  setInputs(mode: GameMode, runTime: number, chain: number, fever: boolean, seed: number, bpm: number): void;
  /** Schedule every step starting before now + look-ahead. `silent`: advance without voices (muted). */
  pump(now: number, silent: boolean): void;
  /** Beat clock at `now` -> phase / beatIndex. False until the first beat has started. */
  sample(now: number): boolean;
  /** Chord index (0..3) sounding at `now`. */
  chordAt(now: number): number;
  /** Seconds per 16th note at the current tempo (echo sync). */
  stepDur(): number;
}

const STEPS = 16;
const RING = 8;
/** Relative voice levels inside the music bus (bus = 0.32, then filter, duck, compressor). */
const LV_KICK = 0.72;
const LV_KICK_CLICK = 0.13;
const LV_SHAKER = 0.12;
const LV_BASS = 0.42;
const LV_MARIMBA = 0.3;
const LV_CLAP = 0.38;
/** Title "soft" multipliers. */
const SOFT_DRUMS = 0.6;
const SOFT_MARIMBA = 0.8;
/** Shaker velocities per 16th inside a beat (accent on the off-beat 8th). */
const SHAKER_VEL: ReadonlyArray<number> = [0.22, 0.16, 1, 0.3];
/** Marimba random-walk range on the ladder (index 6 = C4 ... 13 = E5). */
const WALK_LO = 6;
const WALK_HI = 13;
/** Fixed melody seed for the title screen. */
const TITLE_SEED = 0x51a7e;

/* ------------------------------------------------------------------ */
/* Voices (scheduled at an absolute audio time)                        */
/* ------------------------------------------------------------------ */

function kick(e: SynthEnv, t: number, lv: number): void {
  const g = env(e, e.music, false, t, 0.002, lv, t + 0.15, 0.012);
  osc(e, 'sine', 120, 45, 0.12, t, t + 0.15, g, g);
  // Beater click: lets the kick read on phone speakers that cannot reproduce 45-120 Hz.
  const gc = env(e, e.music, false, t, 0.0008, lv * LV_KICK_CLICK, t + 0.012);
  const bp = filter(e, 'bandpass', 2600, 2600, 0, 1.1, t, gc);
  noise(e, t, t + 0.012, bp, gc);
}

function shaker(e: SynthEnv, t: number, lv: number): void {
  const g = env(e, e.musicR, false, t, 0.004, lv, t + 0.05);
  const hp = filter(e, 'highpass', 7000, 7000, 0, 0.7, t, g);
  noise(e, t, t + 0.05, hp, g);
}

/** Plucked triangle bass: lowpass sweeps from bright to dark like a plucked string. */
function bass(e: SynthEnv, t: number, hz: number, dur: number, lv: number): void {
  const g = env(e, e.music, false, t, 0.004, lv, t + dur, 0.02);
  const lp = filter(e, 'lowpass', hz * 9, hz * 2.2, dur * 0.8, 2, t, g);
  osc(e, 'triangle', hz, hz, 0, t, t + dur, lp, g);
}

/** Marimba: sine + 3x partial at 15% (decays faster = mallet knock), 250 ms. */
function marimba(e: SynthEnv, t: number, hz: number, lv: number): void {
  const g = env(e, e.musicL, false, t, 0.0015, lv, t + 0.25);
  osc(e, 'sine', hz, hz, 0, t, t + 0.25, g, g);
  const g3 = env(e, e.musicL, false, t, 0.001, lv * 0.15, t + 0.07);
  osc(e, 'sine', hz * 3, hz * 3, 0, t, t + 0.07, g3, g3);
}

/** Hand clap: 1.2 kHz bandpassed noise, three 11 ms bursts then a short tail. */
function clap(e: SynthEnv, t: number, lv: number): void {
  const c = e.ctx;
  const g = c.createGain();
  const p = g.gain;
  p.value = 0;
  p.setValueAtTime(0, t);
  for (let k = 0; k < 3; k++) {
    const tk = t + k * 0.011;
    p.linearRampToValueAtTime(lv * (0.75 + 0.1 * k), tk + 0.001);
    p.exponentialRampToValueAtTime(lv * 0.12, tk + 0.0105);
  }
  const t3 = t + 0.033;
  p.linearRampToValueAtTime(lv, t3 + 0.001);
  p.exponentialRampToValueAtTime(lv * 0.001, t3 + 0.13);
  p.linearRampToValueAtTime(0, t3 + 0.134);
  g.connect(e.music);
  const bp = filter(e, 'bandpass', 1200, 1200, 0, 1.1, t, g);
  noise(e, t, t3 + 0.134, bp, g);
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

/** Small integer hash (melody seeding). */
function hash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Create the scheduler for one AudioContext. */
export function createMusic(e: SynthEnv): Music {
  // Inputs (copied from GameState once per frame).
  let ready = false;
  let inSoft = true;
  let inMode: GameMode = 'title';
  let inRunTime = 0;
  let inChain = 0;
  let inFever = false;
  let inSeed = TITLE_SEED;
  let inBpm = AUDIO.titleBpm;
  let forceBar = false;

  // Transport.
  let started = false;
  let nextT = 0;
  let step = 0;
  let bar = -1;
  let bpm = AUDIO.titleBpm;
  let stepS = 15 / bpm;
  let chord = 0;
  let beatCounter = 0;

  // Layers.
  let l2On = false;
  let l3On = false;
  let l3Hold = 0;
  let barSoft = true;
  let barSeed = TITLE_SEED;

  // Beat / bar rings (preallocated).
  const beatT: number[] = [];
  const beatDur: number[] = [];
  const beatIdx: number[] = [];
  for (let i = 0; i < RING; i++) {
    beatT.push(Infinity);
    beatDur.push(0.5);
    beatIdx.push(0);
  }
  let beatHead = 0;
  const barT: number[] = [Infinity, Infinity, Infinity, Infinity];
  const barChord: number[] = [0, 0, 0, 0];
  let barHead = 0;

  // Melody for the current bar: semitone above A2 per step, -1 = rest.
  const melody: number[] = [];
  for (let i = 0; i < STEPS; i++) melody.push(-1);
  const mrs = { s: 1 };

  function mr(): number {
    return mulberry32Next(mrs);
  }

  /** Nearest chord tone (any octave) to `semi`, as a semitone above A2. */
  function snapToChord(semi: number, ch: number): number {
    const tones = CHORD_TONES[ch];
    let best = semi;
    let bestD = 1e9;
    for (let oct = 0; oct <= 3; oct++) {
      for (let i = 0; i < tones.length; i++) {
        const s = tones[i] + oct * 12;
        const d = Math.abs(s - semi);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    return best;
  }

  /** Ladder index whose pitch is closest to `semi` inside the walk range. */
  function nearestLadder(semi: number): number {
    let best = WALK_LO;
    let bestD = 1e9;
    for (let i = WALK_LO; i <= WALK_HI; i++) {
      const d = Math.abs(ladderSemitone(i) - semi);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Seeded random walk for bar `b` (phrases: bars repeat as A A B B C C ... in 4-bar units). */
  function genMelody(b: number, ch: number, seed: number, soft: boolean): void {
    const phrase = Math.floor(b / 8);
    const inPhrase = b % 4;
    mrs.s = hash32(seed ^ Math.imul(phrase + 1, 0x9e3779b1) ^ Math.imul(inPhrase + 7, 0x85ebca77)) | 0;
    const restP = soft ? AUDIO.l3RestChance + 0.12 : AUDIO.l3RestChance;
    let pos = WALK_LO + 2 + Math.floor(mr() * 4);
    for (let s = 0; s < STEPS; s++) {
      melody[s] = -1;
      if (s & 1) {
        // Occasional 16th pickup into the strong beats (not in soft mode).
        if (!soft && (s === 7 || s === 15) && mr() < 0.22) {
          const p2 = pos + (mr() < 0.5 ? -1 : 1);
          melody[s] = ladderSemitone(p2 < WALK_LO ? WALK_LO : p2 > WALK_HI ? WALK_HI : p2);
        }
        continue;
      }
      if (s === 0 || s === 8) {
        const semi = snapToChord(ladderSemitone(pos), ch);
        melody[s] = semi;
        pos = nearestLadder(semi);
        continue;
      }
      if (mr() < restP) continue;
      const r = mr();
      const d = r < 0.36 ? -1 : r < 0.72 ? 1 : r < 0.86 ? -2 : 2;
      pos += d;
      if (pos < WALK_LO) pos = WALK_LO + (WALK_LO - pos);
      if (pos > WALK_HI) pos = WALK_HI - (pos - WALK_HI);
      melody[s] = ladderSemitone(pos);
    }
  }

  function barLine(t: number): void {
    bpm = inBpm;
    stepS = 15 / bpm;
    bar++;
    chord = ((bar % 4) + 4) % 4;
    barT[barHead] = t;
    barChord[barHead] = chord;
    barHead = (barHead + 1) % 4;
    barSoft = inSoft;
    barSeed = inSeed;
    l2On = !inSoft && (inRunTime >= AUDIO.l2After || inFever);
    genMelody(bar, chord, barSeed, barSoft);
  }

  function scheduleStep(s: number, t: number, silent: boolean): void {
    if (s === 0) barLine(t);
    if ((s & 3) === 0) {
      beatT[beatHead] = t;
      beatDur[beatHead] = stepS * 4;
      beatIdx[beatHead] = beatCounter++;
      beatHead = (beatHead + 1) % RING;
    }
    // L3 hysteresis: a chain keeps the marimba alive until one bar after it ends.
    if (inChain >= AUDIO.l3MinChain) l3Hold = STEPS;
    else if (l3Hold > 0) l3Hold--;
    if ((s & 3) === 0) {
      l3On = barSoft || inFever || l3Hold > 0 || inRunTime >= AUDIO.l3After;
    }
    if (silent) return;

    const soft = barSoft;
    const fever = inFever && !soft;
    const drumLv = soft ? SOFT_DRUMS : 1;

    // L1: kick + shaker.
    if (s === 0 || s === 8) kick(e, t, LV_KICK * drumLv);
    const sv = SHAKER_VEL[s & 3];
    if ((s & 3) === 2) shaker(e, t, LV_SHAKER * drumLv * (s === 6 || s === 14 ? 1.1 : 1));
    else if (l2On || fever) shaker(e, t, LV_SHAKER * sv);

    // L2 / L4 bass.
    const root = CHORD_ROOTS[chord];
    if (fever) {
      if ((s & 1) === 0) {
        const hi = (s & 2) !== 0;
        bass(e, t, semiHz(hi ? root : root - 12), stepS * 1.7, LV_BASS * (hi ? 0.8 : 1.05));
      }
    } else if (l2On) {
      if (s === 0 || s === 8) bass(e, t, semiHz(root), stepS * 3.2, LV_BASS);
      else if (s === 6 || s === 14) bass(e, t, semiHz(CHORD_FIFTHS[chord]), stepS * 1.6, LV_BASS * 0.8);
    }

    // L3 marimba.
    if (l3On) {
      const m = melody[s];
      if (m >= 0) {
        const accent = s === 0 || s === 8 ? 1 : (s & 1) !== 0 ? 0.6 : 0.8;
        marimba(e, t, semiHz(m), LV_MARIMBA * accent * (soft ? SOFT_MARIMBA : 1));
      }
    }

    // L4 claps.
    if (fever && (s === 4 || s === 12)) clap(e, t, LV_CLAP);
  }

  const music: Music = {
    bpm: AUDIO.titleBpm,
    phase: 0,
    beatIndex: 0,
    setInputs(mode: GameMode, runTime: number, chain: number, fever: boolean, seed: number, tempo: number): void {
      if (ready && inMode === 'title' && mode !== 'title') forceBar = true;
      ready = true;
      inMode = mode;
      inSoft = mode === 'title';
      inRunTime = runTime;
      inChain = chain;
      inFever = fever;
      inSeed = inSoft ? TITLE_SEED : seed | 0;
      inBpm = tempo;
    },
    pump(now: number, silent: boolean): void {
      if (!ready) return;
      if (!started) {
        started = true;
        nextT = now + 0.05;
        step = 0;
      } else if (nextT < now - 0.1) {
        // Fell behind (throttled timer, long hitch): skip the missed notes rather than burst them.
        nextT = now + 0.03;
      }
      if (forceBar) {
        // Title -> run: start a fresh bar at the run tempo on the next 16th.
        forceBar = false;
        step = 0;
      }
      const horizon = now + AUDIO.lookAhead;
      let guard = 0;
      while (nextT < horizon && guard < 32) {
        scheduleStep(step, nextT, silent);
        nextT += stepS;
        step = (step + 1) % STEPS;
        guard++;
      }
      music.bpm = bpm;
    },
    sample(now: number): boolean {
      let best = -1;
      let bestT = -Infinity;
      for (let i = 0; i < RING; i++) {
        const bt = beatT[i];
        if (bt <= now && bt > bestT) {
          bestT = bt;
          best = i;
        }
      }
      if (best < 0) return false;
      let ph = (now - bestT) / beatDur[best];
      if (ph < 0) ph = 0;
      if (ph > 0.999) ph = 0.999;
      music.phase = ph;
      music.beatIndex = beatIdx[best];
      return true;
    },
    chordAt(now: number): number {
      let best = -1;
      let bestT = -Infinity;
      for (let i = 0; i < 4; i++) {
        const bt = barT[i];
        if (bt <= now && bt > bestT) {
          bestT = bt;
          best = i;
        }
      }
      return best < 0 ? 0 : barChord[best];
    },
    stepDur(): number {
      return stepS;
    },
  };
  return music;
}
