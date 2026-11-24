# Hippo Tototo — module contracts

**Status: shipped.** Values quoted here reflect the shipped tuning in `config.ts` (which wins on any number). The spec (`docs/GAME_DESIGN.md`) is the source of truth for **what** the game does. This file is the source of truth for **how the modules fit together** (written for the parallel build phase; the ownership table and rules still apply to later changes). If the two disagree on a cross-module detail, this file wins; flag it in your report.

---

## 1. Ownership

| File | Owner | Status after foundation | Notes |
|---|---|---|---|
| `types.ts` | GAMEPLAY | complete | ADDITIVE changes only (new fields / union members). Never rename/remove. |
| `config.ts` | GAMEPLAY | complete | ADDITIVE only. Others: ask for keys in your report, or keep private constants in your own file. |
| `state.ts` | GAMEPLAY | complete | `createGameState`, `resetRun`, `computeView`, shared spec formulas (`speedAt`, `multiplierFor`, `ladderIndex`, `hueIndex`, `medalFor`, `phaseAt`, ...). |
| `geom.ts` | GAMEPLAY | complete | Hurtbox/hitbox rules. Render uses it read-only for the debug overlay. |
| `rng.ts` | GAMEPLAY | complete | mulberry32 streams, `hash01` for decoration, `parseSeedParam`. |
| `storage.ts` | GAMEPLAY | complete | `hippotototo.v1`, try/catch + in-memory fallback. |
| `hero.ts` | GAMEPLAY | stub | Internal signatures may change freely (gameplay owns all callers). |
| `world.ts` | GAMEPLAY | stub (+ complete `spawnEntity`, `spawnGallery`) | idem |
| `game.ts` | GAMEPLAY | skeleton (lifecycle/loop/menus/debug API real) | Fill `TODO(gameplay)`. Keep the call order in its header. |
| `index.ts` | GAMEPLAY | complete | `export { createGame }` + types. |
| `render.ts` | ART | placeholder stub | `createRenderer(ctx, fx, crng): Renderer` |
| `fx.ts` | ART | stub (shake math real) | `createFx(state, crng): FxApi` |
| `audio.ts` | AUDIO | silent stub (beat clock real) | `createAudio(): AudioApi` |
| `input.ts` | UI | functional minimal | `createInput(canvas, hooks): InputApi` |
| `ui.ts` | UI | placeholder stub | `createUI({ standalone }): UiApi` |
| `hippo-run-client.tsx`, `app/play/page.tsx`, `scripts/build-standalone.mjs` | FOUNDATION (done) | complete | Change only with a reason in your report. |

You may add **private** helper files inside `components/hippo-run/` (e.g. `render-toto.ts`, `audio-music.ts`); prefix them with your module name, `.ts` only (the standalone build bundles every `.ts` in the folder). Never edit a file you don't own; never `git commit`/`push`.

The exported factory signatures (`createRenderer`, `createFx`, `createAudio`, `createInput`, `createUI`) and every interface in `types.ts` are FROZEN for the parallel phase. `game.ts` calls exactly these.

---

## 2. Ground rules (all modules)

- **No new npm deps, no asset files, no network URLs** (the standalone build fails on any `http://`/`https://` string, `<link`, `<img` or `<script src`).
- **TypeScript** (`strict`, `isolatedModules`, `target: es5`): `import type` for types; relative imports without extension (`./config`); no `for...of`/spread over `Map`/`Set`/iterators; no `const enum`, no namespaces, no `@/` alias, no React/Next outside `hippo-run-client.tsx`.
- **No DOM / `window` / `AudioContext` access at module top level.** Modules are evaluated during Next SSR. Touch the DOM only inside factories/handlers.
- **No module-level mutable state that outlives a game instance** (StrictMode mounts twice; two instances could coexist). Keep state in factory closures or `GameState`. Module-level *scratch* objects that carry nothing between calls (e.g. a reusable `Box`) are fine.
- **No circular imports.** Dependency direction: `types/config` <- `rng/storage/geom/state` <- `hero/world/fx/audio/input/render/ui` <- `game` <- `index`. `render` may import `geom`/`state`/`rng`; nobody imports `game`.
- **Hot paths allocate nothing**: per sim step and per frame there is no `new`, no `{}`/`[]` literal, no closure creation, no string concatenation/template, no `Array` methods that allocate (`map/filter/slice/concat`), no `forEach` with inline lambdas. Index-based `for` loops. Pools are created once in factories. Event-time work (a popup string, a sound's oscillator nodes) is fine: events are rare.
- **Randomness**: course generation uses `sv.rng` ONLY. Everything cosmetic uses the cosmetic stream (`crng`) or `hash01`. Never `Math.random()` (it would break "same seed = same visuals" debugging, and the course must never depend on visuals).
- **Never throw out of a frame.** Wrap browser APIs that may be missing (AudioContext, clipboard, vibrate, matchMedia, localStorage) in try/catch.
- Keep the tree compiling: run `npx tsc --noEmit -p tsconfig.json` before handing off; `pnpm build` must pass.

---

## 3. Coordinates and units

- World units **u**; **1 m = 50 u**; **y grows downward**; `GROUND_Y = 430`; logical view height 540.
- **World x = 0 at the hero's start position every run.** `run.distance (m) = hero.x / 50`. Best flag at `x = save.bestDist * 50`.
- **Hero origin = feet centre** `(hero.x, hero.y)`; `hero.y === GROUND_Y` when standing. Sprite 76×60 drawn around it; hurtbox from `geom.heroHurtbox`.
- **Entity box** `(x, y, w, h)` = drawn bounding box, **left/top**, world u (per-kind placement in `types.ts` `Entity` doc). Hitboxes come from `geom.entityHitbox` (never stored).
- **Camera**: `cam.x` = world x of the view's left edge = `hero.x - view.heroX` (gameplay writes it in the world step). `cam.prevX` is the previous step's value.
- **World -> logical (screen)**: `lx = worldX - camX`, `ly = worldY + view.offsetY`, where `camX = lerp(cam.prevX, cam.x, alpha)`; add `cam.shakeX/shakeY` to world layers only (not HUD). The hero is always at `lx = view.heroX`; `ly = lerp(hero.prevY, hero.y, alpha) + offsetY`.
- **Logical -> device**: base transform `ctx.setTransform(dpr*s, 0, 0, dpr*s, dpr*padX, 0)`. `padX` (CSS px) is non-zero only when pillarboxed (view capped at 1300×480; sides filled `#0B0B1E` by render).
- **CSS px (pointer) -> logical**: `lx = (cssX - padX) / s`, `ly = cssY / s` (game.ts does this before `ui.hitTest`).
- `offsetY > 0` in portrait (extra sky above, soil below); `< 0` on very short screens (crops sky). Sky and soil fills must cover `0..viewW × 0..viewH` in logical space.
- HUD uses logical space too, inside `view.safeL/R/T/B` (already in logical units). Buttons >= `48 / view.s` logical.
- Parallax layer x for factor `f`: `lx = layerWorldX - camX * f`.

---

## 4. GameState — the one mutable object

Created once per `createGame` (`createGameState`), reset **in place** by `resetRun` on every start/restart, never replaced: modules may keep the reference. Pools (`entities` 96, `mangoes` 160) are allocated once.

**Who writes what** (everything else is read-only for that module):

| Writer | Fields |
|---|---|
| GAMEPLAY (`game/hero/world`) | everything not listed below: `mode, modeT, seed, nextSeed, firstRun, hero.*, run.*, fever.*, phase.*, entities[], mangoes[], entityCount, mangoCount, timeScale, hitStop, deathCause, tutorial.*, pause.*, banner.*, toast.*, summary.*, save.*, lastDevice, debug.*, cam.x, cam.prevX` |
| Shell (`game.ts`, gameplay-owned) | `view.*` (resize), `clock.*`, `standalone` |
| ART `fx.ts` | `cam.trauma`, `cam.shakeX`, `cam.shakeY` — nothing else |
| AUDIO `audio.update` | `music.bpm`, `music.beatPhase`, `music.beat` — nothing else |
| ART `render.ts`, UI `ui.ts` | **nothing** (they receive `ReadState = DeepReadonly<GameState>`; keep private animation state in your closure) |
| UI `input.ts` | nothing (it only queues events) |

Strings in state (`banner.text`, `toast.text`, `summary.caption`, `summary.goalText`, ...) are written at **event time** only; UI caches any derived strings and rebuilds them only when the source value changes.

Key read-mostly fields for art/UI (full docs in `types.ts`):
- `mode`: `'title' | 'playing' | 'paused' | 'dying' | 'gameover'`; `modeT` real s in mode.
- `hero.pose` (`idle|run|air|slamHang|slam|tumble|sit|sink`), `hero.expr` (`serious|o|squint|joy|sweat|star|dizzy|sleep`), `squashX/Y` (spring, sim dt), `rot`, `runPhase` (legs + footstep phase), `lookX/lookY` (pupil target, world), `flashT` (near-miss outline), `sweatT`, `cheekPuff`, `whip` (bandana impulse), `shield` (draw Mud Coat), `invulnT` (blink; steady 50% alpha in reduced motion), `magnetT`, `deathT` (tumble/stars timing), `sinkDepth`.
- Blinks (every 2–5 s) are render-private cosmetics; `fever.t < FEVER.warn` blinking is derived by render.
- `fever.active/t`, `phase.index/next/blend/loop`, `run.chain/multiplier/groove/score/distance/speed`, `music.beatPhase` (HUD pulse), `tutorial.prompt/promptX/promptY/promptT`, `pause.countdown`, `banner`, `toast`, `summary`, `save` (best, medal source, muted, reducedMotion), `debug.overlay/template`, `clock.now` (real s, for title/UI animations), `clock.lowQuality`.
- Entity per-kind fields: `hitT` (drum dent/wobble for 0.3 s; hornbill/log stomp reaction), `hue` (ring/skin flash colour = `CHAIN_HUES[hue]`), `flag` + `stateT` (`split` melon halves, `burst`, `rescued` pit, `passed` flag waving, `popped` bubble, `smashed` hazard poof, `stomped` hornbill/log tumbling away), `warnT` (log "!" bubble at the right edge while > 0), `rot` (log roll), `phase` (cosmetic offset), `age`. Pits are drawn as covered by a rainbow drum-skin while `fever.active`.

---

## 5. Frame and step order (implemented in `game.ts`)

```
frame(rafTime)                          real dt = clamp(Δ, 0, 0.1 s)
  0  pending resize -> computeView -> backing store -> renderer.resize(view) -> ui.layout(view)
  1  tick(realDt)                       <- debug advance() runs exactly this with realDt = DT
       clock/modeT += realDt
       title|paused|gameover : drain input -> shell (start, 3-2-1 resume, retry, buttons)
       playing|dying         : if hitStop > 0: hitStop -= realDt (sim frozen)
                               else acc += realDt * timeScale; up to 6 × simStep(DT = 1/120)
         simStep: 1 drain input -> heroOnInput (actionDown/actionUp/slam) | shellEvent (rest)
                  2 hero        (stepHero)
                  3 world scroll + generator (stepWorld; content to hero.x + 3000)
                  4 entities    (movement, bob, timers, warnings, recycle)
                  5 collisions  (collideWorld)
                  6 scoring     (scoreStep)
                  7 timers      (timerStep: fever, invuln, magnet, slow-mo, tutorial, banner, death)
       banner.t / toast.t / tutorial.promptT += realDt
       fx.update(realDt)               every mode except 'paused' (runs during hit-stop)
  2  audio.update(state, realDt)       (skipped by advance())
  3  renderer.draw(state, alpha)       alpha = acc / DT
  4  ui.update(state, realDt); ui.draw(ctx, state)
  5  adaptive quality (2 s avg frame > 20 ms -> clock.lowQuality, DPR 1.5, fx.setLowQuality(true))
```

Hit-stop and `timeScale` (near-miss 0.6×, death 0.25×, first-run lesson slow-mo 0.25×, teaching freeze 0.02×; none in reduced motion) affect only the sim. fx/shake/popups/UI run on real dt.

---

## 6. Module APIs

### 6.1 Input (`input.ts`, UI engineer)
`createInput(canvas, hooks: InputHooks): InputApi` — see `types.ts` for exact docs.
- Events: `actionDown` (Space/ArrowUp/W keydown without repeat, or a non-button pointerdown; every new key/pointer = a new press), `actionUp` (when the LAST held action key/pointer is released), `slam` (ArrowDown/S), `pause` (P/Esc), `mute` (M), `restart` (R), `confirm` (Enter), `button` (pointerdown on a canvas button; never also an action).
- Every record: `time = performance.now()` at the DOM event, `device`, pointer CSS px.
- `hooks.hitTest(cssX, cssY)` first on every pointerdown; `hooks.onGesture()` synchronously inside every keydown/pointerdown handler (audio unlock).
- `next()` returns a pooled record (copy fields before calling again) or `null`. Ring of 32; when full the oldest is overwritten. `inject()` for the debug API (`device: 'synthetic'`, updates held state). `releaseAll()` on blur/pause.
- Pointer events on the canvas; `pointerup/pointercancel` on `window` (release outside the canvas still releases). `preventDefault` on Space/arrow keydown, canvas `pointerdown`, `contextmenu`. Ignore keys with Ctrl/Meta/Alt.

### 6.2 Audio (`audio.ts`, AUDIO engineer)
`createAudio(): AudioApi`. No AudioContext until `unlock()` (called from `hooks.onGesture`). Missing/failed context: everything silently no-ops, `isAvailable()` false, `update()` still advances `state.music` from real dt.

`play(id, param)` — gameplay calls these **at the moment of the event**:

| SfxId | When (caller) | param |
|---|---|---|
| `footstep` | each front-foot fall while running (hero: runPhase crossing) | speed u/s |
| `jump` | ground/coyote/buffered jump | — |
| `slamStart` | slam hang begins | — |
| `slamImpact` | slam hits the GROUND | — |
| `boing` | boing launch | — |
| `drum` | normal drum/kite-drum bounce | chain AFTER the bounce (1 = A2) |
| `drumBoom` | slam lands on a drum (BOOM) | chain AFTER (+2 already applied) |
| `stomp` | hornbill/log stomp | chain AFTER the stomp |
| `mango` | mango pickup | streak index (`run.mangoStreak`, +1 per pickup within 0.4 s) |
| `golden` | golden mango pickup | — |
| `melon` | melon run-through split or slam burst | — |
| `nearMiss` | near miss awarded | — |
| `chainBank` | chain banked on landing (chain >= 2) | banked chain length |
| `shieldGet` / `shieldBreak` | Mud Coat collected / consumed | — |
| `magnetGet` | Fruit Magnet collected | — |
| `logWarn` | log edge warning starts (0.6 s before entering) | — |
| `feverStart` / `feverEnd` | TOTOTO TIME begins / ends | — |
| `smash` | fever smashes a hazard | — |
| `splorch` | slam mud-pit rescue bounce | — |
| `land` | non-slam landing on ground with vy > ~600 | impact vy |
| `bestFlag` | passing the best flag | — |
| `death` | fatal hit (after its hit-stop starts) | — |
| `click` | any canvas button (game.ts) | — |
| `countdown` / `go` | 3-2-1 resume (game.ts) | 3/2/1 / — |

Note frequencies: `NOTE_ROOT_HZ * 2^(ladderSemitone(ladderIndex(chain)) / 12)` (helpers in `state.ts`). Music reads state in `update(state, realDt)` (mode, `run.time`, `run.speed`, `run.chain`, `fever.active/t`, `timeScale`) — see `audio.ts` header for the layer rules. `setMuted` ramps master (persistence is game.ts's job). `suspend()/resume()` on pause/blur/hidden (game.ts calls them). `setSuppressed(true)` during `advance()`. `destroy()` closes the context and clears the scheduler interval.

### 6.3 Fx (`fx.ts`, ART engineer)
`createFx(state, crng): FxApi`. All positions **world u**. Gameplay calls at event time:

| Call | Used for |
|---|---|
| `burst(kind, x, y, count, hue?)` | `dust` (footsteps every other footfall, landings), `pebble` (slam: 12), `feather` (hornbill), `chip` (log), `seed`+`juice` (melon), `mud` (shield break, splorch, geyser), `confetti` (best flag, new record), `spark` (mango: 4, golden: more), `poof` (fever smash, fever-exit clear), `note` (drum bounce, hue), `star` (boing apex, fever) |
| `popup(x, y, text, color, size)` | score text "+120", "CHAIN x7 +490" (`lg`, colour `MULT_COLORS[mult]`), "CLOSE!", "+NEW RECORD", "BOOM!", "TOTOTO TIME!" |
| `ring(kind, x, y, hue)` | `drum` (bounce, chain hue), `shock` (slam ground impact / BOOM), `boing`, `pickup` |
| `shake(amount)` | slam 0.35, BOOM 0.3, stomp 0.2, shield 0.5, death 0.7 (`SHAKE` in config). fx ignores it in reduced motion. |
| `flash(color, alpha)` | near miss (white, subtle), fever start (warm). Ignored in reduced motion. |

`update(realDt)` (game.ts), `drawWorld(ctx)` / `drawScreen(ctx)` (render.ts calls them at the right layer; `drawWorld` expects the world transform already applied: `translate(-camX, offsetY)` + shake), `clear()` on restart, `setLowQuality(on)`, `count()`. Fever speed lines + warm vignette are drawn by `drawScreen` from `state.fever` (off in reduced motion).

### 6.4 Render (`render.ts`, ART engineer)
`createRenderer(ctx, fx, crng): Renderer` — `resize(view)` after every backing-store change; `draw(state: ReadState, alpha)` every frame; `destroy()`. Full layer order and rules in the `render.ts` header. Must leave the ctx in the **base transform**, `globalAlpha = 1`, `source-over` for the UI. Render draws the whole world for every mode, including the title scene (game.ts keeps the hero/camera animated on the title) and the frozen scene under the pause menu. Debug overlay when `state.debug.overlay` (`?debug=1`): hitboxes via `geom.ts`, `state.debug.template`, speed, fps.

### 6.5 UI (`ui.ts`, UI engineer)
`createUI({ standalone }): UiApi` — `layout(view)`, `update(state, realDt)`, `draw(ctx, state)`, `hitTest(state, lx, ly)`, `buttons`.
- Canvas buttons (`ButtonId`): `pause`, `sound`, `motion`, `resume`, `restart`, `copy`. Visibility per mode in the `ui.ts` header; `hitTest` recomputes it from `state` (may be called between frames). Pressing a button never produces ACTION (input checks `hitTest` first). The shell maps: `pause` -> pause, `sound` -> toggle mute (+save), `motion` -> toggle reduced motion (+save), `resume` -> 3-2-1, `restart` -> new run, `copy` -> clipboard + toast. Tap anywhere else on title/gameover = start/retry (handled by the shell via `actionDown`).
- Screens & data sources: title (logo "HIPPO TOTOTO" letters bouncing on `music.beatPhase`/`clock.now`, subtitle, how-to, "Tap or press Space", `save.best` + `medalFor(save.best)`), HUD (`run.score`, `run.distance` "412 m", `save.best`, groove bar `run.groove/100` -> countdown `fever.t / FEVER.duration` during fever, pulse on `music.beatPhase`, flash > 85; chain "x3" beside Toto in `CHAIN_HUES[hueIndex(chain)]` while `run.chain > 0`; Mud Coat icon `hero.shield`; magnet ring `hero.magnetT / POWERUP.magnetDur`), tutorial prompt (`tutorial.prompt`: `tap` / `drum` / `slam` / `boing` / `hold`, anchored at world `promptX/promptY` (slam/boing follow Toto), text by `lastDevice`: touch vs keyboard variants in `UI_TEXT.tut*`), TOTOTO TIME entry banner (`fever.introT`, 1.25 s, 22% of the view height, kept above Toto), phase banner (`banner`), toast, pause menu + 3-2-1 (`pause.countdown`, step = `UI.countdownStep`), game-over card (`summary.*`, appears when `mode === 'gameover'` = `DEATH.cardAt` 0.65 s after the hit, count-up over `UI.countUp` from `modeT`, "Tap / Space to retry" enabled once `modeT >= DEATH.inputLockout` 0.35 s), portrait hint (UI-private one-time 3 s timer when `view.portrait`).
- Next build (`!state.standalone`): keep a `UI.domLinkClearW × domLinkClearH` CSS-px box top-left clear on title/paused/gameover (DOM "Back to site" link) and the bottom ~28 CSS px clear on title (DOM footer).
- Reduced motion: UI transitions become fades, no flashing.

### 6.6 Shell / gameplay (`game.ts`, `hero.ts`, `world.ts`)
- `createGame(canvas, opts)` -> `GameHandle { destroy, pause, resume, setMuted }`; `opts.onStateChange(mode)` on every mode change (+ once at mount). `destroy()` is idempotent: cancels rAF, removes every listener/observer/probe, `input.destroy()`, `audio.destroy()`, deletes `window.__hippoRun` if it is ours. Verified StrictMode-safe.
- Seeds: `opts.seed ?? ?seed=N ?? Date.now()>>>0`. A forced seed (opts/URL/`forceSeed`) is **sticky** for all following runs; otherwise each run takes a fresh time seed. Each run: `rng.reset(seed)`, `crng.reset(cosmeticSeed(seed))`.
- Auto-pause on `visibilitychange` (hidden), `window.blur`, real resize while playing. Never auto-resumes; resume = 3-2-1 (`pause.countdown`), `__hippoRun.resume()` skips it.
- Settings live in `state.save` (`muted`, `reducedMotion`); every change -> `writeSave(state.save)`. Save also at run end.
- Haptics (`navigator.vibrate`, try/catch, off in reduced motion): slam 12 ms, death 30 ms — gameplay.
- **Determinism** (same seed + same inputs => same run, also under `advance()`): sim code (steps 1–7) never reads `performance.now()`, `Date.now()`, `clock.now`, `InputEvent.time`, `Math.random()` or view metrics. Hold duration = sim time (`hero.holdT`; a release before `sim.cutAt` (`PHYS.jumpMinHold`, or longer up to `PHYS.tapAssistMax` when the plain tap hop would come down on the next thorn bush; chosen at press time from sim state only) sets `cutPending`). Generation runs to the fixed horizon `hero.x + GEN.aheadU`, never `viewW`-based. View metrics may only affect cosmetics/warning timing (log "!" bubble at the right edge, recycling behind the camera). Suggested: sample a chunk's speed as `speedAt(arrivalTime)` (estimate from the cursor distance) rather than the speed at spawn time.
- Debug API (`window.__hippoRun`, spec §14.6): implemented in `game.ts`. `getState().heroY` = height of the feet **above** the ground (u, + up); `heroVy` = raw `hero.vy` (+ down). `advance(s)` runs `round(s / DT)` ticks with audio suppressed and no rendering.

---

## 7. Event flow (one table to integrate by)

Gameplay performs the state change, then calls fx/audio **in the same step**. Hit-stop values are real seconds (`HITSTOP`, capped at 0.04 in reduced motion); shake values `SHAKE`.

| Event | State (gameplay) | fx | audio | hit-stop / shake |
|---|---|---|---|---|
| Jump | `vy=-900` (release cuts to -420 after `sim.cutAt`: 0.06 s, bush-aware up to 0.135 s), squash 0.82/1.22, expr `o`, `whip` | `burst('dust')` | `jump` | — |
| Slam start | hang 0.05 s, pose `slamHang`, expr `squint`, `cheekPuff=1` | — | `slamStart` | — |
| Slam hits ground | squash 1.5/0.55, chain bank/reset, melons within 120 u burst, `postSlamT=0` | `ring('shock')`, `burst('pebble',12)` | `slamImpact` (+ haptic 12) | 0.06 / 0.35 |
| Boing | `vy=-1120`, squash 0.72/1.34, expr `joy`, +30×mult, groove 0 (`GROOVE.boing`) | `ring('boing')`, `popup` | `boing` | — |
| Drum bounce | `vy=-900`, chain+1, `drumPoints`, groove +5, `e.hitT=0`, `e.hue` | `ring('drum',hue)`, `burst('note',hue)`, `popup` | `drum(chain)` | — |
| BOOM bounce | `vy=-1100`, chain+2, groove +10 | `ring('drum')`+`ring('shock')`, `popup('BOOM!')` | `drumBoom(chain)` | 0.05 / 0.3 |
| Stomp hornbill/log | bounce, chain+1, +100/+75 ×mult, groove +8, `flag='stomped'` | `burst('feather'|'chip')`, `popup` | `stomp(chain)` | 0.04 / 0.2 |
| Land on ground | chain >= 2 -> bank `chainBankValue`, chain=0, squash `1+min(0.4,vy/2600)` | `burst('dust')`, bank `popup(lg)` | `land(vy)`, `chainBank(chain)` | — |
| Mango / golden | +10/+100 ×mult, groove +0.4/+15, streak | `burst('spark')` | `mango(streak)` / `golden` | — |
| Melon run / slam | `flag='split'` +20 / `flag='burst'` +60 + 5 mangoes | `burst('seed'+'juice')` | `melon` | — |
| Hazard cleared | lethal hazard passed unhit / pit cleared by landing beyond it: groove +2 (not in fever) | — | — | — |
| Near miss | +25×mult, groove +8, `sweatT`, `flashT`, timeScale 0.6 for 80 ms | `popup('CLOSE!')`, `flash(white)` | `nearMiss` | — |
| Fever start | `fever.active`, t=6, `introT=0` (UI banner), expr `star`, smash lane (`spawnFeverLane`: 4–10 bushes from 1080 u ahead) | `flash(warm)`, `burst('star')` | `feverStart` | 0.18 / 0.5 |
| Fever smash | hazard `flag='smashed'`, +50 | `burst('poof')` | `smash` | 0.04 / 0.15 |
| Fever end | groove 0, invuln 1 s, poof hazards within 500 u + leftover lane, next chunk breather (exactly one per fever) | `burst('poof')` each | `feverEnd` | — |
| Shield get / break | `hero.shield` / hazard removed, invuln 1 s, chain kept | `burst('mud')` | `shieldGet` / `shieldBreak` | 0.08 / 0.5 |
| Pit splorch rescue | `vy=-900`, chain ends, pit `flag='rescued'` | `burst('mud')` | `splorch` | — |
| Best flag passed | +250, `run.bestPassed`, flag `passed` | `burst('confetti')`, `popup('+NEW RECORD')` | `bestFlag` | — |
| Log warning | `e.warnT = 0.6` | (render draws "!" bubble) | `logWarn` | — |
| Phase entered | `banner = "NOON · 250 m"`, `run.phasesSeen` bit | — | — | — |
| Death | `deathCause`, pose `tumble`->`sit`/`sink`, expr `dizzy`/`sleep`, timeScale 0.25 for 0.5 s, `mode='dying'`, card at 0.65 s (`DEATH.cardAt`) -> `gameover` + `summary` + save | `burst` per cause | `death` (+ haptic 30) | 0.12 / 0.7 |

---

## 8. Reduced motion (`state.save.reducedMotion`)
- fx: `shake()`/`flash()` ignored, speed lines off (ART).
- gameplay: no slow-mo (near miss / death / lesson slow-mo / teaching freeze), hit-stop capped at 0.04 s, no haptics. The first-run assisted jump (any tap clears the lesson bush) still applies.
- render: invulnerability = steady 50% alpha (no blink), fever-end warning without blinking.
- ui: transitions become fades; groove meter does not flash.

---

## 9. Testing hooks
- URL params (both builds): `?seed=N`, `?debug=1` (render overlay), `?gallery=1` (one of every entity kind spawned ahead of the hero on start, invincible; the art test bench — `__hippoRun.pause()` freezes it).
- `window.__hippoRun` (spec §14.6). Example Playwright check:
  ```js
  const { chromium } = require('playwright');
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('file:///home/user/hippotototo/public/play.html?seed=1');
  await p.evaluate(() => { const h = window.__hippoRun; h.start(); h.advance(4.9); return h.getState(); });
  ```
- Integration/test extras on `window.__hippoRun` (additive, see `types.ts` `DebugState`/`DebugApi`): `getState()` also returns `heroX, timeScale, hitStop, trauma, feverT, phase, phasesSeen, bestPassed, tutorial, freeze, presses, muted, reducedMotion, best, bestDist, viewW, viewH, heroScreenX, scale`; plus `getEntities()`, `getButtons()` (CSS px) and `setGroove(v)`.
- Acceptance / playtest: `pnpm build && node scripts/playtest.mjs [--shots DIR] [--url URL] [--no-next] [--only groups] [--file path/play.html]` drives both `/play.html` and `/play` with Playwright (spec §15; ~200 checks, JSON report next to the shots). The heap check soaks every phase and content type first, then requires the second of two 20 s real-time windows to show no sustained retained growth (see `testHeap`).
- Standalone: `node scripts/build-standalone.mjs [--out path]` (also runs as `prebuild`; `.npmrc` enables pre/post scripts for pnpm 10; `--out` writes a scratch bundle instead of `public/play.html`). The build fails on external URLs or > 400 KB.
- Type-check: `npx tsc --noEmit -p tsconfig.json`; full: `pnpm build`.

---

## 10. Integration checklist (for the merge step)
1. `npx tsc --noEmit -p tsconfig.json` clean; `pnpm build` passes; `public/play.html` regenerated.
2. Zero console errors/warnings on `/play` and `/play.html` through title -> run -> pause -> resume -> death -> 5 retries.
3. `rafPerSec ≈ 60` and one listener set after StrictMode remount (`next dev`).
4. All spec §15 acceptance criteria via `__hippoRun` (`advance`, autopilot seeds 1–10 for 90 s, soak `advance(600)` with invincible).
