/**
 * Audio voice primitives + every SFX recipe (spec §11 table). Private helper of audio.ts.
 * Owner: AUDIO. No DOM / AudioContext access at module top level (evaluated during SSR).
 *
 * Voice model: fire-and-forget partials. Each partial is
 *     source (oscillator | looping noise) -> [filter] -> envelope gain -> bus (+ optional echo send)
 * Envelopes always start at exactly 0, rise linearly (>= 0.8 ms), decay exponentially to -60 dB
 * and finish with a 4 ms linear tail to exactly 0 BEFORE the source stops, so nothing clicks.
 * When a source ends, one shared `onended` handler disconnects it and its envelope gain (no
 * per-voice closures), so finished voices leave the graph immediately.
 *
 * Every recipe takes an absolute start time `t` (AudioContext seconds) and returns the time at
 * which its last partial has fully decayed (audio.ts uses it for voice limiting).
 */
import { CHORD_FIFTHS, CHORD_ROOTS, NOTE_ROOT_HZ, SFX_GAIN, SFX_NOTES, SPEED } from './config';
import { mulberry32Next } from './rng';
import { ladderIndex, ladderSemitone } from './state';
import type { SfxId } from './types';

/** Everything a voice needs. Created once per AudioContext by audio.ts. */
export interface SynthEnv {
  ctx: BaseAudioContext;
  /** Shared 1 s white-noise buffer (looped, random start offset per voice). */
  noise: AudioBuffer;
  /** Dry SFX input (sfxBus). */
  sfx: AudioNode;
  /** Echo send (short tempo-synced slapback that feeds back into sfxBus). */
  echo: AudioNode;
  /** Music inputs: centre / slightly left / slightly right (all = musicBus without StereoPanner). */
  music: AudioNode;
  musicL: AudioNode;
  musicR: AudioNode;
  /** Variation PRNG state (mulberry32; audio never touches Math.random or the game streams). */
  rs: { s: number };
  /** Alternating left/right footstep flag. */
  foot: number;
  /** Chord index 0..3 (Am C Dm Em) sounding now; audio.ts sets it before a chain bank. */
  chord: number;
}

/** Linear tail (s) appended after the exponential decay so the envelope ends at exactly 0. */
const TAIL = 0.004;
/** Extra time (s) before a source is stopped after its envelope reached 0. */
const STOP_PAD = 0.012;

/**
 * Loudness trims on top of config SFX_GAIN, balanced by rendering every recipe offline and
 * measuring K-weighted loudness: filtered noise loses most of its energy in narrow bandpasses,
 * and the chain notes (the signature sound) must sit above the music, so those get lifted; the
 * long climactic sounds are pulled down a touch so they never dominate.
 */
const TRIM = {
  footstep: 4.2,
  jump: 1.15,
  drum: 1.55,
  stomp: 1.35,
  mango: 1.4,
  melon: 2,
  nearMiss: 3.6,
  smash: 1.8,
  splorch: 1.6,
  shieldBreak: 1.5,
  land: 1.5,
  click: 2,
  death: 0.75,
  bestFlag: 0.8,
};

/* ------------------------------------------------------------------ */
/* Pitch helpers                                                       */
/* ------------------------------------------------------------------ */

/** Frequency (Hz) of a semitone offset from A2 (110 Hz). */
export function semiHz(semi: number): number {
  return NOTE_ROOT_HZ * Math.pow(2, semi / 12);
}

/**
 * Chain step note (spec §6.1): A-minor pentatonic ladder A2 C3 D3 E3 G3, up an octave every 5
 * steps, capped at 3 octaves (beyond the top it keeps cycling the top octave). `chain` is the
 * chain value AFTER the bounce (1 = A2).
 */
export function chainNoteHz(chain: number): number {
  return semiHz(ladderSemitone(ladderIndex(chain)));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Variation random in [0, 1). */
export function rnd(e: SynthEnv): number {
  return mulberry32Next(e.rs);
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

interface TailSource extends AudioScheduledSourceNode {
  hrTail?: AudioNode | null;
}

/** Shared `onended`: disconnect the finished source and the voice node it was carrying. */
function onSourceEnded(this: AudioScheduledSourceNode): void {
  const s = this as TailSource;
  try {
    s.disconnect();
    if (s.hrTail) {
      s.hrTail.disconnect();
      s.hrTail = null;
    }
  } catch (_e) {
    /* already disconnected (context closed) */
  }
}

/** Start `src` at t, stop it at `stopAt`, and drop `tail` from the graph when it ends. */
function launch(src: AudioScheduledSourceNode, tail: AudioNode | null, t: number, stopAt: number): void {
  src.onended = onSourceEnded;
  (src as TailSource).hrTail = tail;
  src.start(t);
  src.stop(stopAt);
}

/**
 * Percussive envelope gain wired to `dest` (+ echo send): 0 -> `peak` over `a` s (linear),
 * optional `hold` at peak, exponential decay to -60 dB at `end`, linear tail to exactly 0.
 */
export function env(
  e: SynthEnv,
  dest: AudioNode,
  echo: boolean,
  t: number,
  a: number,
  peak: number,
  end: number,
  hold?: number,
): GainNode {
  const g = e.ctx.createGain();
  const p = g.gain;
  const pk = peak > 0.0001 ? peak : 0.0001;
  const h = hold && hold > 0 ? hold : 0;
  let decayEnd = end;
  if (decayEnd < t + a + h + 0.005) decayEnd = t + a + h + 0.005;
  p.value = 0;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, t + a);
  if (h > 0) p.setValueAtTime(pk, t + a + h);
  p.exponentialRampToValueAtTime(pk * 0.001, decayEnd);
  p.linearRampToValueAtTime(0, decayEnd + TAIL);
  g.connect(dest);
  if (echo) g.connect(e.echo);
  return g;
}

/** Oscillator (optional exponential glide f0 -> f1 over `glide` s) into `into`; stops after `end`. */
export function osc(
  e: SynthEnv,
  type: OscillatorType,
  f0: number,
  f1: number,
  glide: number,
  t: number,
  end: number,
  into: AudioNode,
  tail: AudioNode | null,
): OscillatorNode {
  const o = e.ctx.createOscillator();
  o.type = type;
  const fr = o.frequency;
  fr.value = f0;
  fr.setValueAtTime(f0, t);
  if (glide > 0 && f1 !== f0 && f1 > 0) fr.exponentialRampToValueAtTime(f1, t + glide);
  o.connect(into);
  launch(o, tail, t, end + TAIL + STOP_PAD);
  return o;
}

/** Looping white-noise source (random start offset) into `into`; stops after `end`. */
export function noise(e: SynthEnv, t: number, end: number, into: AudioNode, tail: AudioNode | null): AudioBufferSourceNode {
  const s = e.ctx.createBufferSource();
  s.buffer = e.noise;
  s.loop = true;
  s.connect(into);
  s.onended = onSourceEnded;
  (s as TailSource).hrTail = tail;
  s.start(t, rnd(e) * (e.noise.duration * 0.9));
  s.stop(end + TAIL + STOP_PAD);
  return s;
}

/** Biquad filter (optional exponential cutoff sweep f0 -> f1 over `sweep` s) wired into `into`. */
export function filter(
  e: SynthEnv,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  sweep: number,
  q: number,
  t: number,
  into: AudioNode,
): BiquadFilterNode {
  const f = e.ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  // Stay below Nyquist even on low-rate devices (out-of-range values log a console warning).
  const ny = e.ctx.sampleRate * 0.45;
  const a = f0 < ny ? f0 : ny;
  const b = f1 < ny ? f1 : ny;
  const fr = f.frequency;
  fr.value = a;
  fr.setValueAtTime(a, t);
  if (sweep > 0 && b !== a && b > 0) fr.exponentialRampToValueAtTime(b, t + sweep);
  f.connect(into);
  return f;
}

/** Sine LFO (rate Hz, depth in the target's units) added to `target` between t and end. */
export function lfo(e: SynthEnv, rate: number, depth: number, t: number, end: number, target: AudioParam): GainNode {
  const c = e.ctx;
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.value = rate;
  const d = c.createGain();
  d.gain.value = depth;
  o.connect(d);
  d.connect(target);
  launch(o, d, t, end + STOP_PAD);
  return d;
}

/** Filtered noise burst: noise -> filter (sweep) -> percussive envelope -> dest. */
function noiseHit(
  e: SynthEnv,
  dest: AudioNode,
  echo: boolean,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  q: number,
  t: number,
  a: number,
  peak: number,
  end: number,
): void {
  const g = env(e, dest, echo, t, a, peak, end);
  const f = filter(e, type, f0, f1, end - t, q, t, g);
  noise(e, t, end, f, g);
}

/** Pitched partial: oscillator (glide) -> percussive envelope -> dest. */
function blip(
  e: SynthEnv,
  dest: AudioNode,
  echo: boolean,
  type: OscillatorType,
  f0: number,
  f1: number,
  glide: number,
  t: number,
  a: number,
  peak: number,
  end: number,
  hold?: number,
): OscillatorNode {
  const g = env(e, dest, echo, t, a, peak, end, hold);
  return osc(e, type, f0, f1, glide, t, end, g, g);
}

/* ------------------------------------------------------------------ */
/* SFX recipes                                                         */
/* ------------------------------------------------------------------ */

/** Footstep "to": bandpassed noise 2.4 kHz, 25 ms, pitch x1..1.5 with speed, + a soft woody tok. */
function sfxFootstep(e: SynthEnv, t: number, speed: number): number {
  e.foot = e.foot ? 0 : 1;
  const k = (1 + 0.5 * clamp01((speed - SPEED.start) / SPEED.gain)) * (e.foot ? 1 : 0.93) * (0.98 + rnd(e) * 0.04);
  const end = t + 0.025;
  const lv = SFX_GAIN.footstep * TRIM.footstep;
  noiseHit(e, e.sfx, false, 'bandpass', 2400 * k, 2000 * k, 2.2, t, 0.0015, lv, end);
  blip(e, e.sfx, false, 'sine', 330 * k, 210 * k, 0.025, t, 0.001, lv * 0.5, t + 0.03);
  return t + 0.035;
}

/** Jump: triangle 220 -> 440 Hz in 90 ms (+ quiet octave sine for sparkle), slight detune. */
function sfxJump(e: SynthEnv, t: number): number {
  const d = 0.97 + rnd(e) * 0.06;
  const end = t + 0.11;
  const g = SFX_GAIN.jump * TRIM.jump;
  blip(e, e.sfx, false, 'triangle', 220 * d, 440 * d, 0.09, t, 0.004, g, end, 0.035);
  blip(e, e.sfx, false, 'sine', 440 * d, 880 * d, 0.09, t, 0.004, g * 0.22, t + 0.08);
  return end;
}

/** Slam start: sine whistle 400 -> 900 Hz over 50 ms + highpassed falling noise whoosh 120 ms. */
function sfxSlamStart(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.slamStart;
  blip(e, e.sfx, false, 'sine', 400, 900, 0.05, t, 0.003, g * 0.7, t + 0.075, 0.03);
  const tw = t + 0.035;
  noiseHit(e, e.sfx, false, 'highpass', 2600, 700, 0.9, tw, 0.05, g * 0.9, tw + 0.12);
  return tw + 0.13;
}

/** Slam impact: sine 90 -> 38 Hz 200 ms + lowpassed (800 Hz) noise burst 100 ms + small-speaker body. */
function sfxSlamImpact(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.slamImpact;
  blip(e, e.sfx, false, 'sine', 90, 38, 0.2, t, 0.002, g, t + 0.22, 0.02);
  blip(e, e.sfx, false, 'triangle', 190, 65, 0.08, t, 0.001, g * 0.45, t + 0.1);
  noiseHit(e, e.sfx, false, 'lowpass', 800, 500, 0.8, t, 0.001, g * 0.75, t + 0.1);
  return t + 0.23;
}

/** Boing: sine 300 -> 700 Hz, 18 Hz vibrato (depth easing out), 300 ms; triangle body; echo. */
function sfxBoing(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.boing;
  const end = t + 0.3;
  const o = blip(e, e.sfx, true, 'sine', 300, 700, 0.22, t, 0.004, g, end, 0.07);
  const o2 = blip(e, e.sfx, false, 'triangle', 300, 700, 0.22, t, 0.004, g * 0.3, t + 0.2);
  const v = lfo(e, 18, 34, t, end, o.frequency);
  v.gain.setValueAtTime(34, t);
  v.gain.linearRampToValueAtTime(12, end);
  o2.detune.value = 6;
  return end + 0.01;
}

/**
 * Drum bounce at the chain note: sine with pitch drop x1.5 -> x1 in 40 ms, 260 ms decay, a
 * brighter octave strike partial and a 15 ms noise tick. BOOM adds a sub-octave sine, the
 * previous ladder step underneath (it counted 2 steps) and a low thump, plus two layers that
 * survive phone speakers (which reproduce almost nothing below ~300 Hz, i.e. none of the sub):
 * a fixed 220 -> 180 Hz body knock (90 ms, half the sub's level) and a 25 ms band-passed noise
 * "skin slap" at 1.8 kHz. Together they add one oscillator and one noise source per BOOM.
 */
function sfxDrum(e: SynthEnv, t: number, chain: number, boom: boolean): number {
  const c = chain < 1 ? 1 : chain;
  const hz = chainNoteHz(c);
  const idx = ladderIndex(c);
  // Equal-loudness-ish compensation: the top of the ladder would otherwise poke out.
  const lv = SFX_GAIN.drum * TRIM.drum * (1 - 0.32 * (idx / 14)) * (boom ? 1.05 : 1);
  let end = t + 0.26;
  blip(e, e.sfx, true, 'sine', hz * 1.5, hz, 0.04, t, 0.0015, lv, end);
  blip(e, e.sfx, false, 'triangle', hz * 3, hz * 2, 0.04, t, 0.001, lv * 0.3, t + 0.12);
  noiseHit(e, e.sfx, false, 'bandpass', 3400, 2600, 1.2, t, 0.0008, lv * 0.32, t + 0.015);
  if (boom) {
    const sub = hz * 0.5;
    const subLv = lv * 0.85;
    end = t + 0.42;
    blip(e, e.sfx, false, 'sine', sub * 1.5, sub, 0.06, t, 0.002, subLv, end, 0.03);
    // Body knock: the weight of the BOOM on a small speaker.
    blip(e, e.sfx, false, 'sine', 220, 180, 0.08, t, 0.0015, subLv * 0.5, t + 0.09);
    // Skin slap: a short mid-band smack (BOOM's attack on a phone, under the 3.4 kHz tick).
    noiseHit(e, e.sfx, false, 'bandpass', 1800, 1800, 1.4, t, 0.0008, lv * 0.25, t + 0.025);
    const lower = chainNoteHz(c - 1);
    blip(e, e.sfx, true, 'sine', lower * 1.5, lower, 0.04, t, 0.002, lv * 0.45, t + 0.3);
    noiseHit(e, e.sfx, false, 'lowpass', 420, 260, 0.8, t, 0.001, lv * 0.7, t + 0.09);
  }
  return end + 0.01;
}

/** Stomp: in-key squeak (chain note moved into ~600 Hz) rising an octave in 70 ms + thump 120 -> 60 Hz. */
function sfxStomp(e: SynthEnv, t: number, chain: number): number {
  const g = SFX_GAIN.stomp * TRIM.stomp;
  const c = chain < 1 ? 1 : chain;
  let f = chainNoteHz(c);
  while (f < 520) f *= 2;
  while (f >= 1040) f *= 0.5;
  blip(e, e.sfx, true, 'sine', f, f * 2, 0.07, t, 0.003, g * 0.55, t + 0.085, 0.03);
  blip(e, e.sfx, false, 'sine', 120, 60, 0.11, t, 0.0015, g, t + 0.13);
  blip(e, e.sfx, false, 'triangle', 240, 110, 0.05, t, 0.001, g * 0.25, t + 0.06);
  const hz = chainNoteHz(c);
  blip(e, e.sfx, true, 'sine', hz * 1.5, hz, 0.04, t + 0.01, 0.002, SFX_GAIN.drum * TRIM.drum * 0.4, t + 0.22);
  return t + 0.24;
}

/** Mango: square through a 2.5 kHz lowpass, 60 ms, A5 pentatonic step rising with the quick streak. */
function sfxMango(e: SynthEnv, t: number, streak: number): number {
  const s = streak < 0 ? 0 : Math.floor(streak);
  const idx = s < 10 ? s : 5 + ((s - 10) % 5);
  const f = SFX_NOTES.mangoBase * Math.pow(2, ladderSemitone(idx) / 12);
  const lv = SFX_GAIN.mango * TRIM.mango * (1 - idx * 0.02);
  const end = t + 0.06;
  const g = env(e, e.sfx, false, t, 0.0015, lv, end, 0.012);
  const lp = filter(e, 'lowpass', 2500, 2500, 0, 0.6, t, g);
  osc(e, 'square', f, f, 0, t, end, lp, g);
  blip(e, e.sfx, false, 'sine', f, f, 0, t, 0.0015, lv * 0.5, t + 0.09);
  return t + 0.095;
}

/** Golden mango: triangle arpeggio E5 A5 E6, 70 ms apart, with a shimmer octave and a sparkle. */
function sfxGolden(e: SynthEnv, t: number): number {
  const notes = SFX_NOTES.golden;
  const g = SFX_GAIN.golden;
  let last = t;
  for (let i = 0; i < notes.length; i++) {
    const ti = t + i * SFX_NOTES.goldenStep;
    const top = i === notes.length - 1;
    const end = ti + (top ? 0.5 : 0.17);
    blip(e, e.sfx, true, 'triangle', notes[i], notes[i], 0, ti, 0.003, g, end, top ? 0.04 : 0.02);
    blip(e, e.sfx, false, 'sine', notes[i] * 2, notes[i] * 2, 0, ti, 0.002, g * 0.22, ti + 0.12);
    if (end > last) last = end;
  }
  const ts = t + SFX_NOTES.goldenStep * 2;
  noiseHit(e, e.sfx, false, 'highpass', 8000, 9500, 0.7, ts, 0.01, g * 0.18, ts + 0.3);
  return last + 0.01;
}

/** Melon smash: bandpass noise sweep 1.5 kHz -> 400 Hz 150 ms + sine pop 160 -> 80 Hz. */
function sfxMelon(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.melon * TRIM.melon;
  noiseHit(e, e.sfx, false, 'bandpass', 1500, 400, 2.4, t, 0.003, g, t + 0.15);
  blip(e, e.sfx, false, 'sine', 160, 80, 0.08, t, 0.002, g * 0.85, t + 0.11);
  return t + 0.16;
}

/** Near miss: bandpass noise sweep 3 kHz -> 600 Hz over 180 ms (a quick whoosh). */
function sfxNearMiss(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.nearMiss * TRIM.nearMiss;
  noiseHit(e, e.sfx, false, 'bandpass', 3000, 600, 2, t, 0.03, g, t + 0.18);
  blip(e, e.sfx, false, 'sine', 2637, 2637, 0, t + 0.02, 0.002, g * 0.06, t + 0.12);
  return t + 0.19;
}

/** Chain bank "ta-da": root then fifth of the current chord (triangle), volume scaled by the chain. */
function sfxChainBank(e: SynthEnv, t: number, chain: number): number {
  const ch = e.chord & 3;
  const k = clamp01((chain - 2) / 10);
  const lv = SFX_GAIN.chainBank * (0.45 + 0.55 * k);
  const root = semiHz(CHORD_ROOTS[ch] + 24);
  const fifth = semiHz(CHORD_FIFTHS[ch] + 24);
  blip(e, e.sfx, true, 'triangle', root, root, 0, t, 0.003, lv, t + 0.13, 0.03);
  const t2 = t + 0.1;
  const end = t2 + 0.38 + 0.25 * k;
  const o = blip(e, e.sfx, true, 'triangle', fifth, fifth, 0, t2, 0.004, lv * 1.05, end, 0.06);
  blip(e, e.sfx, false, 'triangle', root, root, 0, t2, 0.004, lv * 0.5, end - 0.08, 0.04);
  blip(e, e.sfx, false, 'sine', fifth * 2, fifth * 2, 0, t2, 0.003, lv * 0.18, t2 + 0.2);
  if (k > 0.3) lfo(e, 6, fifth * 0.006 * k, t2 + 0.12, end, o.frequency);
  return end + 0.01;
}

/** Mud Coat get: rising noise swell + two-note chime (E6, A6). */
function sfxShieldGet(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.shield;
  noiseHit(e, e.sfx, false, 'bandpass', 380, 3200, 1.6, t, 0.2, g * 0.55, t + 0.27);
  blip(e, e.sfx, false, 'sine', 140, 260, 0.2, t, 0.02, g * 0.35, t + 0.22);
  const tc = t + 0.2;
  blip(e, e.sfx, true, 'sine', 1318.51, 1318.51, 0, tc, 0.002, g * 0.55, tc + 0.45);
  blip(e, e.sfx, false, 'sine', 1318.51 * 2.76, 1318.51 * 2.76, 0, tc, 0.001, g * 0.1, tc + 0.12);
  const td = tc + 0.08;
  blip(e, e.sfx, true, 'sine', 1760, 1760, 0, td, 0.002, g * 0.5, td + 0.55);
  blip(e, e.sfx, false, 'sine', 1760 * 2.76, 1760 * 2.76, 0, td, 0.001, g * 0.08, td + 0.12);
  return td + 0.56;
}

/** Mud Coat break: crunchy (amplitude-chopped) noise + square 200 -> 80 Hz through a lowpass. */
function sfxShieldBreak(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.shield * TRIM.shieldBreak;
  const end = t + 0.22;
  const out = env(e, e.sfx, false, t, 0.002, g * 0.9, end);
  const chop = e.ctx.createGain();
  chop.gain.value = 0.55;
  chop.connect(out);
  lfo(e, 38, 0.45, t, end, chop.gain);
  const bp = filter(e, 'bandpass', 1300, 500, 0.2, 0.9, t, chop);
  noise(e, t, end, bp, out);
  const sg = env(e, e.sfx, false, t, 0.002, g * 0.55, t + 0.24, 0.03);
  const lp = filter(e, 'lowpass', 1600, 700, 0.2, 1, t, sg);
  osc(e, 'square', 200, 80, 0.2, t, t + 0.24, lp, sg);
  blip(e, e.sfx, false, 'sine', 110, 50, 0.15, t, 0.002, g * 0.6, t + 0.18);
  return t + 0.25;
}

/** Fruit Magnet: wobbly rising triangle zip + a bright two-note ping. */
function sfxMagnet(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.shield;
  const o = blip(e, e.sfx, false, 'triangle', 440, 880, 0.18, t, 0.004, g * 0.7, t + 0.24, 0.08);
  lfo(e, 14, 22, t, t + 0.24, o.frequency);
  const tp = t + 0.16;
  blip(e, e.sfx, true, 'sine', 1174.66, 1174.66, 0, tp, 0.002, g * 0.45, tp + 0.3);
  blip(e, e.sfx, true, 'sine', 1760, 1760, 0, tp + 0.07, 0.002, g * 0.4, tp + 0.4);
  return tp + 0.42;
}

/** Log warning: 45 Hz sine rumble 0.6 s (crescendo, rolling tremolo) + audible harmonic and grit. */
function sfxLogWarn(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.logWarn;
  const end = t + 0.6;
  const roll = e.ctx.createGain();
  roll.gain.value = 0.7;
  const out = e.ctx.createGain();
  const p = out.gain;
  p.value = 0;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(g * 0.35, t + 0.05);
  p.linearRampToValueAtTime(g, t + 0.48);
  p.linearRampToValueAtTime(0, end);
  roll.connect(out);
  out.connect(e.sfx);
  lfo(e, 9, 0.3, t, end, roll.gain);
  osc(e, 'sine', 45, 45, 0, t, end, roll, null);
  const hg = e.ctx.createGain();
  hg.gain.value = 0.3;
  hg.connect(roll);
  osc(e, 'triangle', 90, 90, 0, t, end, hg, null);
  const ng = e.ctx.createGain();
  ng.gain.value = 0.9;
  ng.connect(roll);
  const lp = filter(e, 'lowpass', 160, 260, 0.6, 0.7, t, ng);
  noise(e, t, end, lp, out);
  return end + 0.01;
}

/** TOTOTO TIME start: detuned saw riser through an opening lowpass (0.5 s), then noise cymbal + stab. */
function sfxFeverStart(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.fever;
  const rise = 0.5;
  const out = e.ctx.createGain();
  const p = out.gain;
  p.value = 0;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(g * 0.55, t + rise - 0.04);
  p.linearRampToValueAtTime(0, t + rise + 0.03);
  out.connect(e.sfx);
  const lp = filter(e, 'lowpass', 350, 7000, rise, 3.5, t, out);
  const o1 = osc(e, 'sawtooth', 220, 880, rise, t, t + rise + 0.03, lp, out);
  const o2 = osc(e, 'sawtooth', 220, 880, rise, t, t + rise + 0.03, lp, null);
  o1.detune.value = -9;
  o2.detune.value = 9;
  const tc = t + rise;
  noiseHit(e, e.sfx, false, 'highpass', 6500, 5200, 0.7, tc, 0.002, g * 0.65, tc + 0.9);
  blip(e, e.sfx, true, 'triangle', 440, 440, 0, tc, 0.003, g * 0.4, tc + 0.4, 0.05);
  blip(e, e.sfx, true, 'triangle', 659.25, 659.25, 0, tc, 0.003, g * 0.32, tc + 0.4, 0.05);
  blip(e, e.sfx, true, 'triangle', 880, 880, 0, tc, 0.003, g * 0.3, tc + 0.45, 0.05);
  blip(e, e.sfx, false, 'sine', 110, 55, 0.12, tc, 0.002, g * 0.8, tc + 0.25);
  return tc + 0.91;
}

/** TOTOTO TIME end: resonant falling filter over a saw dyad (A3 + E4) + a descending swish. */
function sfxFeverEnd(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.fever;
  const end = t + 0.55;
  const out = env(e, e.sfx, false, t, 0.01, g * 0.55, end, 0.15);
  const lp = filter(e, 'lowpass', 3200, 180, 0.5, 5, t, out);
  osc(e, 'sawtooth', 220, 207, 0.5, t, end, lp, out);
  osc(e, 'sawtooth', 329.63, 311, 0.5, t, end, lp, null);
  noiseHit(e, e.sfx, false, 'lowpass', 4000, 300, 0.8, t, 0.02, g * 0.3, t + 0.45);
  return end + 0.01;
}

/** Best flag: 5-note fanfare A4 C5 E5 A5 C6 (triangle + soft square), last note held with vibrato. */
function sfxBestFlag(e: SynthEnv, t: number): number {
  const notes = SFX_NOTES.bestFlag;
  const g = SFX_GAIN.bestFlag * TRIM.bestFlag;
  let last = t;
  for (let i = 0; i < notes.length; i++) {
    const top = i === notes.length - 1;
    const ti = t + i * 0.095 + (top ? 0.03 : 0);
    const end = ti + (top ? 0.7 : 0.13);
    const f = notes[i];
    const o = blip(e, e.sfx, true, 'triangle', f, f, 0, ti, 0.004, g, end, top ? 0.12 : 0.04);
    const sg = env(e, e.sfx, false, ti, 0.006, g * 0.22, end - 0.02, top ? 0.1 : 0.03);
    const lp = filter(e, 'lowpass', 2200, 2200, 0, 0.7, ti, sg);
    const sq = osc(e, 'square', f, f, 0, ti, end, lp, sg);
    if (top) {
      const v = lfo(e, 6, 0, ti, end, o.frequency);
      v.gain.setValueAtTime(0, ti + 0.12);
      v.gain.linearRampToValueAtTime(f * 0.012, ti + 0.45);
      const v2 = lfo(e, 6, 0, ti, end, sq.frequency);
      v2.gain.setValueAtTime(0, ti + 0.12);
      v2.gain.linearRampToValueAtTime(f * 0.012, ti + 0.45);
    }
    if (end > last) last = end;
  }
  const ts = t + 4 * 0.095 + 0.03;
  noiseHit(e, e.sfx, false, 'highpass', 7000, 8000, 0.7, ts, 0.004, g * 0.3, ts + 0.6);
  return last + 0.01;
}

/** Death "wah-wah": triangle + saw steps 392, 370, 349, 330 Hz through a wah lowpass, vibrato on the last. */
function sfxDeath(e: SynthEnv, t: number): number {
  const notes = SFX_NOTES.death;
  const g = SFX_GAIN.death * TRIM.death;
  const step = 0.3;
  const n = notes.length;
  const lastStart = t + step * (n - 1);
  const end = lastStart + 0.85;
  const out = e.ctx.createGain();
  const p = out.gain;
  p.value = 0;
  p.setValueAtTime(0, t);
  const lp = e.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 5;
  const fq = lp.frequency;
  fq.value = 350;
  fq.setValueAtTime(350, t);
  for (let i = 0; i < n; i++) {
    const ti = t + step * i;
    const last = i === n - 1;
    // Re-articulated note: quick swell, sag, dip before the next one (each note = one "wah").
    p.linearRampToValueAtTime(g, ti + 0.035);
    fq.linearRampToValueAtTime(1900, ti + 0.07);
    if (!last) {
      p.linearRampToValueAtTime(g * 0.6, ti + step - 0.05);
      p.linearRampToValueAtTime(g * 0.12, ti + step - 0.005);
      fq.linearRampToValueAtTime(520, ti + step - 0.01);
    } else {
      p.setValueAtTime(g, ti + 0.3);
      p.exponentialRampToValueAtTime(g * 0.001, end);
      p.linearRampToValueAtTime(0, end + TAIL);
      fq.setValueAtTime(1900, ti + 0.3);
      fq.exponentialRampToValueAtTime(300, end);
    }
  }
  lp.connect(out);
  out.connect(e.sfx);
  const tri = e.ctx.createOscillator();
  tri.type = 'triangle';
  const saw = e.ctx.createOscillator();
  saw.type = 'sawtooth';
  const sawG = e.ctx.createGain();
  sawG.gain.value = 0.32;
  saw.connect(sawG);
  sawG.connect(lp);
  tri.connect(lp);
  for (let i = 0; i < n; i++) {
    const ti = t + step * i;
    const f = notes[i];
    if (i === 0) {
      tri.frequency.setValueAtTime(f, t);
      saw.frequency.setValueAtTime(f, t);
    } else {
      // Little trombone slide into each note.
      tri.frequency.setValueAtTime(notes[i - 1], ti - 0.03);
      tri.frequency.exponentialRampToValueAtTime(f, ti + 0.02);
      saw.frequency.setValueAtTime(notes[i - 1], ti - 0.03);
      saw.frequency.exponentialRampToValueAtTime(f, ti + 0.02);
    }
  }
  const vib = lfo(e, 5.5, 0, t, end, tri.frequency);
  vib.gain.setValueAtTime(0, lastStart + 0.1);
  vib.gain.linearRampToValueAtTime(11, lastStart + 0.6);
  const vib2 = lfo(e, 5.5, 0, t, end, saw.frequency);
  vib2.gain.setValueAtTime(0, lastStart + 0.1);
  vib2.gain.linearRampToValueAtTime(11, lastStart + 0.6);
  launch(tri, out, t, end + TAIL + STOP_PAD);
  launch(saw, null, t, end + TAIL + STOP_PAD);
  return end + 0.02;
}

/** Splorch (mud rescue bounce): wet rising bandpass noise + bloop up + low splat. */
function sfxSplorch(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.melon * TRIM.splorch;
  noiseHit(e, e.sfx, false, 'bandpass', 300, 1400, 3, t, 0.006, g, t + 0.2);
  blip(e, e.sfx, false, 'sine', 140, 420, 0.18, t + 0.02, 0.004, g * 0.6, t + 0.22);
  noiseHit(e, e.sfx, false, 'lowpass', 320, 200, 0.9, t, 0.001, g * 0.7, t + 0.07);
  return t + 0.23;
}

/** Fever smash: punchy bandpassed noise pow + falling thump + tiny sparkle. */
function sfxSmash(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.melon * TRIM.smash;
  noiseHit(e, e.sfx, false, 'bandpass', 1300, 700, 0.9, t, 0.001, g * 0.9, t + 0.09);
  blip(e, e.sfx, false, 'sine', 220, 55, 0.12, t, 0.0015, g * 0.9, t + 0.13);
  noiseHit(e, e.sfx, false, 'highpass', 6000, 6000, 0.7, t + 0.01, 0.002, g * 0.25, t + 0.06);
  return t + 0.14;
}

/** Landing thud (non-slam, vy > ~600): volume scales with impact speed. */
function sfxLand(e: SynthEnv, t: number, vy: number): number {
  const k = clamp01((vy - 600) / 900);
  const g = SFX_GAIN.land * TRIM.land * (0.35 + 0.65 * k);
  blip(e, e.sfx, false, 'sine', 115, 55, 0.09, t, 0.0015, g, t + 0.1);
  noiseHit(e, e.sfx, false, 'lowpass', 520, 360, 0.8, t, 0.001, g * 0.55, t + 0.055);
  return t + 0.11;
}

/** UI click: 20 ms tick. */
function sfxClick(e: SynthEnv, t: number): number {
  const g = SFX_GAIN.click * TRIM.click;
  blip(e, e.sfx, false, 'triangle', 1500, 950, 0.02, t, 0.0008, g, t + 0.02);
  noiseHit(e, e.sfx, false, 'highpass', 4500, 4500, 0.7, t, 0.0005, g * 0.35, t + 0.008);
  return t + 0.03;
}

/** Resume countdown 3-2-1 (C5 D5 E5) and GO (A5, longer, brighter): always in key. */
function sfxCountdown(e: SynthEnv, t: number, n: number, go: boolean): number {
  const g = SFX_GAIN.countdown;
  const semi = go ? 36 : n >= 3 ? 27 : n === 2 ? 29 : 31;
  const f = semiHz(semi);
  const end = t + (go ? 0.42 : 0.15);
  blip(e, e.sfx, go, 'triangle', f, f, 0, t, 0.003, g, end, go ? 0.08 : 0.03);
  blip(e, e.sfx, false, 'sine', f * 2, f * 2, 0, t, 0.002, g * 0.22, t + 0.1);
  if (go) blip(e, e.sfx, true, 'triangle', f * 1.5, f * 1.5, 0, t + 0.01, 0.003, g * 0.45, end, 0.06);
  return end + 0.01;
}

/**
 * Play one SFX recipe at time `t`. `param` meaning per id: see SfxId in types.ts.
 * Returns the time its last partial has decayed (0 when nothing was scheduled).
 */
export function playSfx(e: SynthEnv, id: SfxId, param: number, t: number): number {
  switch (id) {
    case 'footstep':
      return sfxFootstep(e, t, param > 0 ? param : SPEED.start);
    case 'jump':
      return sfxJump(e, t);
    case 'slamStart':
      return sfxSlamStart(e, t);
    case 'slamImpact':
      return sfxSlamImpact(e, t);
    case 'boing':
      return sfxBoing(e, t);
    case 'drum':
      return sfxDrum(e, t, param, false);
    case 'drumBoom':
      return sfxDrum(e, t, param, true);
    case 'stomp':
      return sfxStomp(e, t, param);
    case 'mango':
      return sfxMango(e, t, param);
    case 'golden':
      return sfxGolden(e, t);
    case 'melon':
      return sfxMelon(e, t);
    case 'nearMiss':
      return sfxNearMiss(e, t);
    case 'chainBank':
      return sfxChainBank(e, t, param);
    case 'shieldGet':
      return sfxShieldGet(e, t);
    case 'shieldBreak':
      return sfxShieldBreak(e, t);
    case 'magnetGet':
      return sfxMagnet(e, t);
    case 'logWarn':
      return sfxLogWarn(e, t);
    case 'feverStart':
      return sfxFeverStart(e, t);
    case 'feverEnd':
      return sfxFeverEnd(e, t);
    case 'bestFlag':
      return sfxBestFlag(e, t);
    case 'death':
      return sfxDeath(e, t);
    case 'splorch':
      return sfxSplorch(e, t);
    case 'smash':
      return sfxSmash(e, t);
    case 'land':
      return sfxLand(e, t, param);
    case 'click':
      return sfxClick(e, t);
    case 'countdown':
      return sfxCountdown(e, t, param, false);
    case 'go':
      return sfxCountdown(e, t, 0, true);
  }
  return 0;
}
