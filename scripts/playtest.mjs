#!/usr/bin/env node
/**
 * Hippo Tototo: Stomp the Beat — acceptance / playtest script (spec §15, CONTRACTS §10).
 *
 * Drives BOTH builds with Playwright Chromium:
 *   - standalone: file://<repo>/public/play.html
 *   - Next:       <url>/play  (starts `pnpm start -p 3123` after a build, unless --url is given)
 *
 * Usage
 *   pnpm build && node scripts/playtest.mjs                 # everything, both builds
 *   node scripts/playtest.mjs --url http://localhost:3000   # use a running server for /play
 *   node scripts/playtest.mjs --no-next                     # standalone only
 *   node scripts/playtest.mjs --shots /tmp/shots            # also save screenshots (1366x768 + 390x844)
 *   node scripts/playtest.mjs --only rules,touch            # run a subset of groups (see GROUPS)
 *   node scripts/playtest.mjs --fps-seconds 30              # real-time fps window (default 15)
 *   node scripts/playtest.mjs --file /tmp/x/play.html       # standalone target from another bundle
 *
 * Playwright: uses require('playwright') (local or the global install). No new dependencies.
 * Exit code 0 only when every check passes. A JSON report is written next to the screenshots
 * (or to the OS temp dir).
 *
 * Notes
 *  - Sim checks use window.__hippoRun.advance() (deterministic, no rendering, no audio).
 *  - Real-time checks (console, input, fps, human-like play) run the actual rAF loop.
 *  - Headless Chromium rasterises in software; fps numbers are reported as measured.
 */
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DT = 1 / 120;

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const OPT = {
  url: arg('--url', null),
  noNext: argv.includes('--no-next'),
  noFile: argv.includes('--no-file'),
  shots: arg('--shots', null),
  only: arg('--only', null),
  fpsSeconds: Number(arg('--fps-seconds', 15)),
  port: Number(arg('--port', 3123)),
  verbose: argv.includes('--verbose'),
  file: arg('--file', null),
};
// Standalone bundle under test (default public/play.html; --file points at a scratch build).
const PLAY_HTML = OPT.file && OPT.file !== true ? resolve(String(OPT.file)) : join(ROOT, 'public', 'play.html');
const GROUPS = ['static', 'console', 'rules', 'physics', 'mud', 'fever', 'flag', 'keyboard', 'touch', 'storage', 'sabotage', 'viewport', 'pause', 'remount', 'parity', 'human', 'fps', 'shots'];
const ONLY = OPT.only ? String(OPT.only).split(',') : null;
const want = (g) => !ONLY || ONLY.includes(g);

/* ------------------------------------------------------------------ */
/* Playwright                                                          */
/* ------------------------------------------------------------------ */
function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch (_e) {
    /* fall through to the global install */
  }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return req(join(globalRoot, 'playwright'));
  } catch (e) {
    console.error('playwright not found (local or global). Install it globally: npm i -g playwright');
    throw e;
  }
}
const { chromium } = loadPlaywright();

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */
const results = [];
let currentTarget = '-';
function check(name, pass, evidence) {
  const ev = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  results.push({ target: currentTarget, name, pass: !!pass, evidence: ev });
  const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${tag} [${currentTarget}] ${name} — ${ev}`);
}
function info(name, evidence) {
  const ev = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  results.push({ target: currentTarget, name, pass: null, evidence: ev });
  console.log(`INFO [${currentTarget}] ${name} — ${ev}`);
}
async function guard(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${name} (threw)`, false, String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
  }
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */
let browser;

/** New isolated context + page. Captures console warnings/errors and page errors. */
async function openPage(url, opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1366, height: 768 },
    deviceScaleFactor: opts.dpr || 1,
    hasTouch: !!opts.touch,
    isMobile: !!opts.mobile,
  });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const msgs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') msgs.push(`${t}: ${m.text()}`);
  });
  page.on('pageerror', (e) => msgs.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__hippoRun, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return { ctx, page, msgs };
}

const S = (page) => page.evaluate(() => window.__hippoRun.getState());

/** Poll (real time, via rAF) until window.__hippoRun.getState().state === mode. Returns ms or -1. */
function waitMode(page, mode, timeoutMs) {
  return page.evaluate(
    ([m, to]) =>
      new Promise((res) => {
        const t0 = performance.now();
        const tick = () => {
          if (window.__hippoRun.getState().state === m) return res(performance.now() - t0);
          if (performance.now() - t0 > to) return res(-1);
          requestAnimationFrame(tick);
        };
        tick();
      }),
    [mode, timeoutMs],
  );
}

/** In-page library: installed once per page (string so it runs in the page realm). */
const LIB = `
window.__pt = (function () {
  var H = window.__hippoRun, DT = 1 / 120;
  function st() { return H.getState(); }
  function ents(kind) { var a = H.getEntities(); return kind ? a.filter(function (e) { return e.kind === kind; }) : a; }
  /** Advance one sim step at a time until pred(state) is true or maxS sim-real seconds pass. */
  function stepUntil(pred, maxS) {
    var n = Math.round(maxS / DT);
    for (var i = 0; i < n; i++) { var s = st(); if (pred(s)) return s; H.advance(DT); }
    return null;
  }
  /** Restart on seed, optionally skipping the first-run tutorial by marking it seen beforehand. */
  function fresh(seed) { H.setAutopilot(false); H.setInvincible(false); H.release(); H.forceSeed(seed); H.restart(); H.advance(DT); }
  /** Track min/max of heroY over n steps. */
  function track(n) { var mx = -1e9; for (var i = 0; i < n; i++) { H.advance(DT); var y = st().heroY; if (y > mx) mx = y; } return mx; }
  return { H: H, DT: DT, st: st, ents: ents, stepUntil: stepUntil, fresh: fresh, track: track };
})();`;
async function lib(page) {
  await page.evaluate(LIB);
}

/** Fast-forward a playing run to its game over (no input) and through the input lockout. */
async function dieNow(page) {
  return page.evaluate(() => {
    const H = window.__hippoRun;
    H.setAutopilot(false);
    H.setInvincible(false);
    for (let i = 0; i < 40 && H.getState().state !== 'gameover'; i++) H.advance(0.5);
    return H.getState();
  });
}

/* ------------------------------------------------------------------ */
/* Static build checks (once)                                          */
/* ------------------------------------------------------------------ */
async function testStatic() {
  currentTarget = 'build';
  const html = readFileSync(PLAY_HTML, 'utf8');
  const kb = Buffer.byteLength(html) / 1024;
  check('public/play.html < 400 KB', kb < 400, `${kb.toFixed(1)} KB`);
  const bad = [/https?:\/\//i, /<link[\s>]/i, /<img[\s>]/i, /<script[^>]*\ssrc\s*=/i].filter((re) => re.test(html)).map(String);
  check('play.html has no external URL / <link> / <img> / <script src>', bad.length === 0, bad.length ? bad.join(' ') : 'clean');
  let headPkg = null;
  try {
    headPkg = JSON.parse(execSync('git show HEAD:package.json', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (_e) {
    headPkg = null;
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (headPkg) {
    const added = [];
    for (const k of ['dependencies', 'devDependencies']) {
      for (const d of Object.keys(pkg[k] || {})) if (!(headPkg[k] || {})[d]) added.push(`${k}:${d}`);
    }
    check('no new dependencies vs HEAD', added.length === 0, added.length ? added.join(', ') : 'none added');
  } else info('no new dependencies vs HEAD', 'git HEAD package.json unavailable');
  check('package.json has build:play + prebuild scripts', !!(pkg.scripts && pkg.scripts['build:play'] && pkg.scripts.prebuild), pkg.scripts);
  let newFiles = [];
  try {
    newFiles = execSync('git status --porcelain -uall', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^(\?\?|A )/.test(l))
      .map((l) => l.slice(3))
      .filter((f) => /\.(png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|m4a|aac|flac|woff2?|ttf|otf|eot)$/i.test(f));
  } catch (_e) {
    /* not a git checkout */
  }
  check('no image/audio/font files added', newFiles.length === 0, newFiles.length ? newFiles.join(', ') : 'none');
  const manifest = join(ROOT, '.next', 'app-path-routes-manifest.json');
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    check('/play is in the Next route list', Object.values(m).includes('/play'), Object.values(m).join(' '));
  } else info('/play is in the Next route list', 'no .next build found (run pnpm build)');
}

/* ------------------------------------------------------------------ */
/* Console-clean journey with real input (both builds)                 */
/* ------------------------------------------------------------------ */
async function testConsole(url) {
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=3');
  const s0 = await S(page);
  check('__hippoRun exposed, starts on title', s0.state === 'title', s0.state);
  await page.waitForTimeout(800);
  await page.keyboard.press('Space');
  const tStart = await waitMode(page, 'playing', 1000);
  check('Space starts from title', tStart >= 0, `${tStart.toFixed(0)} ms`);
  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyP');
  const tPause = await waitMode(page, 'paused', 500);
  check('P pauses', tPause >= 0, `${tPause.toFixed(0)} ms`);
  await page.waitForTimeout(500);
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(500);
  const mid = await S(page);
  const tResume = await waitMode(page, 'playing', 2500);
  check('resume runs the 3-2-1 (still paused 0.5 s later, playing after)', mid.state === 'paused' && tResume > 0, `at+0.5s=${mid.state}, playing after another ${tResume.toFixed(0)} ms`);
  // Let the run end naturally (no input -> first bush; a first-ever run also shows the teaching freeze).
  const tDie = await waitMode(page, 'gameover', 20000);
  const sd = await S(page);
  check('no-input run ends at the first bush (real time)', tDie >= 0 && sd.deathCause === 'bush', `${sd.deathCause} @ run ${sd.time.toFixed(2)} s`);
  const methods = ['Space', 'Enter', 'tap', 'KeyR', 'ArrowUp'];
  const retryMs = [];
  for (let k = 0; k < 5; k++) {
    await page.waitForTimeout(650); // card lockout 0.5 s
    const m = methods[k];
    const t0 = Date.now();
    if (m === 'tap') await page.mouse.click(60, 400);
    else await page.keyboard.press(m);
    const ms = await waitMode(page, 'playing', 1000);
    retryMs.push(ms >= 0 ? Math.round(Date.now() - t0) : -1);
    await page.waitForTimeout(700);
    await dieNow(page);
    await page.waitForTimeout(200);
  }
  check('5 consecutive retries (Space, Enter, tap, R, ArrowUp) each back to playing < 300 ms', retryMs.every((v) => v >= 0 && v < 300), retryMs.map((v) => v + 'ms').join(' '));
  await page.waitForTimeout(800);
  check('zero console errors/warnings: title -> play -> pause/resume -> death -> 5 retries', msgs.length === 0, msgs.length ? msgs.slice(0, 6).join(' || ') : 'none');
  await ctx.close();
}

/**
 * ?seed= with a malformed %-escape must never break the boot (decodeURIComponent throws on it):
 * ?seed=%25 (a valid escape, the control), ?seed=% and ?seed=abc%zz -> __hippoRun defined, a run
 * starts with a finite seed, no page error / console error.
 */
async function testSeedParam(url) {
  for (const q of ['%25', '%', 'abc%zz']) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(`error: ${m.text()}`);
    });
    const r = { url: '?seed=' + q };
    try {
      const resp = await page.goto(url + (url.includes('?') ? '&' : '?') + 'seed=' + q, { waitUntil: 'load' });
      r.status = resp ? resp.status() : null;
      await page.waitForFunction(() => !!window.__hippoRun, null, { timeout: 8000 });
      r.api = true;
      const s = await page.evaluate(() => {
        const H = window.__hippoRun;
        const s0 = H.getState();
        H.start();
        H.advance(1);
        const s1 = H.getState();
        return { title: s0.state, state: s1.state, seed: s1.seed, time: +s1.time.toFixed(2), search: location.search };
      });
      Object.assign(r, s);
      await page.waitForTimeout(300);
    } catch (e) {
      r.api = false;
      r.threw = String((e && e.message) || e).split('\n')[0];
    }
    r.errors = errs;
    check(`?seed=${q}${q === '%25' ? ' (control)' : ''}: boots with __hippoRun, a run starts, no page error`, r.api && r.title === 'title' && r.state === 'playing' && Number.isFinite(r.seed) && errs.length === 0, r);
    await ctx.close();
  }
}

/* ------------------------------------------------------------------ */
/* Game rules via advance(): opening, no-input death, determinism,     */
/* autopilot fairness, invincible soak                                 */
/* ------------------------------------------------------------------ */
async function testRules(url) {
  // ?debug=1 turns on the generator's fairness asserts (spec §8.2): any violation is a console.warn.
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'debug=1');
  await lib(page);

  // First lethal hazard never reachable before 5.0 s (seeds 1–20, no input).
  const open = await page.evaluate(() => {
    const P = window.__pt;
    const out = [];
    for (let seed = 1; seed <= 20; seed++) {
      P.fresh(seed);
      const at49 = P.stepUntil((s) => s.time >= 4.9 || s.state !== 'playing', 30);
      const s49 = P.st();
      const died = P.stepUntil((s) => s.state !== 'playing', 40);
      out.push({ seed, at49: s49.state, t49: +s49.time.toFixed(3), deathT: died ? +died.time.toFixed(3) : -1, cause: died ? died.deathCause : null });
    }
    return out;
  });
  const okOpen = open.every((o) => o.at49 === 'playing' && o.t49 >= 4.89);
  check('seeds 1–20: still playing at t = 4.9 s with no input', okOpen, open.filter((o) => o.at49 !== 'playing').length ? open : `all playing; earliest death ${Math.min(...open.map((o) => o.deathT)).toFixed(2)} s`);
  check('seeds 1–20: no-input run always ends on the first bush, never before 5.0 s', open.every((o) => o.cause === 'bush' && o.deathT >= 5.0), open.map((o) => `${o.seed}:${o.cause}@${o.deathT}`).join(' '));

  // One press after the lockout returns to playing within 300 ms (real time).
  await page.evaluate(() => {
    const H = window.__hippoRun;
    for (let i = 0; i < 40 && H.getState().state !== 'gameover'; i++) H.advance(0.5);
  });
  await page.waitForTimeout(600);
  const pressMs = await page.evaluate(
    () =>
      new Promise((res) => {
        const H = window.__hippoRun;
        const t0 = performance.now();
        H.press();
        const tick = () => {
          if (H.getState().state === 'playing') {
            H.release();
            return res(performance.now() - t0);
          }
          if (performance.now() - t0 > 1000) return res(-1);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  check('one press() after the lockout -> playing within 300 ms', pressMs >= 0 && pressMs < 300, `${pressMs.toFixed(1)} ms`);

  // Determinism: same seed + same scripted inputs -> identical score/distance (twice), plus autopilot.
  const det = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    function scripted(seed) {
      P.fresh(seed);
      H.setInvincible(true); // keep the scripted run alive for the full 40 s (does not change determinism)
      // Press pattern (sim-step granular): taps, holds, slams and boings at fixed times.
      const n = Math.round(40 / P.DT);
      for (let i = 0; i < n; i++) {
        const t = i * P.DT;
        const ph = t % 1.1;
        if (Math.abs(ph - 0.2) < 1e-6 || (ph > 0.2 - P.DT / 2 && ph < 0.2 + P.DT / 2)) H.press();
        if (ph > 0.2 + (Math.floor(t / 1.1) % 2 ? 0.3 : 0.04) - P.DT / 2 && ph < 0.2 + (Math.floor(t / 1.1) % 2 ? 0.3 : 0.04) + P.DT / 2) H.release();
        if (Math.floor(t / 1.1) % 3 === 2 && ph > 0.62 - P.DT / 2 && ph < 0.62 + P.DT / 2) {
          H.press();
          H.release();
        }
        H.advance(P.DT);
        if (H.getState().state !== 'playing') break;
      }
      const s = H.getState();
      H.setInvincible(false);
      return { score: s.score, distance: +s.distance.toFixed(4), time: +s.time.toFixed(4), state: s.state, chain: s.chain, booms: 0 };
    }
    function auto(seed) {
      P.fresh(seed);
      H.setAutopilot(true);
      H.advance(60);
      H.setAutopilot(false);
      const s = H.getState();
      return { score: s.score, distance: +s.distance.toFixed(4), time: +s.time.toFixed(4), state: s.state };
    }
    return { a: scripted(7), b: scripted(7), c: auto(11), d: auto(11) };
  });
  check('determinism: scripted inputs, seed 7, twice', JSON.stringify(det.a) === JSON.stringify(det.b), det.a);
  check('determinism: autopilot 60 s, seed 11, twice', JSON.stringify(det.c) === JSON.stringify(det.d), det.c);

  // Autopilot (ground jumps only) survives >= 90 s on seeds 1–10.
  const ap = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    const out = [];
    for (let seed = 1; seed <= 10; seed++) {
      P.fresh(seed);
      H.setAutopilot(true);
      let s = H.getState();
      let score45 = -1;
      for (let k = 0; k < 400 && s.state === 'playing' && s.time < 90; k++) {
        H.advance(0.25);
        s = H.getState();
        if (score45 < 0 && s.time >= 45) score45 = s.score;
      }
      H.setAutopilot(false);
      out.push({ seed, state: s.state, time: +s.time.toFixed(1), dist: Math.round(s.distance), score: s.score, score45, cause: s.deathCause, shield: s.shield });
    }
    return out;
  });
  check('autopilot survives >= 90 s on seeds 1–10 (no invincibility)', ap.every((o) => o.state === 'playing' && o.time >= 90), ap.map((o) => `${o.seed}:${o.state}@${o.time}s/${o.dist}m${o.cause ? ' ' + o.cause : ''}`).join(' '));
  const s45 = ap.filter((o) => o.score45 > 0).map((o) => o.score45);
  info('autopilot score at 45 s (medal calibration: bronze ~ a 45 s clean run)', `mean ${Math.round(s45.reduce((a, b) => a + b, 0) / Math.max(1, s45.length))}, range ${Math.min(...s45)}–${Math.max(...s45)}`);

  // Invincible soak: advance(600) without exceptions, entities <= pool size, all four phases entered.
  const soak = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    P.fresh(4242);
    H.setInvincible(true);
    let maxEnt = 0;
    let err = null;
    const seen = {};
    try {
      for (let k = 0; k < 600; k++) {
        H.advance(1);
        const s = H.getState();
        if (s.entities > maxEnt) maxEnt = s.entities;
        seen[s.phase] = 1;
        if (s.state !== 'playing') break;
      }
    } catch (e) {
      err = String(e);
    }
    const s = H.getState();
    H.setInvincible(false);
    return { err, maxEnt, phasesSeen: s.phasesSeen, sampled: Object.keys(seen).join(''), dist: Math.round(s.distance), time: Math.round(s.time), state: s.state };
  });
  check('invincible soak advance(600): no exception, still playing', !soak.err && soak.state === 'playing', soak);
  check('invincible soak: entities <= pool size (96 + 160)', soak.maxEnt <= 256, `max ${soak.maxEnt}`);
  check('invincible soak: all four day phases entered', (soak.phasesSeen & 15) === 15, `phasesSeen mask ${soak.phasesSeen}, sampled ${soak.sampled}, ${soak.dist} m`);
  check('no console errors/warnings during sim checks (incl. ?debug=1 fairness asserts over ~30 min of generated course)', msgs.length === 0, msgs.length ? msgs.slice(0, 5).join(' || ') : 'none');
  await ctx.close();
  return ap;
}

/**
 * First-ever run (fresh storage): the TAP lesson cannot be failed by a tap. A real touchscreen tap
 * 100 / 600 / 1300 / 2400 ms (real time) after the teaching freeze engages clears the first bush:
 * still playing at run time 7 s. Seeds 1 and 7; the run is fast-forwarded to 3.5 s first (no
 * hazard before 5 s), everything from there on is real time.
 */
async function testTapLesson(url) {
  const rows = [];
  const errs = [];
  for (const seed of [1, 7]) {
    for (const delay of [100, 600, 1300, 2400]) {
      const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=' + seed, { touch: true });
      const row = { seed, delay };
      // a tap point on the canvas that is not on a canvas button
      const pt = await page.evaluate(() => {
        const H = window.__hippoRun;
        const c = document.querySelector('canvas').getBoundingClientRect();
        const btns = H.getButtons();
        const onBtn = (x, y) => btns.some((b) => x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 10 && y <= b.y + b.h + 10);
        for (const [fx, fy] of [
          [0.5, 0.62],
          [0.5, 0.8],
          [0.35, 0.5],
          [0.65, 0.5],
        ]) {
          const x = c.width * fx;
          const y = c.height * fy;
          if (!onBtn(x, y)) return { x: c.left + x, y: c.top + y };
        }
        return { x: c.left + c.width * 0.5, y: c.top + c.height * 0.62 };
      });
      await page.touchscreen.tap(pt.x, pt.y);
      row.startMs = Math.round(await waitMode(page, 'playing', 1000));
      const pre = await page.evaluate(() => {
        const H = window.__hippoRun;
        for (let i = 0; i < 600 && H.getState().state === 'playing' && H.getState().time < 3.5 && !H.getState().freeze; i++) H.advance(1 / 120);
        const s = H.getState();
        return { tutorial: s.tutorial, freeze: s.freeze, time: +s.time.toFixed(2) };
      });
      row.tutorial = pre.tutorial;
      const fr = await page.evaluate(
        () =>
          new Promise((res) => {
            const H = window.__hippoRun;
            const t0 = performance.now();
            const tick = () => {
              const s = H.getState();
              if (s.freeze) return res({ ok: true, t: +s.time.toFixed(3) });
              if (s.state !== 'playing' || performance.now() - t0 > 6000) return res({ ok: false, t: +s.time.toFixed(3), state: s.state });
              requestAnimationFrame(tick);
            };
            tick();
          }),
      );
      row.freezeAt = fr.t;
      if (fr.ok) {
        await page.waitForTimeout(delay);
        const sTap = await S(page);
        row.tapAt = { time: +sTap.time.toFixed(3), freeze: sTap.freeze };
        await page.touchscreen.tap(pt.x, pt.y);
        const end = await page.evaluate(
          () =>
            new Promise((res) => {
              const H = window.__hippoRun;
              const t0 = performance.now();
              let apex = 0;
              const tick = () => {
                const s = H.getState();
                if (s.heroY > apex) apex = s.heroY;
                if (s.state !== 'playing' || s.time >= 7 || performance.now() - t0 > 9000) return res({ state: s.state, time: +s.time.toFixed(2), cause: s.deathCause, apex: Math.round(apex) });
                requestAnimationFrame(tick);
              };
              tick();
            }),
        );
        Object.assign(row, end);
      } else row.state = 'no freeze (' + fr.state + ')';
      rows.push(row);
      for (const m of msgs) errs.push(`seed ${seed}/${delay}ms ${m}`);
      await ctx.close();
    }
  }
  const ok = rows.every((r) => r.tutorial && r.state === 'playing' && r.time >= 7);
  check(
    'first run: a real tap 100/600/1300/2400 ms into the teaching freeze clears the bush (seeds 1, 7: playing at 7 s)',
    ok,
    rows.map((r) => `s${r.seed}+${r.delay}ms: freeze@${r.freezeAt} tap@${r.tapAt ? r.tapAt.time : '-'} -> ${r.state}@${r.time}${r.cause ? ' ' + r.cause : ''} apex ${r.apex}`).join(' | '),
  );
  check('no console errors/warnings (tap lesson)', errs.length === 0, errs.slice(0, 4).join(' || ') || 'none');
}

/**
 * Returning player (tutorialSeen save):
 *  - a 15 Hz masher (press every 8th 120 Hz step, release 4 steps later) is not a strategy:
 *    at most 2 of seeds 1–10 are still alive at sim 60 s, and TOTOTO TIME never starts before 15 s;
 *  - power-up bubbles need a hop: a zero-input invincible run (120 s, seeds 1–3) never gains a Mud Coat.
 */
async function testMasher(url) {
  const init = () => {
    try {
      localStorage.setItem('hippotototo.v1', JSON.stringify({ v: 1, best: 0, bestDist: 0, bestChain: 0, runs: 5, totalMangoes: 0, muted: true, reducedMotion: false, tutorialSeen: true, goalIndex: 0 }));
    } catch (_e) {
      /* ignore */
    }
  };
  const { ctx, page, msgs } = await openPage(url, { init });
  await lib(page);
  const mash = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    const out = [];
    for (let seed = 1; seed <= 10; seed++) {
      P.fresh(seed);
      let s = P.st();
      let fever = -1;
      for (let i = 1; i < 120 * 90 && s.state === 'playing' && s.time < 60; i++) {
        if (i % 8 === 0) H.press();
        else if (i % 8 === 4) H.release();
        H.advance(P.DT);
        s = P.st();
        if (s.fever && fever < 0) fever = +s.time.toFixed(2);
      }
      H.release();
      const row = { seed, alive: s.state === 'playing' && s.time >= 60, time: +s.time.toFixed(1), cause: s.deathCause, fever, score: s.score };
      // The same masher made invincible, so the groove economy is measured even when mashing dies early.
      P.fresh(seed);
      H.setInvincible(true);
      s = P.st();
      row.feverInv = -1;
      for (let i = 1; i < 120 * 30 && s.state === 'playing' && s.time < 20; i++) {
        if (i % 8 === 0) H.press();
        else if (i % 8 === 4) H.release();
        H.advance(P.DT);
        s = P.st();
        if (s.fever && row.feverInv < 0) row.feverInv = +s.time.toFixed(2);
      }
      H.release();
      H.setInvincible(false);
      out.push(row);
    }
    return out;
  });
  const alive = mash.filter((m) => m.alive).length;
  const earlyFever = mash.filter((m) => (m.fever >= 0 && m.fever < 15) || (m.feverInv >= 0 && m.feverInv < 15));
  check(
    '15 Hz masher (tutorialSeen): <= 2 of seeds 1–10 alive at sim 60 s, no TOTOTO TIME before 15 s (also when invincible)',
    alive <= 2 && earlyFever.length === 0,
    `alive ${alive}/10; ` + mash.map((m) => `${m.seed}:${m.alive ? 'alive' : m.cause + '@' + m.time}${m.fever >= 0 ? ' fever@' + m.fever : ''}${m.feverInv >= 0 ? ' invFever@' + m.feverInv : ''}`).join(' '),
  );
  const bub = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    const out = [];
    for (let seed = 1; seed <= 3; seed++) {
      P.fresh(seed);
      H.setInvincible(true);
      let s = P.st();
      let shieldAt = -1;
      let bubbles = 0;
      const seen = {};
      for (let i = 0; i < 120 * 130 && s.state === 'playing' && s.time < 120; i++) {
        H.advance(P.DT);
        s = P.st();
        if (s.shield && shieldAt < 0) shieldAt = +s.time.toFixed(2);
        if (i % 60 === 0) {
          for (const e of P.ents()) {
            if ((e.kind === 'pickupShield' || e.kind === 'pickupMagnet') && !seen[e.serial]) {
              seen[e.serial] = 1;
              bubbles++;
            }
          }
        }
      }
      H.setInvincible(false);
      out.push({ seed, time: +s.time.toFixed(1), state: s.state, shieldAt, bubbles });
    }
    return out;
  });
  check(
    'zero-input invincible run (120 s, seeds 1–3) never gains a Mud Coat (bubbles need a hop)',
    bub.every((b) => b.shieldAt < 0 && b.time >= 120),
    bub.map((b) => `${b.seed}: ${b.state}@${b.time}s, bubbles seen ${b.bubbles}, shield ${b.shieldAt < 0 ? 'never' : '@' + b.shieldAt + 's'}`).join(' | '),
  );
  check('no console errors/warnings (masher / bubbles)', msgs.length === 0, msgs.slice(0, 4).join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Physics: tap/hold apex, lockout, smart buffer, boing, BOOM, chain   */
/* ------------------------------------------------------------------ */
async function testPhysics(url) {
  const { ctx, page } = await openPage(url);
  await lib(page);
  const r = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    const out = {};
    // Tap (press + release on the next step) vs full hold, on the hazard-free opening.
    P.fresh(5);
    H.advance(0.2);
    H.press();
    H.advance(P.DT);
    H.release();
    out.tapApex = P.track(60);
    P.stepUntil((s) => s.grounded, 2);
    P.fresh(5);
    H.advance(0.2);
    H.press();
    out.holdApex = P.track(90);
    H.release();
    P.stepUntil((s) => s.grounded, 2);
    // A 60 ms tap (spec: tap ~60 ms).
    P.fresh(5);
    H.advance(0.2);
    H.press();
    H.advance(0.06);
    H.release();
    out.tap60Apex = P.track(60);

    // Slam lockout: a press 0.05 s after takeoff must not slam.
    P.fresh(6);
    H.advance(0.2);
    H.press();
    H.advance(0.05);
    H.press();
    let slammed = false;
    for (let i = 0; i < 30; i++) {
      H.advance(P.DT);
      const s = P.st();
      if (s.heroVy === 0 && !s.grounded) slammed = true;
      if (s.heroVy >= 1500) slammed = true;
    }
    out.lockoutSlam = slammed;
    H.release();
    P.stepUntil((s) => s.grounded, 2);

    // A press after the lockout, high in the air -> slam (hang vy 0, then +1500).
    P.fresh(6);
    H.advance(0.2);
    H.press();
    H.advance(0.3);
    H.release();
    H.press();
    H.release();
    H.advance(P.DT); // the press is consumed on the next sim step
    const hang = P.st().heroVy;
    H.advance(0.06);
    out.slamHangVy = hang;
    out.slamDiveVy = P.st().heroVy;
    P.stepUntil((s) => s.grounded, 2);

    // Smart buffer: a press inside the final 0.11 s of a fall -> jump on landing, not a slam.
    P.fresh(8);
    H.advance(0.2);
    H.press();
    H.advance(0.2);
    H.release();
    // fall until predicted time-to-ground <= ~0.09 s (closed form, fall gravity 3500)
    const s1 = P.stepUntil((s) => {
      if (s.heroVy <= 0 || s.grounded) return false;
      const v0 = s.heroVy;
      const t = (-v0 + Math.sqrt(v0 * v0 + 2 * 3500 * s.heroY)) / 3500;
      return t <= 0.09;
    }, 2);
    out.bufferPressHeight = s1 ? +s1.heroY.toFixed(1) : null;
    H.press();
    H.release();
    let sawSlam = false;
    let landed = false;
    let relaunched = false;
    for (let i = 0; i < 40; i++) {
      H.advance(P.DT);
      const s = P.st();
      if (s.heroVy >= 1500 || (s.heroVy === 0 && !s.grounded)) sawSlam = true;
      if (s.heroY <= 0.01) landed = true;
      if (landed && s.heroVy < -500) relaunched = true;
      if (relaunched) break;
    }
    out.bufferSlam = sawSlam;
    out.bufferJump = relaunched;
    P.stepUntil((s) => s.grounded, 2);

    // Boing: slam, press during the dive -> on impact vy -1120, apex >= 230.
    P.fresh(9);
    H.advance(0.2);
    H.press();
    H.advance(0.3);
    H.release();
    H.press(); // slam
    H.release();
    H.advance(0.08); // in the dive
    H.press(); // queued boing
    H.release();
    out.boingApex = P.track(100);
    P.stepUntil((s) => s.grounded, 2);
    // Boing pressed right AFTER the slam hits the ground (within 0.12 s).
    P.fresh(9);
    H.advance(0.2);
    H.press();
    H.advance(0.3);
    H.release();
    H.press();
    H.release();
    P.stepUntil((s) => s.grounded, 2);
    H.advance(0.05);
    H.press();
    H.release();
    out.boingLateApex = P.track(100);
    P.stepUntil((s) => s.grounded, 2);

    // BOOM: slam onto the opening drum -> chain 2; landing on the ground -> chain 0.
    P.fresh(10);
    const drum = P.ents('drum').filter((e) => e.x > P.st().heroX)[0];
    out.drum = drum ? Math.round(drum.x) : null;
    if (drum) {
      const cx = drum.x + drum.w / 2;
      const top = 430 - drum.y; // drum top altitude
      // take off so that the apex comes a bit before the drum, then slam when the dive lands on it
      P.stepUntil((s) => cx - s.heroX <= s.speed * 0.5, 6);
      H.press();
      H.advance(0.2);
      H.release();
      let chainAfter = -1;
      let pressed = false;
      for (let i = 0; i < 160; i++) {
        const s = P.st();
        if (!pressed && s.heroVy > -200 && s.heroY > top + 20) {
          const tDive = 0.05 + (s.heroY - top) / 1500;
          if (s.heroX + s.speed * tDive >= cx - 6) {
            H.press();
            H.release();
            pressed = true;
          }
        }
        const before = s.chain;
        H.advance(P.DT);
        const s2 = P.st();
        if (s2.chain > before) {
          chainAfter = s2.chain;
          break;
        }
      }
      out.boomChain = chainAfter;
      out.boomVy = P.st().heroVy;
      const g = P.stepUntil((s) => s.grounded, 3);
      out.chainOnGround = g ? g.chain : -1;
    }
    // Plain drum bounce: jump onto the drum (T_ON) -> chain 1.
    P.fresh(10);
    const d2 = P.ents('drum').filter((e) => e.x > P.st().heroX)[0];
    if (d2) {
      const cx = d2.x + d2.w / 2;
      P.stepUntil((s) => (cx - s.heroX) / s.speed <= 0.6, 6);
      H.press();
      let c = -1;
      for (let i = 0; i < 120; i++) {
        H.advance(P.DT);
        if (P.st().chain > 0) {
          c = P.st().chain;
          break;
        }
      }
      H.release();
      out.drumChain = c;
      out.drumVy = P.st().heroVy;
    }
    return out;
  });
  check('tap (press+release next step) = short hop, apex 60–90 u', r.tapApex >= 60 && r.tapApex <= 90, `apex ${r.tapApex.toFixed(1)} u`);
  check('60 ms tap = short hop, apex 60–90 u', r.tap60Apex >= 60 && r.tap60Apex <= 90, `apex ${r.tap60Apex.toFixed(1)} u`);
  check('hold = full jump, apex 150–160 u', r.holdApex >= 150 && r.holdApex <= 160, `apex ${r.holdApex.toFixed(1)} u`);
  check('press < 0.12 s after takeoff does not slam', r.lockoutSlam === false, `slammed=${r.lockoutSlam}`);
  check('press after the lockout high in the air = SLAM (hang vy 0, then +1500)', r.slamHangVy === 0 && r.slamDiveVy === 1500, `hang vy ${r.slamHangVy}, dive vy ${r.slamDiveVy}`);
  check('press in the final 0.11 s of a fall = jump on landing, not a slam', r.bufferSlam === false && r.bufferJump === true, `pressed at ${r.bufferPressHeight} u; slam=${r.bufferSlam}, jumped on landing=${r.bufferJump}`);
  check('slam -> press during dive -> BOING apex >= 230 u', r.boingApex >= 230, `apex ${r.boingApex.toFixed(1)} u`);
  check('slam -> press within 0.12 s after impact -> BOING apex >= 230 u', r.boingLateApex >= 230, `apex ${r.boingLateApex.toFixed(1)} u`);
  check('jump onto a drum = bounce, chain 1 (vy -900)', r.drumChain === 1, `chain ${r.drumChain}, vy after ${r.drumVy && r.drumVy.toFixed(0)}`);
  check('slam onto a drum = BOOM, chain +2', r.boomChain === 2, `drum@${r.drum}, chain ${r.boomChain}, vy after ${r.boomVy && r.boomVy.toFixed(0)}`);
  check('landing on the ground resets chain to 0', r.chainOnGround === 0, `chain ${r.chainOnGround}`);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Mud pit: slam rescue vs sink (or Mud Coat)                          */
/* ------------------------------------------------------------------ */
async function testMud(url) {
  const { ctx, page } = await openPage(url);
  await lib(page);
  const r = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    /**
     * Autopilot (continuing the current run, or a fresh one when seed is given) until the nearest
     * pit lies 350–1200 u ahead with no hazard before or just after it. Autopilot is off on return.
     */
    function findPit(seed) {
      if (seed !== null) P.fresh(seed);
      H.setAutopilot(true);
      for (let k = 0; k < 4000; k++) {
        H.advance(0.05);
        const s = P.st();
        if (s.state !== 'playing') return null;
        if (!s.grounded || s.time < 30) continue;
        const pits = P.ents('pit').filter((e) => e.x > s.heroX).sort((a, b) => a.x - b.x);
        if (!pits.length || pits[0].x < s.heroX + 350 || pits[0].x > s.heroX + 1200) continue;
        const pit = pits[0];
        const blocked = P.ents().some((e) => e.hazard && e.flag === 'none' && e.x + e.w > s.heroX - 30 && e.x < pit.x + pit.w + 120);
        if (blocked) continue;
        H.setAutopilot(false);
        return pit;
      }
      H.setAutopilot(false);
      return null;
    }
    function pitFlag(pit) {
      const pe = P.ents('pit').filter((e) => e.serial === pit.serial)[0];
      return pe ? pe.flag : 'gone';
    }
    /** After a rescue, watch the bounce, then let the autopilot carry on for 1.5 s. */
    function watch(pit) {
      let minY = 1e9;
      let upVy = 0;
      let mudT = -1;
      let flag = 'none';
      for (let i = 0; i < 150; i++) {
        H.advance(P.DT);
        const s = P.st();
        if (s.heroY < minY) minY = s.heroY;
        if (s.heroY < -20 && s.heroVy < upVy) upVy = s.heroVy;
        if (flag === 'none' && pitFlag(pit) === 'rescued') {
          flag = 'rescued';
          mudT = i;
        }
        if (s.state !== 'playing' || (s.grounded && i > 10)) break;
      }
      H.setAutopilot(true);
      H.advance(1.5);
      H.setAutopilot(false);
      return { minY: +minY.toFixed(1), bounceVy: Math.round(upVy), flag, state: P.st().state, cause: P.st().deathCause };
    }
    const out = {};
    // (a) A jump that falls short into the pit: any press while falling over it is a SLAM -> SPLORCH.
    for (let seed = 21; seed < 40 && !out.short; seed++) {
      const pit = findPit(seed);
      if (!pit) continue;
      const mid = pit.x + pit.w * 0.55;
      P.stepUntil((s) => s.heroX >= mid - s.speed * 0.642, 6);
      H.press();
      H.advance(0.3);
      H.release();
      P.stepUntil((s) => s.heroVy > 0 && s.heroY < 90, 2);
      const over = P.st().heroX > pit.x + 6 && P.st().heroX < pit.x + pit.w - 6;
      H.press();
      H.release();
      out.short = Object.assign({ seed, pressedOverPit: over }, watch(pit));
    }
    // (b) Walk off the lip, press after coyote time (0.10 s) but before the mud -> SPLORCH.
    for (let seed = 41; seed < 60 && !out.walk; seed++) {
      const pit = findPit(seed);
      if (!pit) continue;
      P.stepUntil((s) => !s.grounded, 6);
      H.advance(0.1);
      H.press();
      H.release();
      out.walk = Object.assign({ seed }, watch(pit));
    }
    // (c) Walk in without pressing: the Mud Coat is consumed (geyser) if held, else the run ends.
    for (let seed = 61; seed < 90 && !out.sink; seed++) {
      let pit = findPit(seed);
      for (let tries = 0; pit && tries < 6 && !out.sink; tries++) {
        const hadShield = P.st().shield;
        P.stepUntil((s) => s.state !== 'playing' || s.heroX > pit.x + pit.w + 60, 4);
        const s = P.stepUntil((s2) => s2.state !== 'playing', 1.5) || P.st();
        if (hadShield) {
          if (!out.shield) out.shield = { seed, state: s.state, shieldAfter: s.shield };
          pit = findPit(null);
          continue;
        }
        out.sink = { seed, state: s.state, cause: s.deathCause };
      }
    }
    return out;
  });
  check('jump falls short into a pit + press -> slam SPLORCH bounce out, run continues', !!r.short && r.short.pressedOverPit && r.short.flag === 'rescued' && r.short.bounceVy <= -800 && r.short.state === 'playing', r.short);
  check('walk off a lip + press after coyote -> slam SPLORCH, run continues', !!r.walk && r.walk.flag === 'rescued' && r.walk.state === 'playing', r.walk);
  check('falling into a mud pit without slamming ends the run (cause pit)', !!r.sink && r.sink.cause === 'pit' && r.sink.state !== 'playing', r.sink);
  check('falling into a pit with a Mud Coat consumes it and survives', !!r.shield && r.shield.state === 'playing' && !r.shield.shieldAfter, r.shield);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* TOTOTO TIME                                                         */
/* ------------------------------------------------------------------ */
async function testFever(url) {
  const { ctx, page } = await openPage(url);
  await lib(page);
  const r = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    P.fresh(77);
    H.setAutopilot(true);
    H.advance(70); // dense part of the course
    H.setAutopilot(false); // no input during the fever: hazards must not end the run
    const before = P.st();
    H.setGroove(100);
    H.advance(P.DT);
    const s0 = P.st();
    const t0 = s0.time;
    let maxSmash = 0;
    let state = s0.state;
    let hazardsMet = 0;
    const seenSerial = {};
    while (P.st().fever && P.st().time - t0 < 8) {
      const s = P.st();
      for (const e of P.ents()) {
        if ((e.hazard || e.kind === 'pit') && !seenSerial[e.serial] && e.x < s.heroX + 30 && e.x + e.w > s.heroX - 30) {
          seenSerial[e.serial] = 1;
          hazardsMet++;
        }
      }
      H.advance(P.DT);
      state = P.st().state;
      if (state !== 'playing') break;
    }
    const s1 = P.st();
    const ahead = P.ents().filter((e) => (e.kind === 'pit' || (e.hazard && e.flag === 'none')) && e.x + e.w > s1.heroX && e.x < s1.heroX + 24 + 500);
    // after: invulnerable 1 s, meter 0
    return {
      grooveBefore: before.groove,
      started: s0.fever,
      feverT0: s0.feverT,
      duration: +(s1.time - t0 + P.DT).toFixed(3),
      stateDuring: state,
      hazardsMet,
      grooveAfter: s1.groove,
      aheadAfter: ahead.map((e) => `${e.kind}@+${Math.round(e.x - s1.heroX)}`),
      speed: Math.round(s1.speed),
    };
  });
  check('groove 100 starts TOTOTO TIME', r.started === true && r.feverT0 > 5.9, r);
  check('TOTOTO TIME lasts 6 s', Math.abs(r.duration - 6) < 0.02, `${r.duration} s`);
  check('no hazard ends the run during TOTOTO TIME (no input)', r.stateDuring === 'playing', `state ${r.stateDuring}, hazards/pits met ${r.hazardsMet}`);
  check('no hazard or pit within 500 u ahead when it ends; meter reset', r.aheadAfter.length === 0 && r.grooveAfter === 0, `ahead: [${r.aheadAfter.join(', ')}], groove ${r.grooveAfter}`);
  // Same seed-77 fever again, counting smashes: a hazard flagged 'smashed' while it overlaps Toto
  // (the fever-exit clear poofs hazards AHEAD and happens on the step the fever ends: not counted).
  const sm = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    P.fresh(77);
    H.setAutopilot(true);
    H.advance(70);
    H.setAutopilot(false);
    const seen = {};
    for (const e of P.ents()) if (e.flag === 'smashed') seen[e.serial] = 1;
    const score0 = P.st().score;
    H.setGroove(100);
    let smashes = 0;
    let lane = 0;
    const kinds = {};
    for (let i = 0; i < 120 * 8; i++) {
      H.advance(P.DT);
      const s = P.st();
      if (!s.fever || s.state !== 'playing') break;
      for (const e of P.ents()) {
        if (e.flag !== 'smashed' || seen[e.serial]) continue;
        seen[e.serial] = 1;
        if (e.x < s.heroX + 60 && e.x + e.w > s.heroX - 60) {
          smashes++;
          if (e.lane) lane++;
          kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        }
      }
    }
    return { smashes, lane, kinds, scoreDelta: P.st().score - score0 };
  });
  check('seed-77 TOTOTO TIME has things to smash (>= 5 smashes, no input)', sm.smashes >= 5, sm);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Best flag                                                           */
/* ------------------------------------------------------------------ */
async function testFlag(url) {
  const init = () => {
    try {
      if (!localStorage.getItem('hippotototo.v1'))
        localStorage.setItem('hippotototo.v1', JSON.stringify({ v: 1, best: 900, bestDist: 60, bestChain: 2, runs: 3, totalMangoes: 10, muted: true, reducedMotion: false, tutorialSeen: true, goalIndex: 1 }));
    } catch (_e) {
      /* ignore */
    }
  };
  const { ctx, page } = await openPage(url, { init });
  await lib(page);
  const r = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    P.fresh(31);
    const flag = P.ents('bestFlag')[0];
    H.setAutopilot(true);
    let before = null;
    let jump = 0;
    let passes = 0;
    let prevPassed = false;
    for (let i = 0; i < 2400; i++) {
      const s = P.st();
      H.advance(P.DT);
      const s2 = P.st();
      if (!prevPassed && s2.bestPassed) {
        passes++;
        before = s.score;
        jump = s2.score - s.score;
      } else if (prevPassed && !s2.bestPassed) passes++;
      prevPassed = s2.bestPassed;
      if (s2.distance > 75 || s2.state !== 'playing') break;
    }
    H.setAutopilot(false);
    const f2 = P.ents('bestFlag')[0];
    return { flagX: flag ? flag.x : null, passes, scoreJump: jump, before, flagAfter: f2 ? f2.flag : 'gone', bestPassed: P.st().bestPassed };
  });
  check('best flag spawns at the stored best distance (60 m = 3000 u)', r.flagX === 3000, `flag x ${r.flagX}`);
  check('passing the best flag celebrates once (+250)', r.passes === 1 && r.scoreJump >= 250 && r.bestPassed, r);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Keyboard mapping (real key events)                                  */
/* ------------------------------------------------------------------ */
async function testKeyboard(url) {
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=12');
  await page.evaluate(() => {
    window.__prevented = {};
    window.addEventListener('keydown', (e) => {
      window.__prevented[e.code] = e.defaultPrevented;
    });
  });
  const jumpWith = async (code) => {
    await page.evaluate(() => {
      const H = window.__hippoRun;
      H.setAutopilot(false);
    });
    await page.keyboard.down(code);
    const ok = await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const tick = () => {
            const s = window.__hippoRun.getState();
            if (s.heroVy < 0 && s.heroY > 0) return res(true);
            if (++n > 20) return res(false);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.keyboard.up(code);
    await page.waitForTimeout(750);
    return ok;
  };
  await page.keyboard.press('Space');
  await waitMode(page, 'playing', 1000);
  await page.waitForTimeout(250);
  const space = await jumpWith('Space');
  const up = await jumpWith('ArrowUp');
  const w = await jumpWith('KeyW');
  check('Space / ArrowUp / W jump', space && up && w, { space, up, w });
  // ArrowDown / S slam in the air; ignored on the ground
  const slamWith = async (code) => {
    await page.keyboard.down('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('Space');
    await page.keyboard.press(code);
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          let saw = false;
          const tick = () => {
            const s = window.__hippoRun.getState();
            if (s.heroVy >= 1500 || (s.heroVy === 0 && !s.grounded)) saw = true;
            if (++n > 20) return res(saw);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.waitForTimeout(600);
    return r;
  };
  const down = await slamWith('ArrowDown');
  const sKey = await slamWith('KeyS');
  await page.keyboard.press('ArrowDown');
  const g = await S(page);
  check('ArrowDown / S slam in the air (ignored on the ground)', down && sKey && g.grounded, { down, s: sKey, groundedAfterGroundPress: g.grounded });
  const muted0 = (await S(page)).muted;
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(80);
  const muted1 = (await S(page)).muted;
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(80);
  check('M toggles mute', muted1 === !muted0 && (await S(page)).muted === muted0, { before: muted0, after: muted1 });
  await page.keyboard.press('Escape');
  const escMs = await waitMode(page, 'paused', 500);
  await page.keyboard.press('KeyR');
  const rMs = await waitMode(page, 'playing', 600);
  const sR = await S(page);
  check('Esc pauses; R restarts from pause', escMs >= 0 && rMs >= 0 && sR.time < 0.6, { escMs: Math.round(escMs), rMs: Math.round(rMs), timeAfter: sR.time.toFixed(2) });
  await page.keyboard.press('KeyP');
  await waitMode(page, 'paused', 500);
  await page.keyboard.press('Escape');
  const escResume = await waitMode(page, 'playing', 2500);
  check('Esc in pause resumes (via 3-2-1)', escResume > 1000, `${Math.round(escResume)} ms`);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Space');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  const scroll = await page.evaluate(() => ({ y: window.scrollY, x: window.scrollX, se: (document.scrollingElement || document.body).scrollTop, prevented: window.__prevented }));
  check('Space / arrows never scroll the page (default prevented)', scroll.y === 0 && scroll.se === 0 && scroll.prevented.Space === true && scroll.prevented.ArrowDown === true && scroll.prevented.ArrowUp === true, scroll);
  check('no console errors/warnings (keyboard)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Touch + canvas buttons                                              */
/* ------------------------------------------------------------------ */
async function testTouch(url) {
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=14', { viewport: { width: 390, height: 844 }, touch: true, mobile: true, dpr: 2 });
  await page.waitForTimeout(500);
  // title buttons (sound / motion) are canvas buttons; tap elsewhere starts
  await page.touchscreen.tap(195, 470);
  const st = await waitMode(page, 'playing', 1000);
  check('touch tap on the title starts a run', st >= 0, `${Math.round(st)} ms`);
  await page.waitForTimeout(300);
  // Synthetic touch pointerdown + one sim step in the same task: the jump happens on that step.
  const same = await page.evaluate(() => {
    const H = window.__hippoRun;
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const s0 = H.getState();
    const p0 = s0.presses;
    c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.6, bubbles: true, cancelable: true }));
    H.advance(1 / 120);
    const s1 = H.getState();
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true }));
    return { grounded0: s0.grounded, consumed: s1.presses - p0, vy: s1.heroVy, y: s1.heroY };
  });
  check('touch pointerdown jumps on the same sim step it is consumed', same.grounded0 && same.consumed === 1 && same.vy < 0 && same.y > 0, same);
  await page.waitForTimeout(900);
  // Real touchscreen tap -> jump within a couple of frames.
  const p0 = (await S(page)).presses;
  await page.touchscreen.tap(250, 600);
  const jumped = await page.evaluate(
    () =>
      new Promise((res) => {
        let n = 0;
        const tick = () => {
          const s = window.__hippoRun.getState();
          if (s.heroVy < 0 || s.heroY > 0) return res(true);
          if (++n > 10) return res(false);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const p1 = (await S(page)).presses;
  check('page.touchscreen.tap during play = jump (pointerType touch)', jumped && p1 - p0 === 1, { jumped, consumed: p1 - p0 });
  await page.waitForTimeout(800);
  // HUD buttons: >= 48 CSS px, stable, never a jump.
  const samples = [];
  for (let i = 0; i < 6; i++) {
    samples.push(await page.evaluate(() => window.__hippoRun.getButtons()));
    await page.waitForTimeout(120);
  }
  const btns = samples[0];
  const pause = btns.find((b) => b.id === 'pause');
  const sound = btns.find((b) => b.id === 'sound');
  const stable = samples.every((s) => JSON.stringify(s) === JSON.stringify(btns));
  check('HUD pause + mute buttons visible and >= 48 CSS px', !!pause && !!sound && Math.min(pause.w, pause.h, sound.w, sound.h) >= 48, btns.map((b) => `${b.id} ${b.w.toFixed(0)}x${b.h.toFixed(0)}@${b.x.toFixed(0)},${b.y.toFixed(0)}`).join(' '));
  check('HUD buttons never move during play', stable, stable ? 'identical across 6 samples' : samples);
  const ms0 = await S(page);
  await page.touchscreen.tap(sound.x + sound.w / 2, sound.y + sound.h / 2);
  await page.waitForTimeout(60);
  const ms1 = await S(page);
  check('tapping the mute button toggles mute and never jumps', ms1.muted === !ms0.muted && ms1.presses === ms0.presses && ms1.grounded, { muted: [ms0.muted, ms1.muted], presses: [ms0.presses, ms1.presses], grounded: ms1.grounded });
  await page.touchscreen.tap(sound.x + sound.w / 2, sound.y + sound.h / 2);
  await page.waitForTimeout(60);
  const ps0 = await S(page);
  await page.touchscreen.tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
  const pm = await waitMode(page, 'paused', 300);
  const ps1 = await S(page);
  check('tapping the pause button pauses and never jumps', pm >= 0 && ps1.presses === ps0.presses && ps1.heroVy === 0, { pausedIn: Math.round(pm), presses: [ps0.presses, ps1.presses], vy: ps1.heroVy });
  const pb = await page.evaluate(() => window.__hippoRun.getButtons());
  check('pause menu buttons >= 48 CSS px', pb.length >= 4 && pb.every((b) => b.w >= 48 && b.h >= 48), pb.map((b) => `${b.id} ${b.w.toFixed(0)}x${b.h.toFixed(0)}`).join(' '));
  const resume = pb.find((b) => b.id === 'resume');
  await page.touchscreen.tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
  const rs = await waitMode(page, 'playing', 2500);
  check('tapping Resume -> 3-2-1 -> playing', rs > 1000, `${Math.round(rs)} ms`);
  // context menu / selection
  const cm = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    c.dispatchEvent(e);
    const cs = getComputedStyle(c);
    return { prevented: e.defaultPrevented, userSelect: cs.userSelect || cs.webkitUserSelect, touchAction: cs.touchAction };
  });
  check('no context menu, no text selection, touch-action none on the canvas', cm.prevented && cm.userSelect === 'none' && cm.touchAction === 'none', cm);
  check('no console errors/warnings (touch)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Persistence across reloads + reduced motion                         */
/* ------------------------------------------------------------------ */
async function testStorage(url) {
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=19');
  await page.waitForTimeout(400);
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(100);
  const tb = await page.evaluate(() => window.__hippoRun.getButtons());
  const motion = tb.find((b) => b.id === 'motion');
  const rm0 = (await S(page)).reducedMotion;
  if (motion) await page.mouse.click(motion.x + motion.w / 2, motion.y + motion.h / 2);
  await page.waitForTimeout(100);
  const sA = await S(page);
  check('title Reduced-motion button toggles the setting (no run started)', !!motion && sA.reducedMotion === !rm0 && sA.state === 'title', { motion: !!motion, rm: [rm0, sA.reducedMotion], state: sA.state });
  // Reduced motion in play: slam impact -> no shake, hit-stop <= 40 ms; death -> no slow-mo.
  await page.keyboard.press('Space');
  await waitMode(page, 'playing', 800);
  await lib(page);
  const rmPlay = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    H.advance(0.3);
    H.press();
    H.advance(0.3);
    H.release();
    H.press();
    H.release();
    let maxT = 0;
    let maxHS = 0;
    for (let i = 0; i < 60; i++) {
      H.advance(P.DT);
      const s = P.st();
      maxT = Math.max(maxT, s.trauma);
      maxHS = Math.max(maxHS, s.hitStop);
    }
    // die and watch timeScale
    let minTS = 1;
    for (let i = 0; i < 2400 && P.st().state === 'playing'; i++) H.advance(P.DT);
    for (let i = 0; i < 100; i++) {
      H.advance(P.DT);
      minTS = Math.min(minTS, P.st().timeScale);
    }
    for (let i = 0; i < 40 && P.st().state !== 'gameover'; i++) H.advance(0.25);
    return { maxTrauma: maxT, maxHitStop: +maxHS.toFixed(3), minTimeScale: minTS, state: P.st().state, score: P.st().score, best: P.st().best };
  });
  check('reduced motion: no shake, hit-stop <= 40 ms, no death slow-mo', rmPlay.maxTrauma === 0 && rmPlay.maxHitStop <= 0.04 && rmPlay.minTimeScale === 1, rmPlay);
  const ls = await page.evaluate(() => {
    try {
      return localStorage.getItem('hippotototo.v1');
    } catch (e) {
      return 'THROW ' + e;
    }
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__hippoRun);
  await page.waitForTimeout(300);
  const sB = await S(page);
  const saved = JSON.parse(ls || '{}');
  check('mute, reduced motion and best persist across a reload', sB.muted === true && sB.reducedMotion === sA.reducedMotion && sB.best === rmPlay.score && sB.best > 0 && saved.best === rmPlay.score, { afterReload: { muted: sB.muted, reducedMotion: sB.reducedMotion, best: sB.best, bestDist: sB.bestDist }, stored: saved });
  // Turn reduced motion off again and verify the normal juice exists (contrast).
  const tb2 = await page.evaluate(() => window.__hippoRun.getButtons());
  const m2 = tb2.find((b) => b.id === 'motion');
  if (m2) await page.mouse.click(m2.x + m2.w / 2, m2.y + m2.h / 2);
  await page.keyboard.press('Space');
  await waitMode(page, 'playing', 800);
  await lib(page);
  const full = await page.evaluate(() => {
    const P = window.__pt;
    const H = P.H;
    H.advance(0.3);
    H.press();
    H.advance(0.3);
    H.release();
    H.press();
    H.release();
    let maxT = 0;
    let maxHS = 0;
    for (let i = 0; i < 60; i++) {
      H.advance(P.DT);
      const s = P.st();
      maxT = Math.max(maxT, s.trauma);
      maxHS = Math.max(maxHS, s.hitStop);
    }
    let minTS = 1;
    for (let i = 0; i < 2400 && P.st().state === 'playing'; i++) H.advance(P.DT);
    for (let i = 0; i < 100; i++) {
      H.advance(P.DT);
      minTS = Math.min(minTS, P.st().timeScale);
    }
    return { rm: P.st().reducedMotion, maxTrauma: +maxT.toFixed(3), maxHitStop: +maxHS.toFixed(3), minTimeScale: minTS };
  });
  check('normal motion: slam shakes, 60 ms hit-stop, death slow-mo 0.25x', !full.rm && full.maxTrauma > 0.2 && full.maxHitStop >= 0.05 && full.minTimeScale <= 0.26, full);
  check('no console errors/warnings (storage)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* localStorage throwing + AudioContext missing                        */
/* ------------------------------------------------------------------ */
async function testSabotage(url) {
  const init = () => {
    const boom = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    try {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: boom });
    } catch (_e) {
      /* ignore */
    }
    try {
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined, writable: true });
      Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined, writable: true });
    } catch (_e) {
      /* ignore */
    }
  };
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=2', { init });
  const sab = await page.evaluate(() => {
    let ls = 'ok';
    try {
      void window.localStorage;
    } catch (_e) {
      ls = 'throws';
    }
    return { ls, ac: typeof window.AudioContext };
  });
  await page.keyboard.press('Space');
  const p = await waitMode(page, 'playing', 800);
  await page.waitForTimeout(800);
  await page.keyboard.press('KeyM');
  await page.keyboard.press('KeyP');
  const pz = await waitMode(page, 'paused', 400);
  await page.keyboard.press('KeyP');
  const rz = await waitMode(page, 'playing', 2500);
  await dieNow(page);
  await page.waitForTimeout(700);
  await page.keyboard.press('Space');
  const rt = await waitMode(page, 'playing', 600);
  await page.waitForTimeout(500);
  const s = await S(page);
  check('runs with localStorage throwing and no AudioContext', sab.ls === 'throws' && sab.ac === 'undefined' && p >= 0 && pz >= 0 && rz >= 0 && rt >= 0 && s.muted === true, { sabotage: sab, start: Math.round(p), pause: Math.round(pz), resume: Math.round(rz), retry: Math.round(rt), mutedInMemory: s.muted });
  check('no console errors/warnings / page errors with storage + audio sabotaged', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Viewports: portrait 390x844 + landscape 1366x768                    */
/* ------------------------------------------------------------------ */
async function testViewport(url) {
  for (const vp of [
    { width: 390, height: 844, touch: true },
    { width: 1366, height: 768, touch: false },
  ]) {
    const { ctx, page, msgs } = await openPage(url, { viewport: { width: vp.width, height: vp.height }, touch: vp.touch, mobile: vp.touch, dpr: vp.touch ? 2 : 1 });
    await page.keyboard.press('Space');
    await waitMode(page, 'playing', 800);
    await page.waitForTimeout(600);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Space');
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const se = document.scrollingElement || document.documentElement;
      const c = document.querySelector('canvas').getBoundingClientRect();
      const s = window.__hippoRun.getState();
      const meta = (document.querySelector('meta[name=viewport]') || {}).content || '';
      return {
        scrollH: se.scrollHeight,
        scrollW: se.scrollWidth,
        innerH: innerHeight,
        innerW: innerWidth,
        scrollY: scrollY,
        canvas: [Math.round(c.left), Math.round(c.top), Math.round(c.width), Math.round(c.height)],
        lookAhead: Math.round(s.viewW - s.heroScreenX),
        viewW: Math.round(s.viewW),
        viewH: Math.round(s.viewH),
        meta,
      };
    });
    const noScroll = r.scrollH <= r.innerH + 1 && r.scrollW <= r.innerW + 1 && r.scrollY === 0;
    const fills = r.canvas[0] === 0 && r.canvas[1] === 0 && r.canvas[2] === vp.width && r.canvas[3] === vp.height;
    const noZoom = /user-scalable=no|maximum-scale=1/.test(r.meta);
    check(`${vp.width}x${vp.height}: no page scroll, canvas fills viewport, pinch zoom disabled`, noScroll && fills && noZoom, r);
    check(`${vp.width}x${vp.height}: look-ahead >= 593 u`, r.lookAhead >= 593, `${r.lookAhead} u (view ${r.viewW}x${r.viewH})`);
    check(`${vp.width}x${vp.height}: no console errors/warnings`, msgs.length === 0, msgs.join(' || ') || 'none');
    await ctx.close();
  }
}

/* ------------------------------------------------------------------ */
/* Auto-pause on blur / hidden; never auto-resumes                     */
/* ------------------------------------------------------------------ */
async function testPause(url) {
  const { ctx, page, msgs } = await openPage(url);
  await page.keyboard.press('Space');
  await waitMode(page, 'playing', 800);
  await page.waitForTimeout(400);
  const blur = await page.evaluate(
    () =>
      new Promise((res) => {
        window.dispatchEvent(new Event('blur'));
        requestAnimationFrame(() => res(window.__hippoRun.getState().state));
      }),
  );
  await page.waitForTimeout(1500);
  const still = (await S(page)).state;
  check('window blur pauses within one frame and never auto-resumes', blur === 'paused' && still === 'paused', { nextFrame: blur, after1500ms: still });
  await page.keyboard.press('KeyP');
  const resumeMs = await waitMode(page, 'playing', 2500);
  check('resume after blur shows the 3-2-1 (~1.2 s)', resumeMs > 1000 && resumeMs < 1700, `${Math.round(resumeMs)} ms`);
  const hidden = await page.evaluate(
    () =>
      new Promise((res) => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        requestAnimationFrame(() => {
          const st = window.__hippoRun.getState().state;
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
          document.dispatchEvent(new Event('visibilitychange'));
          res(st);
        });
      }),
  );
  await page.waitForTimeout(1200);
  const still2 = (await S(page)).state;
  check('hidden tab pauses within one frame; visible again does not resume', hidden === 'paused' && still2 === 'paused', { nextFrame: hidden, afterVisible: still2 });
  // Esc during the 3-2-1 cancels the countdown (stays paused); the next Esc/P starts it again.
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(400);
  const counting = (await S(page)).state;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  const afterEsc = (await S(page)).state;
  await page.keyboard.press('KeyP');
  const reResume = await waitMode(page, 'playing', 2500);
  check('Esc during the 3-2-1 cancels it: still paused 1.5 s later (P then resumes)', counting === 'paused' && afterEsc === 'paused' && reResume > 0, { during321: counting, after1500ms: afterEsc, resumedAfterP: Math.round(reResume) + ' ms' });
  check('no console errors/warnings (pause)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Next: destroy -> re-mount leaves one loop / one AudioContext / one  */
/* listener set (client-side navigation away and back)                 */
/* ------------------------------------------------------------------ */
async function testRemount(base) {
  const init = () => {
    const w = window;
    w.__probe = { raf: 0, acLive: 0, acMade: 0, keydown: 0 };
    const raf = w.requestAnimationFrame.bind(w);
    w.requestAnimationFrame = (cb) => raf((t) => {
      w.__probe.raf++;
      cb(t);
    });
    const AC = w.AudioContext;
    if (AC) {
      w.AudioContext = function (...a) {
        const c = new AC(...a);
        w.__probe.acMade++;
        w.__probe.acLive++;
        const close = c.close.bind(c);
        c.close = () => {
          w.__probe.acLive--;
          return close();
        };
        return c;
      };
      w.AudioContext.prototype = AC.prototype;
    }
    const add = w.addEventListener.bind(w);
    const rem = w.removeEventListener.bind(w);
    w.addEventListener = (t, f, o) => {
      if (t === 'keydown') w.__probe.keydown++;
      return add(t, f, o);
    };
    w.removeEventListener = (t, f, o) => {
      if (t === 'keydown') w.__probe.keydown--;
      return rem(t, f, o);
    };
  };
  const { ctx, page, msgs } = await openPage(base + '/play', { init });
  const rate = async () => {
    const a = await page.evaluate(() => window.__probe.raf);
    await page.waitForTimeout(1000);
    const b = await page.evaluate(() => window.__probe.raf);
    return b - a;
  };
  await page.keyboard.press('Space'); // gesture -> AudioContext
  await page.waitForTimeout(500);
  const p1 = await page.evaluate(() => ({ ...window.__probe }));
  const r1 = await rate();
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(150);
  await page.click('text=Back to site');
  await page.waitForURL((u) => !u.pathname.startsWith('/play'), { timeout: 10000 });
  await page.waitForTimeout(600);
  const away = await page.evaluate(() => ({ ...window.__probe, api: !!window.__hippoRun }));
  await page.click('a[href="/play"]');
  await page.waitForURL((u) => u.pathname.startsWith('/play'), { timeout: 10000 });
  await page.waitForFunction(() => !!window.__hippoRun);
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const p2 = await page.evaluate(() => ({ ...window.__probe }));
  const r2 = await rate();
  check('client-side unmount destroys the game (no API, no live AudioContext)', !away.api && away.acLive === 0, away);
  check('re-mount: one rAF loop (~60/s), one live AudioContext, same keydown listener count', r2 < 90 && r2 > 30 && p2.acLive <= 1 && p2.keydown === p1.keydown, { rafPerSec: [r1, r2], acLive: [p1.acLive, p2.acLive], acMade: p2.acMade, keydown: [p1.keydown, away.keydown, p2.keydown] });
  check('no console errors/warnings (remount)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/** Header attributes the game toggles while /play is mounted. */
const headerAttrs = () => {
  const h = document.querySelector('header');
  return h ? { inert: h.hasAttribute('inert'), ariaHidden: h.getAttribute('aria-hidden') } : null;
};

/**
 * Next only: keyboard path out of /play. The site header under the fullscreen game is inert, so
 * the first Tab stop is the visible "Back to site" link; Enter on it navigates to "/" (the game
 * leaves keys aimed at page controls alone), and the header is interactive again there.
 */
async function testSiteNav(base) {
  const { ctx, page, msgs } = await openPage(base + '/play');
  const hdr = await page.evaluate(headerAttrs);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a ? a.tagName : null, text: a ? (a.textContent || '').trim() : null, href: a && a.getAttribute ? a.getAttribute('href') : null, inHeader: !!(a && a.closest && a.closest('header')) };
  });
  check('/play: site header is inert + aria-hidden; first Tab stop is "Back to site"', !!hdr && hdr.inert && hdr.ariaHidden === 'true' && /Back to site/.test(focused.text || '') && !focused.inHeader, { header: hdr, firstTab: focused });
  const st = (await S(page)).state;
  await page.keyboard.press('Enter');
  let navigated = true;
  try {
    await page.waitForURL((u) => u.pathname === '/', { timeout: 8000 });
  } catch (_e) {
    navigated = false;
  }
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const h = document.querySelector('header');
    const a = h && h.querySelector('a[href="/play"]');
    if (a) a.focus();
    return { path: location.pathname, api: !!window.__hippoRun, focusable: !!a && document.activeElement === a };
  });
  const hdr2 = await page.evaluate(headerAttrs);
  check('Enter on the focused "Back to site" link navigates to "/"', navigated && after.path === '/' && !after.api, { gameStateBeforeEnter: st, path: after.path, apiLeft: after.api });
  check('back on "/": the site header is interactive again (no inert / aria-hidden, links take focus)', !!hdr2 && !hdr2.inert && hdr2.ariaHidden === null && after.focusable, { header: hdr2, headerLinkFocusable: after.focusable });
  check('no console errors/warnings (site navigation)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/** Next only: the header logo link is prefetched again ("/" RSC payload) on a regular site page. */
async function testLogoPrefetch(base) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const rsc = [];
  page.on('request', (r) => {
    let u;
    try {
      u = new URL(r.url());
    } catch (_e) {
      return;
    }
    const h = r.headers();
    if (u.pathname === '/' && (h.rsc === '1' || u.searchParams.has('_rsc'))) rsc.push({ prefetch: h['next-router-prefetch'] || null, url: u.pathname + u.search });
  });
  await page.goto(base + '/signin', { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.hover('header a[href="/"]');
  await page.waitForTimeout(1200);
  // `next dev` never prefetches (unhashed dev chunk names give it away): report only.
  const dev = await page.evaluate(() => Array.from(document.scripts).some((s) => /\/_next\/static\/chunks\/(webpack|main-app)\.js(\?|$)|turbopack/.test(s.src)));
  if (dev) info('/signin: hovering the header logo has "/" prefetched (RSC request)', `dev server (no prefetching in development); RSC requests seen: ${rsc.length}`);
  else check('/signin: hovering the header logo has "/" prefetched (RSC request)', rsc.length > 0, rsc.length ? rsc.slice(0, 3) : 'no RSC request for /');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Both builds run the same engine: identical deterministic run         */
/* ------------------------------------------------------------------ */
async function parityRun(url) {
  const { ctx, page } = await openPage(url);
  const r = await page.evaluate(() => {
    const H = window.__hippoRun;
    H.forceSeed(99);
    H.restart();
    H.setAutopilot(true);
    H.advance(45);
    const s = H.getState();
    return { score: s.score, distance: +s.distance.toFixed(3), entities: s.entities, state: s.state };
  });
  await ctx.close();
  return r;
}

/* ------------------------------------------------------------------ */
/* Human-like real-time play: reactive bot sending real key events     */
/* ------------------------------------------------------------------ */
async function testHuman(url) {
  const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=5');
  await page.keyboard.press('Space');
  await waitMode(page, 'playing', 800);
  const r = await page.evaluate(
    (secs) =>
      new Promise((res) => {
        const H = window.__hippoRun;
        const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true }));
        const log = { presses: 0, slams: 0, boings: 0, deaths: 0, causes: [], retries: 0, lat: [], latHitStop: [], latFreeze: [], maxChain: 0, maxScore: 0, missed: 0 };
        let holdUntil = 0;
        let pending = null; // { t, kind }
        let lastAction = 0;
        let mode = 'none';
        let slammedThisAir = false;
        const t0 = performance.now();
        const p0 = H.getState().presses;
        let sent = 0;
        const press = (now, kind, hold) => {
          key('keydown', 'Space');
          sent++;
          holdUntil = now + hold;
          const s0 = H.getState();
          pending = { t: now, kind, hs: s0.hitStop > 0, fr: s0.freeze, ts: s0.timeScale };
          lastAction = now;
        };
        const tick = () => {
          const now = performance.now();
          const s = H.getState();
          log.maxChain = Math.max(log.maxChain, s.chain);
          log.maxScore = Math.max(log.maxScore, s.score);
          if (holdUntil && now >= holdUntil) {
            key('keyup', 'Space');
            holdUntil = 0;
          }
          if (pending && pending.kind === 'jump' && now > pending.t) {
            // a jump press must show up on the very next rendered frame
            if (s.heroVy < 0 && !s.grounded) {
              (pending.hs ? log.latHitStop : log.lat).push(Math.round(now - pending.t));
              if (pending.fr) log.latFreeze.push(Math.round(now - pending.t));
              pending = null;
            } else if (now - pending.t > 100) {
              log.missed++;
              pending = null;
            }
          } else if (pending && pending.kind !== 'jump') pending = null;
          if (s.state === 'gameover') {
            if (s.time > 0 && mode !== 'dead') {
              log.deaths++;
              log.causes.push(s.deathCause + '@' + s.time.toFixed(1));
              mode = 'dead';
            }
            if (now - lastAction > 900) {
              key('keydown', 'Space');
              key('keyup', 'Space');
              lastAction = now;
              log.retries++;
              mode = 'none';
            }
          } else if (s.state === 'playing' && !holdUntil && now - lastAction > 90) {
            if (s.grounded) slammedThisAir = false;
            const ents = H.getEntities();
            const v = s.speed;
            const front = s.heroX + 24;
            let threat = null;
            let drumT = 99;
            for (const e of ents) {
              if (e.flag !== 'none') continue;
              if ((e.kind === 'bush' || e.kind === 'mound' || e.kind === 'log') && e.x + e.w > s.heroX - 20) {
                const tt = (e.x - front) / (v - e.vx);
                if (tt > -0.2 && (!threat || tt < threat.tt)) threat = { tt, kind: e.kind };
              }
              if (e.kind === 'pit' && e.x + e.w > s.heroX) {
                const tt = (e.x + 6 - s.heroX) / v;
                if (tt > -0.05 && (!threat || tt < threat.tt)) threat = { tt, kind: 'pit' };
              }
              if (e.kind === 'drum' && e.x > s.heroX) drumT = Math.min(drumT, (e.x + e.w / 2 - s.heroX) / v);
            }
            if (s.grounded) {
              const lead = threat ? (threat.kind === 'pit' ? 0.05 : threat.kind === 'bush' ? 0.2 : 0.28) : 0;
              if (threat && threat.tt < lead) press(now, 'jump', 330);
              else if (drumT > 0.575 && drumT < 0.625) press(now, 'jump', 330);
            } else if (!slammedThisAir && s.heroVy > -140 && s.heroY > 60) {
              // BOOM: slam when the dive would land on a drum top
              const tDive = 0.05 + Math.max(0, s.heroY - 40) / 1500;
              const lx = s.heroX + v * tDive;
              const boomDrum = ents.some((e) => e.kind === 'drum' && e.flag === 'none' && lx > e.x - 4 && lx < e.x + e.w + 4);
              if (boomDrum) {
                press(now, 'slam', 40);
                slammedThisAir = true;
                log.slams++;
              } else if (s.heroY > 110 && (!threat || threat.tt > 1.0) && drumT > 1.2) {
                // show off on clear ground: slam from the apex, then BOING out of it
                press(now, 'slam', 40);
                slammedThisAir = true;
                log.slams++;
                setTimeout(() => {
                  key('keydown', 'Space');
                  sent++;
                  key('keyup', 'Space');
                  log.boings++;
                }, 90);
              }
            }
          }
          if (now - t0 < secs * 1000) requestAnimationFrame(tick);
          else {
            key('keyup', 'Space');
            const s2 = H.getState();
            log.consumed = s2.presses - p0;
            log.sent = sent;
            log.final = { state: s2.state, score: s2.score, dist: Math.round(s2.distance) };
            res(log);
          }
        };
        requestAnimationFrame(tick);
      }),
    20,
  );
  const lat = r.lat.slice().sort((a, b) => a - b);
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : -1;
  check(
    'human-like real-time play: every jump press shows on screen within 2 frames (none missed)',
    r.missed === 0 && lat.length > 3 && lat[lat.length - 1] <= 34,
    `jumps ${lat.length}, latency median ${lat[lat.length >> 1]} ms, p95 ${p95} ms, max ${lat[lat.length - 1]} ms, missed ${r.missed}; during teaching freeze [${r.latFreeze.join(',')}] ms; pressed during hit-stop (sim frozen by design) [${r.latHitStop.join(',')}] ms`,
  );
  check('human-like play: no dropped inputs (presses consumed in play <= sent; retries are menu presses)', r.consumed + r.retries >= r.sent - 1 && r.consumed <= r.sent, { sent: r.sent, consumedInPlay: r.consumed, retries: r.retries });
  info('human-like play summary (20 s real time)', { slams: r.slams, boings: r.boings, deaths: r.deaths, causes: r.causes, maxChain: r.maxChain, maxScore: r.maxScore, final: r.final });
  check('no console errors/warnings (human play)', msgs.length === 0, msgs.join(' || ') || 'none');
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Real-time fps (autopilot + invincible so the run keeps going)       */
/* ------------------------------------------------------------------ */
async function testFps(url, seconds) {
  const out = [];
  for (const vp of [
    { width: 1366, height: 768, dpr: 1 },
    { width: 1280, height: 720, dpr: 1 },
    { width: 390, height: 844, dpr: 2 },
  ]) {
    const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=8', { viewport: { width: vp.width, height: vp.height }, dpr: vp.dpr });
    await page.keyboard.press('Space');
    await waitMode(page, 'playing', 800);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const r = await page.evaluate(
      (secs) =>
        new Promise((res) => {
          const H = window.__hippoRun;
          H.setInvincible(true);
          H.setAutopilot(true);
          let frames = 0;
          let worst = 0;
          let last = performance.now();
          const t0 = last;
          const tick = (t) => {
            frames++;
            const d = t - last;
            if (frames > 2 && d > worst) worst = d;
            last = t;
            if (t - t0 < secs * 1000) requestAnimationFrame(tick);
            else {
              const s = H.getState();
              res({ avg: (frames * 1000) / (t - t0), worst, engineFps: s.fps, dist: Math.round(s.distance), lowQuality: null });
            }
          };
          requestAnimationFrame(tick);
        }),
      seconds,
    );
    const m = await cdp.send('Performance.getMetrics');
    const heap = m.metrics.find((x) => x.name === 'JSHeapUsedSize');
    out.push({ vp, ...r, heapMB: heap ? +(heap.value / 1048576).toFixed(1) : null });
    check(`real-time fps >= 55 at ${vp.width}x${vp.height} DPR ${vp.dpr} (${seconds} s, autopilot)`, r.avg >= 55, `avg ${r.avg.toFixed(1)} fps, worst frame ${r.worst.toFixed(1)} ms, engine fps ${r.engineFps}, ${r.dist} m`);
    check(`no console errors/warnings (fps ${vp.width}x${vp.height})`, msgs.length === 0, msgs.join(' || ') || 'none');
    await ctx.close();
  }
  return out;
}

/*
 * Heap: retained growth after a forced GC across 20 s of play must stay small (no leak / no
 * retained per-frame garbage). Young-generation churn is reported: it is V8 HeapNumber boxing of
 * fractional arguments passed to canvas 2D calls (no objects, arrays, closures or strings).
 */
async function testHeap(url) {
  const { ctx, page } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=8');
  await page.keyboard.press('Space');
  await waitMode(page, 'playing', 800);
  await page.evaluate(() => {
    window.__hippoRun.setInvincible(true);
    window.__hippoRun.setAutopilot(true);
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  const used = async () => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === 'JSHeapUsedSize').value;
  await page.waitForTimeout(3000); // warm-up (JIT tiers)
  await cdp.send('HeapProfiler.collectGarbage');
  const base = await used();
  let churn = 0;
  let prev = base;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await page.waitForTimeout(100);
    const u = await used();
    if (u > prev) churn += u - prev;
    prev = u;
  }
  await cdp.send('HeapProfiler.collectGarbage');
  const after = await used();
  const growthKB = (after - base) / 1024;
  check('heap: no retained growth over 20 s of play (after forced GC)', growthKB < 512, `retained ${growthKB.toFixed(0)} KB (base ${(base / 1048576).toFixed(1)} MB)`);
  info('heap: young-generation churn (HeapNumber boxing of canvas-call args; scavenged)', `~${(churn / 1024 / 20).toFixed(0)} KB/s`);
  await ctx.close();
}

/* ------------------------------------------------------------------ */
/* Screenshots for humans                                              */
/* ------------------------------------------------------------------ */
async function takeShots(url, dir) {
  mkdirSync(dir, { recursive: true });
  for (const vp of [
    { tag: 'land', width: 1366, height: 768 },
    { tag: 'port', width: 390, height: 844 },
  ]) {
    const init = () => {
      try {
        localStorage.setItem('hippotototo.v1', JSON.stringify({ v: 1, best: 2400, bestDist: 150, bestChain: 4, runs: 3, totalMangoes: 30, muted: true, reducedMotion: false, tutorialSeen: true, goalIndex: 1 }));
      } catch (_e) {
        /* ignore */
      }
    };
    const { ctx, page, msgs } = await openPage(url + (url.includes('?') ? '&' : '?') + 'seed=21', { viewport: { width: vp.width, height: vp.height }, init });
    const shot = (name) => page.screenshot({ path: join(dir, `${vp.tag}_${name}.png`) });
    await page.waitForTimeout(1600);
    await shot('01_title');
    await page.keyboard.press('Space');
    await waitMode(page, 'playing', 800);
    await lib(page);
    // early gameplay: mid hop over the opening mango arc
    await page.evaluate(() => {
      const H = window.__hippoRun;
      H.advance(1.05);
      H.press();
      H.advance(0.2);
      H.release();
      H.advance(0.05);
    });
    await shot('02_early_jump');
    // drum chain: autopilot for hazards + jump onto drum lines; capture right after a chained bounce
    const chain = await page.evaluate(() => {
      const P = window.__pt;
      const H = P.H;
      H.setAutopilot(true);
      for (let i = 0; i < 120 * 90; i++) {
        const s = P.st();
        if (s.state !== 'playing') return s;
        if (s.grounded) {
          const d = P.ents('drum').filter((e) => e.x > s.heroX)[0];
          if (d && Math.abs((d.x + d.w / 2 - s.heroX) / s.speed - 0.6) < 0.006) {
            H.press();
          }
        } else if (s.heroVy > 0) H.release();
        const c = s.chain;
        H.advance(P.DT);
        const s2 = P.st();
        if (s2.chain >= 2 && s2.chain > c) {
          H.advance(0.06);
          H.release();
          return s2;
        }
      }
      return P.st();
    });
    await page.waitForTimeout(30);
    await shot('03_drum_chain');
    info(`screenshot ${vp.tag} drum chain`, { chain: chain.chain, t: chain.time && chain.time.toFixed(1) });
    // phases via invincible + autopilot advance
    for (const [name, m] of [
      ['04_noon', 340],
      ['05_dusk', 590],
      ['06_night', 840],
    ]) {
      await page.evaluate((target) => {
        const H = window.__hippoRun;
        H.setInvincible(true);
        H.setAutopilot(true);
        for (let i = 0; i < 2000 && H.getState().distance < target; i++) H.advance(0.25);
      }, m);
      await page.waitForTimeout(250);
      await shot(name);
    }
    await page.evaluate(() => {
      const H = window.__hippoRun;
      H.setGroove(100);
      H.advance(1.2);
    });
    await page.waitForTimeout(350);
    await shot('07_tototo_time');
    await page.evaluate(() => window.__hippoRun.advance(6));
    await page.keyboard.press('KeyP');
    await waitMode(page, 'paused', 500);
    await page.waitForTimeout(500);
    await shot('08_pause');
    await page.evaluate(() => {
      const H = window.__hippoRun;
      H.resume();
      H.setInvincible(false);
      H.setAutopilot(false);
      for (let i = 0; i < 240 && H.getState().state !== 'gameover'; i++) H.advance(0.25);
    });
    await page.waitForTimeout(1700);
    await shot('09_gameover');
    check(`screenshots ${vp.tag} (${vp.width}x${vp.height}) without console errors`, msgs.length === 0, msgs.join(' || ') || `saved to ${dir}`);
    await ctx.close();
  }
}

/* ------------------------------------------------------------------ */
/* Next server                                                         */
/* ------------------------------------------------------------------ */
/** True when nothing listens on the port (so a stale server cannot answer for ours). */
function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function startServer(port0) {
  if (!existsSync(join(ROOT, '.next', 'BUILD_ID'))) throw new Error('No production build: run `pnpm build` first (or pass --url).');
  let port = port0;
  while (!(await portFree(port))) {
    console.log(`port ${port} is busy (another server?) -> trying ${port + 1}`);
    port++;
    if (port > port0 + 50) throw new Error('no free port');
  }
  const child = spawn('pnpm', ['start', '-p', String(port)], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let exited = false;
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('exit', () => (exited = true));
  const base = `http://localhost:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !exited) {
    try {
      const r = await fetch(base + '/play');
      if (r.ok && /Ready|started|Local/i.test(log)) return { child, base };
    } catch (_e) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    process.kill(-child.pid);
  } catch (_e) {
    /* ignore */
  }
  throw new Error('next start did not come up:\n' + log);
}

/** SIGTERM the server's process group, then SIGKILL whatever is left after 1.5 s. */
async function stopServer(child) {
  const sig = (s) => {
    try {
      process.kill(-child.pid, s);
      return true;
    } catch (_e) {
      return false; // group already gone
    }
  };
  if (!sig('SIGTERM')) return;
  await new Promise((r) => setTimeout(r, 1500));
  sig('SIGKILL');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function runTarget(name, url, isNext) {
  currentTarget = name;
  console.log(`\n=== ${name}: ${url} ===`);
  if (want('console')) {
    await guard('console journey', () => testConsole(url));
    await guard('seed param', () => testSeedParam(url));
  }
  if (want('rules')) {
    await guard('rules', () => testRules(url));
    await guard('tap lesson', () => testTapLesson(url));
    await guard('masher + bubbles', () => testMasher(url));
  }
  if (want('physics')) await guard('physics', () => testPhysics(url));
  if (want('mud')) await guard('mud', () => testMud(url));
  if (want('fever')) await guard('fever', () => testFever(url));
  if (want('flag')) await guard('best flag', () => testFlag(url));
  if (want('keyboard')) {
    await guard('keyboard', () => testKeyboard(url));
    if (isNext) await guard('site navigation', () => testSiteNav(url.replace(/\/play$/, '')));
  }
  if (want('touch')) await guard('touch', () => testTouch(url));
  if (want('storage')) await guard('storage', () => testStorage(url));
  if (want('sabotage')) await guard('sabotage', () => testSabotage(url));
  if (want('viewport')) await guard('viewport', () => testViewport(url));
  if (want('pause')) await guard('pause', () => testPause(url));
  if (isNext && want('remount')) {
    await guard('remount', () => testRemount(url.replace(/\/play$/, '')));
    await guard('logo prefetch', () => testLogoPrefetch(url.replace(/\/play$/, '')));
  }
  if (want('human')) await guard('human play', () => testHuman(url));
  if (want('fps')) {
    await guard('fps', () => testFps(url, OPT.fpsSeconds));
    await guard('heap', () => testHeap(url));
  }
}

async function main() {
  const t0 = Date.now();
  browser = await chromium.launch();
  let server = null;
  const fileUrl = pathToFileURL(PLAY_HTML).href;
  try {
    if (want('static')) await guard('static', testStatic);
    if (!OPT.noFile) await runTarget('standalone', fileUrl, false);
    let nextUrl = null;
    if (!OPT.noNext) {
      let base = OPT.url;
      if (!base) {
        server = await startServer(OPT.port);
        base = server.base;
      }
      base = String(base).replace(/\/$/, '');
      nextUrl = base + '/play';
      await runTarget('next', nextUrl, true);
    }
    if (want('parity') && nextUrl && !OPT.noFile) {
      currentTarget = 'both';
      await guard('parity', async () => {
        const a = await parityRun(fileUrl);
        const b = await parityRun(nextUrl);
        check('/play and /play.html run the same engine (identical seeded autopilot run)', JSON.stringify(a) === JSON.stringify(b), { standalone: a, next: b });
      });
    }
    if (OPT.shots && want('shots')) {
      currentTarget = 'standalone';
      await guard('screenshots', () => takeShots(fileUrl, resolve(String(OPT.shots))));
    }
  } finally {
    await browser.close();
    if (server) await stopServer(server.child);
  }
  const failed = results.filter((r) => r.pass === false);
  const passed = results.filter((r) => r.pass === true);
  const outDir = OPT.shots ? resolve(String(OPT.shots)) : tmpdir();
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'playtest-report.json');
  writeFileSync(reportPath, JSON.stringify({ date: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, passed: passed.length, failed: failed.length, results }, null, 2));
  console.log(`\n${passed.length} passed, ${failed.length} failed in ${((Date.now() - t0) / 1000).toFixed(0)} s. Report: ${reportPath}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL [${f.target}] ${f.name} — ${f.evidence}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
