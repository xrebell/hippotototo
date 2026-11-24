# HIPPO TOTOTO: Stomp the Beat — Final Build Spec

Hand-off spec for one engineer, one pass. Target 2,200–2,900 lines of TypeScript. Where this spec gives a number, use it as the starting value and keep it in `config.ts` so it can be tuned with the game running. Feel beats feature count: if time runs short, follow the cut order in section 16, never cut anything in the "never cut" list.

---

## 1. Hook, hero, world

**Hook.** A one-button runner about WEIGHT. Toto, a heavy little hippo, runs a savanna littered with festival drums. Tap to jump, tap again in the air to belly-SLAM, tap once more as he lands to BOING sky-high: "to-to-TO". Every drum he bounces on without touching the ground plays the next note of the tune, raises the multiplier and fills the Groove meter. Full meter = TOTOTO TIME.

**Hero.** Toto: round periwinkle hippo, red bandana trailing as a ribbon, stubby legs, wiggling ears, very serious face. Pupils look at the next hazard. He is never hurt: on a fail he sits down dizzy with stars.

**World.** A stylised savanna trail on festival day. Drums, melons and mangoes along the path; thorn bushes, termite mounds, grumpy hornbills, rolling logs and mud pits in the way. The sky travels dawn -> noon -> dusk -> firefly night as distance grows (night lands on the site's indigo palette).

**Readability law (teach it, never break it).**
- SPIKY + warm red/orange accents = hurts from every side (bush, mound).
- ROUND + dark outline = safe to land on from above (drums, hornbill, log, melon).
- GLOWING yellow = collect.
- Toto is the only periwinkle thing on screen.

**Originality guardrails.** No cacti, no monochrome look, no lanes, no jetpack, no rooftop city, no sliding hills, no double jump. Names, characters, art are all original.

---

## 2. Coordinate space and scaling

- World units "u". Logical view height `VIEW_H = 540`. Ground line `GROUND_Y = 430` (y grows downward). 1 metre = 50 u.
- Canvas fills its parent's CSS box. Backing store = CSS size x `dpr`, `dpr = min(devicePixelRatio, 2)`.
- Scale: `s = min(cssH / 540, cssW / 760)`; `viewW = cssW / s`; `viewH = cssH / s` (>= 540).
  - If `viewW > 1300`: `s = cssW / 1300`, `viewW = 1300`, `viewH = cssH / s`. If that makes `viewH < 480`: `s = cssH / 480` and pillarbox (centre the 1300-wide view, fill sides `#0B0B1E`).
- Vertical placement: `offsetY = (viewH - 540) * 0.6` when `viewH >= 540` (portrait: extra sky above, extra soil below), else `offsetY = viewH - 540` (crop sky only). All world drawing is translated by `offsetY`; sky and soil fills extend to the canvas edges.
- Hero screen x: `HERO_X = max(167, 0.22 * viewW)`. Minimum look-ahead = `0.78 * 760 = 593 u` = 0.96 s at top speed.
- No vertical camera movement (highest reachable point, ~275 u above ground, fits on screen). Camera only adds shake offset.
- `ctx.setTransform(dpr*s, 0, 0, dpr*s, 0, 0)` once per frame; HUD is drawn in the same logical space using `viewW`/`viewH` and safe-area insets (read `env(safe-area-inset-*)` via a probe element once per resize; default 0).
- Resize via `ResizeObserver` on the canvas parent + `window.resize`/`orientationchange`. Resizing while playing auto-pauses.

---

## 3. Controls

One ACTION button does everything.

| Input | Effect |
|---|---|
| Space / ArrowUp / W / left mouse button / any touch on canvas | ACTION press (keydown/pointerdown) and release (keyup/pointerup/pointercancel) |
| ArrowDown / S | Explicit SLAM (air only; ignored on ground) |
| P / Esc | Pause toggle |
| M | Mute toggle |
| R | Restart (pause or game over) |
| Enter / Space / tap | Start from title, retry from summary |

Input rules:
- Pointer Events on the canvas; `touch-action:none; user-select:none; -webkit-touch-callout:none`; `preventDefault` on `contextmenu`, on Space/arrow keydown; ignore `e.repeat`.
- Any pointer counts (two thumbs fine). ACTION is "held" while at least one action key/pointer is down.
- Canvas UI buttons (pause, mute, menu buttons) are hit-tested first; a press on a button never produces ACTION. Minimum button hit area 48x48 CSS px.
- Every input event is pushed into a preallocated ring buffer with `performance.now()` and consumed at the start of the next sim step. No press is ever dropped.
- First gesture creates/resumes the AudioContext inside the handler.

### What ACTION does (state by state)

1. **Grounded, or within coyote time (0.09 s after leaving ground): JUMP.** `vy = -900`.
   - Variable height: on release while `vy < -360`, set `vy = -360`. Tap (~60 ms) ~= 74 u apex / 0.40 s air; full hold = 156 u apex / 0.644 s air.
2. **Airborne, not slamming, less than 0.12 s since takeoff/bounce:** ignored (kills accidental double-tap slams).
3. **Airborne, falling, predicted time-to-ground <= 0.11 s (ground exists below): BUFFERED JUMP.** Fires on the landing step (buffer valid 0.13 s). Prediction: closed-form with fall gravity against `GROUND_Y`; if a pit is below, there is no ground so rule 4 applies.
4. **Airborne otherwise: SLAM.** 0.05 s hang (`vy = 0`, belly-down pose, cheek puff, whistle), then `vy = +1500` constant. One slam per airtime; refreshed by any bounce or landing. Not cancellable.
5. **While slamming (after the hang), or within 0.12 s after a slam hits the ground: BOING.** Queued and fired on impact (or immediately if inside the post-impact window): `vy = -1120` (apex ~241 u, air ~0.80 s), "to-to-TO". Never cut by release. If the slam lands on a drum/stompable instead, the queued press is discarded (the BOOM bounce happens anyway).

Bounces (drum, stomp, boing, mud rescue) are never cut by release.

Fallback constant `TWO_ZONE_TOUCH = false`: if true, left 40% of the screen = SLAM only, right 60% = jump only. Ship false.

---

## 4. Physics and tuning table

Fixed sim step `DT = 1/120 s`.

| Constant | Value |
|---|---|
| Gravity rising | 2600 u/s^2 |
| Gravity falling | 3500 u/s^2 |
| Terminal fall | 1500 u/s |
| Jump vy | -900 |
| Jump cut vy | -360 |
| Coyote | 0.09 s |
| Jump buffer | 0.13 s |
| Smart-buffer threshold | 0.11 s to ground |
| Slam lockout after takeoff | 0.12 s |
| Slam hang / speed | 0.05 s / +1500 |
| Boing vy / window | -1120 / during slam + 0.12 s after impact |
| Drum bounce vy | -900 |
| Slam ("BOOM") bounce vy | -1100 (apex 233 u above the drum) |
| Mud rescue bounce vy | -900 |
| Hero sprite | 76 x 60 u, origin at feet centre |
| Hero hurtbox | 48 x 42 u, centred in x, bottom 4 u above feet |
| Hazard hitboxes | drawn shape inset 15% in width, 8 u off the top |
| Pickup radius | hurtbox expanded by 18 u |
| Speed | `v(t) = 340 + 280 * (1 - exp(-t / 75))` u/s (t = run seconds). 340 start, ~433 @30 s, ~494 @60 s, ~563 @120 s, asymptote 620 |
| Derived (compute in code, do not hard-code) | `T_JUMP` 0.644 s (ground->ground full jump), `T_ON` 0.603 s (ground takeoff -> falling through drum top), `T_BB` 0.644 s (drum top -> drum top), `T_BOOM` 0.788 s (slam bounce, drum -> drum), `T_OFF` 0.68 s (drum -> ground) |

Speed never changes for power-ups (drum spacing depends on it). Global `timeScale` (hit-stop, near-miss slow-mo, death slow-mo, first-run teaching freeze) scales sim dt uniformly.

Landing/bounce detection (shared rule): hero is falling (`vy > 0`), x-ranges overlap (target widened 10 u each side), and feet were at or above `targetTop + 14` on the previous step and at/below `targetTop` now. For moving stompables also accept "feet above the target's vertical centre and `vy > 0`" so a marginal contact is a stomp, not a hit.

---

## 5. Objects

All gameplay objects get a 3 u dark outline `#1B1B3A`; background layers get none.

### 5.1 Drums (signature, never harmful)
- **Ground drum:** 84 w x 40 h, sits on the ground in a "back lane": running through it does nothing. Landing on its top from the air = bounce.
- **Kite drum:** same drum hanging from a small kite, top 170 u above ground. Only interacts from above. Reachable from a drum bounce, slam bounce or boing; a plain ground jump passes harmlessly through it.
- Normal landing: `vy = -900`. Slam landing: BOOM, `vy = -1100`, counts as 2 chain steps.
- Drawn: orange shell `#E8833A` with zig-zag lacing `#7A3E1D`, cream skin ellipse `#FFE8C2`. On hit the skin dents and wobbles (damped sine 300 ms) and emits a ring in the note's hue.

### 5.2 Hazards
| Hazard | Size (u) | Behaviour | Drawn as | Unlock |
|---|---|---|---|---|
| Thorn bush | 44 x 34 | Static. Any hop clears. Not stompable. | Dark green blob `#2E5E4E` with 7 red-orange triangular thorns `#F25C54` | 0 m |
| Termite mound | 44 x 84 | Static. Needs a near-full jump. Not stompable. | Tall jagged brown spire `#B5651D` with orange spiky crown `#F97316` | 120 m |
| Hornbill | 50 x 30, body 78–108 u above ground | Flies left at 80 u/s (world-relative), bobs +/-6 u at 1.4 Hz. Running under is safe; any jump into its side/underside hurts. Landing on it = stomp (+100, bounce, feather puff). | Round navy body `#2B2D42`, big yellow beak `#FFD166`, angry eyebrow, flapping wing | 200 m |
| Mud pit | width = `v * U(0.26, 0.40) s` | Gap in the ground filled with violet mud `#5B3A8C`/`#3A2A3F`, bubbles. Fence posts with orange-white stripes on both lips. See 5.3. | — | 260 m |
| Rolling log | 46 diameter | Rolls left at 140 u/s (world-relative). Edge warning: "!" bubble + rumble at the right screen edge 0.6 s before it enters. Jump it or stomp it (+75, bounce, wood chips). Side hit hurts. | Round log end `#8D5A3B` with spiral ring, rotating | 380 m |

### 5.3 Mud pit rules
- Grounded test: foot-centre x is outside every pit's `[x+6, x+w-6]`.
- Mud surface is 26 u below ground. Reaching it while NOT slamming = sink = death (Toto shrugs and naps in the mud). Reaching it while slamming = SPLORCH rescue bounce `vy = -900`, once per pit, ends the chain, no points. Because any tap while falling over a pit is a slam (rule 4), a panic tap saves you once.
- Crossing the far lip with feet <= 16 u below ground snaps Toto up onto the ground (ledge forgiveness). Deeper = sink.
- During TOTOTO TIME pits are covered by a rainbow drum-skin and count as ground.

### 5.4 Friendly ground props
- **Melon:** 40 x 34 on the ground. Running through: +20, splits. Slam landing or shockwave within 120 u: +60 and bursts into 5 mangoes that fly to Toto.

### 5.5 Collectibles
- **Mango:** 18 u, `#FFB627` with leaf `#5BD08A`, bobs +/-3 u. 10 pts x multiplier. Always laid along a simulated trajectory (section 8.4).
- **Golden mango:** 26 u, `#FFE45E` with pre-rendered glow sprite. 100 x multiplier, groove +15. About one per 20 s, placed 230–260 u above ground (needs boing, BOOM bounce or kite drum).

---

## 6. Core systems

### 6.1 Chain, multiplier, score
- **Chain** = consecutive bounces (drum, kite drum, hornbill, log) without touching ground. BOOM bounce = +2. Touching ground (including boing takeoff and mud rescue) banks and resets it.
- Each chain step plays the next note of the A-minor-pentatonic ladder (A2 C3 D3 E3 G3, up an octave every 5, capped at 3 octaves) and tints the drum ring with that step's hue.
- **Multiplier** = `min(5, 1 + floor(chain / 2))`. Applies to mangoes, stomps, near misses while the chain is alive. It is the only multiplier (TOTOTO TIME doubles on top).
- **Score:**
  - Distance: 1 pt per metre.
  - Drum bounce: `min(200, 20 * chain)` x mult.
  - Hornbill 100, log 75, melon 20/60, mango 10, golden 100, near miss 25, boing 30 (all x mult).
  - Chain bank on landing (chain >= 2): `min(2000, 10 * chain^2)`, floating text "CHAIN x7 +490" and a ta-da.
  - TOTOTO TIME: everything x2, each smashed hazard +50.

### 6.2 Groove meter and TOTOTO TIME
- Meter 0–100: mango +1.2, drum bounce +7, BOOM bounce +10, stomp +8, near miss +5, melon smash +4, boing +4, golden +15. Decays 1.5/s only while grounded. Frozen during TOTOTO TIME.
- At 100: **TOTOTO TIME, 6 s.** Invincible; touching any hazard smashes it (+50, 30 ms hit-stop); pits bridged; score x2; all music layers; speed lines; warm vignette. Speed is unchanged.
- Last 1.5 s: Toto blinks, music filter closes as warning. On exit: every hazard within 500 u ahead poofs away, 1.0 s invulnerability, meter = 0, next chunk is a breather.

### 6.3 Near miss
While a hazard overlaps the hero's x-range (extended 14 u), track minimum clearance between hitbox and hurtbox. If it passes with no hit and min clearance <= 14 u: "CLOSE!" +25 x mult, groove +5, sweat drop, 0.6x time for 80 ms (skipped in reduced motion). Once per hazard. Not during TOTOTO TIME.

### 6.4 Power-ups (2 pickups + 1 earned)
Pickups float in a soap bubble 70 u above ground (any hop collects), only inside breather chunks, never within 0.8 s of a hazard, never two on screen.
1. **Mud Coat (shield).** Toto gets brown mud with drips. Absorbs one hit (hazard destroyed, mud splatter, 80 ms hit-stop, 1.0 s blinking invulnerability, chain kept) or one pit sink (geyser launches him at `vy = -1100`). No timer, max one. First one is guaranteed in the first breather after 12 s of every run; afterwards one per ~35 s while none is held.
2. **Fruit Magnet (drum-stick charm).** 8 s. Mangoes within 220 u accelerate toward Toto at 2400 u/s^2. Every ~45 s, not before 40 s. HUD shows a shrinking ring. First feature to cut.
3. **TOTOTO TIME** (6.2), earned only.

### 6.5 Death and retry
- One hit ends the run (unless Mud Coat / invulnerable / TOTOTO TIME).
- Sequence: 120 ms hit-stop -> 0.5 s at 0.25x while Toto tumbles and sits with orbiting stars, music low-passes to 300 Hz -> summary card bounces in at ~0.9 s after the hit -> input accepted 0.5 s after the card appears. One input restarts; running again within 300 ms of that input, no reload, music keeps going.
- Caption by cause (pick at random from 2–3 each), e.g. bush: "Toto found the pointy bit."; mound: "The termites send their regards."; hornbill: "The hornbill is not sorry."; log: "Timber: 1. Toto: 0."; pit: "Toto decided this mud was a fine bed."

---

## 7. Difficulty and onboarding

- Speed: section 4. Jump physics never change.
- **Rest gap** appended after every chunk: `restGap = lerp(0.95, 0.50, clamp(t / 120, 0, 1))` seconds (x v). Hard floor 0.50 s.
- **Tier weights** by distance d (metres), linear between keys: `0 m: T1 100%` | `120 m: T1 70 / T2 30` | `500 m: 30 / 50 / 20` | `1000 m+: 10 / 40 / 50`. A template is eligible only if all its hazard types are unlocked.
- **Breathers:** after every 4 hazard chunks (5 after 500 m) one breather chunk (drums, melons, mangoes only, 2.2–3.0 s). Also immediately after TOTOTO TIME. Pickups spawn only here.
- **Opening (every run):** first 5 s hazard-free: a mango hop arc at 1.2 s, one ground drum at 2.6 s with a mango arc showing the jump onto it and the bounce off it. First thorn bush no earlier than 5.0 s.
- **First-ever run (no save data) additionally:**
  - Ghost prompt "TAP" (or "SPACE" if last input was keyboard) pulsing before the first bush. Teaching freeze: if no jump has started by 0.45 s before contact, `timeScale` eases to 0.15 until ACTION is pressed (max 4 s), then eases back over 0.3 s.
  - Prompt "TAP AGAIN IN THE AIR = SLAM" above a guaranteed drum pair at ~9 s.
  - Prompt "TAP AS YOU LAND = BOING!" under a guaranteed golden mango at ~14 s.
  - Prompts stop after 20 s; `tutorialSeen` saved at first game over.
- New hazard type's first appearance in a run is always its solo intro template.

---

## 8. Procedural generation

### 8.1 Model
- Seeded `mulberry32`. Seed = `opts.seed` ?? URL `?seed=N` ?? `Date.now() >>> 0`. A second independent RNG stream (seed ^ 0x9E3779B9) drives cosmetics (particles, blinks, decoration) so visuals never perturb the course. Same seed + same inputs = same run.
- Templates are authored in SECONDS. At spawn, `x = cursorX + t * v` with `v` = current speed sampled once per chunk. Pit widths, drum spacings and mango arcs are computed from `v` and the physics constants, so patterns stay solvable at every speed by construction.
- The spawner keeps content generated to `cameraRight + 1.5 * viewW`; nothing ever spawns on screen. Entities are recycled 200 u past the left edge.
- Selection: filter by unlocks -> pick tier by weights -> weighted random among that tier excluding the last 2 template ids -> apply variants (bush<->mound swap where flagged and unlocked, +/-6% jitter on optional items only, optional golden mango flag with p = 0.3) -> append rest gap.
- Moving hazards spawn at `x = xIntended + relSpeed * (xIntended - heroWorldX) / v` so they arrive where the template intends.

### 8.2 Fairness guarantees (assert these in dev builds, `console.warn` on violation)
1. Every chunk is solvable with ground jumps only. Drums, stomps, slam and boing are always the optional high-score line.
2. Look-ahead >= 0.95 s: guaranteed by the 760 u minimum view and spawn-off-screen rule.
3. Between two REQUIRED jumps: landing point of the first to takeoff point of the second >= `0.25 s * v` of flat ground at tier 3, 0.35 s at tier 2, 0.45 s at tier 1 (anticipated-stimulus reaction time ~0.2 s plus margin).
4. Pit width <= `0.40 s * v` (62% of `T_JUMP`). At least 0.5 s of flat ground before a pit and 0.25 s of clear ground after it.
5. A low hornbill is never within 0.6 s (in travel time, at its arrival position) of a required jump's arc, before or after.
6. Nothing lethal within the landing zone (+/-60 u) of the intended drum-chain exit of a template.
7. Logs always get the 0.6 s edge warning and are never paired with a pit in the same template.
8. No hazard within 1.0 s after shield break, mud rescue, resume, or TOTOTO TIME exit (remove/poof offenders).

### 8.3 Template library (18 + 4 breathers; times in s from chunk start)
Notation: `J = T_JUMP`, `ON = T_ON`, `BB = T_BB`. "arc" = mango trail along that simulated trajectory.

Tier 1 (0 m+)
- `bush`: bush@0.4; hop arc.
- `bush2`: bush@0.4, bush@0.4+J+0.45; hop arcs.
- `drumHello`: drum@0.7; arc jump-onto-drum + bounce-off.
- `drumPair`: drum@0.7, drum@0.7+BB; arcs; optional golden above 2nd drum (BOOM line).
- `bushDrum`: bush@0.4, drum@0.4+(ON - J/2) (a jump centred over the bush lands on the drum); bounce arc.
- `melonSlam`: melon@0.9; full-jump arc ending in a short vertical mango column above the melon (teaches slam).

Tier 2
- `mound` (intro, 120 m): mound@0.5; full-jump arc.
- `moundBush`: mound@0.5, bush@0.5+J+0.4.
- `hornbillLow` (intro, 200 m): hornbill arriving @0.8; mango line on the ground under it ("stay low").
- `hornbillStep`: drum@0.6, hornbill arriving @0.6+BB at bounce-landing height offset so a drum bounce lands on it; arcs. Ground route: just run.
- `pit` (intro, 260 m): pit@0.6 (width 0.28 s); full-jump arc over it.
- `pitDrum`: drum@0.5, pit starting @0.5+0.15 (width 0.36 s) so the drum bounce carries over it; ground route: jump from the near lip.
- `drumLine3`: drums @0.7, +BB, +2BB; kite drum @+3BB with golden mango above (optional).
- `log` (intro, 380 m): log arriving @0.9; hop arc.

Tier 3 (500 m+)
- `bushHornbill`: bush@0.4, hornbill arriving @0.4+J/2+0.65.
- `pitMound`: pit@0.5 (0.30 s), mound@0.5+0.30+J/2+0.45.
- `logDrums`: log arriving @0.8, drums @0.8+ON-J/2 and +BB (stomp the log, land on drums).
- `drumBridge`: drum@0.5, then a 0.40 s pit, drum on the far bank @0.5+BB, kite drum @0.5+2BB, mound under the kite drum's exit-safe zone excluded (respect rule 6).

Breathers
- `alleyDrums`: 4 drums at BB spacing with rainbow mango arcs.
- `alleyMelons`: 3 melons 0.7 s apart + arcs.
- `alleyKite`: drum, kite drum, drum (BB spacing) + golden mango.
- `alleyPickup`: flat run of mangoes + the pickup bubble slot.

### 8.4 Mango arcs
`simArc(kind, x0, v)` steps the real hero physics (`hop`, `jump`, `ontoDrum`, `bounce`, `boom`, `boing`) at `DT` and drops a mango every 0.08 s between 15% and 85% of the flight (5–9 per arc). Arcs therefore always match a real input at the current speed and silently teach timing.

### 8.5 Decoration
Parallax props (acacias, rocks, tufts, distant kites) come from a hash of the tile index per layer: deterministic, infinite, zero storage. Skip foreground tufts within 60 u of any hazard.

---

## 9. Art direction

Flat rounded vector shapes; soft darker underside; only gameplay objects are outlined. No `shadowBlur` anywhere; glows are one pre-rendered radial sprite drawn with `globalCompositeOperation = 'lighter'`.

**Fixed palette**
- Toto: body `#A9A4F5`, belly `#CFCBFF`, cheeks `#FF9EC4`, bandana `#FF5A5F`, eye `#1B1B3A`, tooth `#FFFFFF`, outline `#1B1B3A`.
- Mud Coat `#7A5236`; UI text `#F8FAFC`; UI accent `#818CF8`; panel `#030712` at 72%; groove meter gradient `#FF5A5F -> #FFB627`.
- Chain hues (5 steps): `#FF5A5F, #FFB627, #5BD08A, #4FA8F6, #B78CFF`.

**Day phases** (each 250 m; cross-fade over the last 50 m; loops after night with dawn again). Banner on entry: "NOON · 250 m" etc.

| Phase | Sky top -> bottom | Far mesas | Hills | Trees | Ground top / body | Tint on gameplay ground |
|---|---|---|---|---|---|---|
| Dawn 0 m | `#2B2D6E -> #FF9E7A` | `#8A5A8C` | `#B5677A` | `#5A3A5E` | `#F2C57C / #C98F4E` | none |
| Noon 250 m | `#4FA8F6 -> #BFE9FF` | `#C9B79A` | `#9CC27A` | `#5E8C4E` | `#F2C57C / #C98F4E` | none |
| Dusk 500 m | `#3A1C71 -> #FF7E5F` | `#8E3B46` | `#A8483F` | `#4A2440` | `#E0A060 / #A8683A` | 10% `#FF7E5F` |
| Night 750 m | `#0B0B1E -> #27306B` | `#1E1B4B` | `#2A2558` | `#15133A` | `#8C79A8 / #4A3A6B` | none; gameplay objects get a 2 u light rim `#C7D2FE`; 40 twinkling stars, moon `#FDF6E3`, 20 fireflies `#E8FF8A` |

**Parallax layers (scroll factor):** sky gradient 0 (cache the gradient; rebuild only when the quantised phase blend (64 steps) or size changes); sun/moon 0.02 (arcs across the sky as the phase clock); far mesas 0.10; hills 0.25 (sum of 3 sines sampled every 16 u); acacia silhouettes 0.50; gameplay 1.0; foreground tufts 1.3 (below the ground line only, 60% alpha). Background layers are drawn as direct paths with lerped colours each frame (a few hundred path points total); no offscreen layer caches needed.

**Toto drawing (~70 lines, around the feet origin, `ctx.scale` for squash, rotation for slam/tumble):** body ellipse 64x46; head ellipse 44x36 forward-up; snout ellipse 30x22 with 2 nostrils; 2 ears whose angle = `clamp(vy * 0.02, -25, 25)` deg; one eye with highlight, pupil offset up to 3 u toward the nearest hazard; tiny square tooth; cheek blush; 4 rounded-rect legs with `sin(distance * k + phase)`; stub tail; bandana = 6-point verlet ribbon pinned at the neck, blown back by speed, whipped by slam.
Expressions: run (serious brow), jump (mouth "o"), slam (eyes "> <", puffed cheeks), boing/bounce (open-mouth joy), near miss (sweat drop), fever (star eyes), dead (spiral eyes), blink every 2–5 s.

---

## 10. Juice (priority order; build top-down)

1. Squash/stretch spring on Toto (k = 380, damping = 22; reduce to a simple 120 ms ease if it misbehaves): takeoff 0.82x/1.22y; landing `1 + min(0.4, vy/2600)` wide; slam impact 1.5x/0.55y; boing 0.72x/1.34y.
2. Hit-stop (sim frozen, particles/shake continue): slam impact 60 ms, BOOM bounce 50 ms, stomp 40 ms, fever smash 30 ms, shield break 80 ms, death 120 ms.
3. Trauma screen shake: `offset = 12 u * trauma^2` using summed sines, decay 2.2/s. Slam +0.35, BOOM +0.3, stomp +0.2, shield +0.5, death +0.7.
4. Drum skin dent/wobble + coloured ring + chain note. Chain counter "x3" beside Toto in the step hue while a chain is alive.
5. Slam shockwave ring (0 -> 120 u in 0.22 s), 12 dust/pebble particles, mango pull.
6. Bandana ribbon; footstep dust puffs every other footfall; run cycle driven by distance.
7. Floating score text: scale 0 -> 1.2 -> 1 in 150 ms, drift up 30 u, fade 0.7 s. Bank text larger, coloured by multiplier.
8. Mango pickup: pop + 4 sparks; pitch rises one scale step per pickup within 0.4 s.
9. Near-miss: slow-mo blip, white outline flash, "CLOSE!", sweat drop.
10. Particles by type: feathers (hornbill), wood chips (log), seeds/juice (melon), mud splats (shield, pit), confetti (best flag), speed lines + vignette (fever).
11. HUD groove meter pulses on the beat, flashes above 85%.
12. Phase banner slide-in; best-flag pass celebration.
13. Death tumble, stars, low-pass, card bounce-in.
14. Haptics where `navigator.vibrate` exists: slam 12 ms, death 30 ms (off in reduced motion).

**Reduced motion** (default from `prefers-reduced-motion`, toggle in settings): shake off, slow-mo off, no flashes (invulnerability shown as steady 50% alpha), hit-stop capped at 40 ms, speed lines off, UI transitions become fades.

---

## 11. Audio (all WebAudio, zero files)

Chain: `sfxBus (0.7)` + `musicBus (0.32)` -> `musicFilter (lowpass)` on music only -> `DynamicsCompressor (-18 dB, ratio 4)` -> `master` -> destination. One shared 1 s white-noise buffer. Mute ramps master to 0 over 50 ms and is persisted. Context suspended on pause/blur, resumed on gesture. Every audio call is wrapped so a missing/failed AudioContext yields a silent, fully working game.

**SFX recipes**
| Sound | Recipe |
|---|---|
| Footstep "to" | bandpassed noise 2.4 kHz, 25 ms, gain 0.06, pitch x1–1.5 with speed, on each front-foot fall |
| Jump | triangle 220 -> 440 Hz, 90 ms, gain 0.18 |
| Slam start | sine whistle 400 -> 900 Hz over 50 ms + highpassed noise whoosh 120 ms |
| Slam impact | sine 90 -> 38 Hz, 200 ms, gain 0.5 + lowpassed (800 Hz) noise burst 100 ms |
| Boing | sine 300 -> 700 Hz, 18 Hz vibrato, 300 ms |
| Drum bounce | sine at chain note with pitch drop (x1.5 -> x1 in 40 ms), 260 ms decay + 15 ms noise tick; BOOM adds a sub-octave sine |
| Mango | square through 2.5 kHz lowpass, 60 ms, A5 pentatonic step rising per quick pickup |
| Golden mango | 3-note triangle arpeggio (E5 A5 E6), 70 ms each |
| Melon smash | bandpass noise sweep 1.5 kHz -> 400 Hz 150 ms + sine pop 160 -> 80 Hz |
| Stomp | sine squeak 600 -> 1200 Hz 70 ms + thump 120 -> 60 Hz |
| Near miss | bandpass noise sweep 3 kHz -> 600 Hz, 180 ms |
| Chain bank | two triangle notes (root, fifth of current chord), volume scaled by chain |
| Mud Coat get / break | rising noise + chime / crunchy noise + square 200 -> 80 Hz |
| Log warning | sine 45 Hz rumble 0.6 s, low gain |
| Fever start / end | saw riser through opening lowpass 0.5 s + noise cymbal / falling filter |
| Best flag | 5-note fanfare A4 C5 E5 A5 C6 |
| Death | triangle steps 392, 370, 349, 330 Hz with vibrato ("wah-wah") |
| UI click | 20 ms tick |

**Music** (look-ahead scheduler: 25 ms timer, 120 ms window; 16-step bars; A minor pentatonic; chords Am–C–Dm–Em, one bar each). Tempo `112 + 16 * (v - 340) / 280` BPM, changed only at bar lines.
- L1 always: sine kick (120 -> 45 Hz, 120 ms) on steps 0 and 8; shaker (7 kHz highpassed noise) on off-beats.
- L2 after 15 s: plucked triangle bass, root on 0/8, fifth on 6/14.
- L3 while chain >= 2, or after 60 s: marimba pluck (sine + 3x partial at 15%, 250 ms) playing a per-bar seeded random walk on the scale, snapped to chord tones on steps 0/8, 30% rests.
- L4 TOTOTO TIME only: claps (1.2 kHz bandpass noise) on 4/12, octave bass, filter fully open.
- Title screen: L1 + L3 softly at 96 BPM. Game over: filter sweeps to 300 Hz, music keeps looping quietly.
- Bounce notes are NOT quantised (latency matters more); they share the scale so they are always in key.

---

## 12. UI (all drawn on the canvas; identical in Next and standalone)

Font stack: `ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif`, bold, light fill over 4 u dark stroke. Canvas buttons are a small array of `{id, x, y, w, h, label, visible}` hit-tested on pointerdown; keyboard shortcuts cover every button.

- **Title.** Live scene: Toto idle-bouncing on a drum, parallax drifting. Logo "HIPPO TOTOTO" in chunky letters bouncing one by one in to-to-to rhythm, subtitle "Stomp the Beat". Two-line how-to: "TAP: jump" / "TAP in the air: SLAM · TAP on landing: BOING". Pulsing "Tap or press Space". Best score + medal. Toggle buttons: Sound, Reduced motion.
- **HUD.** Top-left: score (large, tabular), distance "412 m" and best beneath. Top-centre: Groove meter bar (min(280, 0.4 * viewW) wide) labelled "GROOVE", becomes a countdown bar during TOTOTO TIME. Next to Toto: chain "x3" while alive. Icons by the score: Mud Coat, magnet ring. Top-right: pause and mute buttons (48 CSS px, inside safe area). Portrait: same layout; one-time 3 s hint "Rotate for a wider view".
- **Pause** (P/Esc/button/auto on blur, visibilitychange, resize): dimmed scene, "PAUSED", Resume / Restart / Sound / Reduced motion. Never auto-resumes. Resume shows 3-2-1 (0.4 s each) before the sim continues.
- **Game over / run summary.** Card: caption, score count-up (0.8 s), "NEW BEST!" burst or "Only 86 m short of your best", distance, best chain, mangoes, stomps, medal, next-goal line, big "Tap / Space to retry". Standalone only: "Copy score" button (clipboard in try/catch).
- State machine: `title -> playing -> (paused <-> playing) -> dying -> gameover -> playing`.

---

## 13. Meta (small on purpose)

`localStorage` key `hippotototo.v1`, one JSON object `{ v:1, best, bestDist, bestChain, runs, totalMangoes, muted, reducedMotion, tutorialSeen, goalIndex }`. All reads/writes in try/catch with in-memory fallback; save at run end and on settings change only.

1. **Best flag:** a pennant planted in the world at `bestDist`. Passing it mid-run: fanfare, confetti, "+NEW RECORD", +250.
2. **Gap line** on the summary ("Only 86 m short of your best" / "New best by 312!").
3. **Medals** by score: bronze 1,500 / silver 5,000 / gold 12,000 (re-calibrate with the autopilot: bronze ~= a 45 s clean run).
4. **Next goal** line, fixed ordered list of 8, tick + advance on completion: chain 3 drums; reach noon; BOOM-bounce a drum; stomp a hornbill; trigger TOTOTO TIME; chain 6; reach dusk; reach night.
5. Instant retry.

Not built: shops, skins, currency, missions grid, daily seed, leaderboards, hearts.

---

## 14. Technical architecture

### 14.1 Files
```
components/hippo-run/
  index.ts        // export { createGame }; export type { GameOptions, GameHandle }
  config.ts       // every tunable + palette
  rng.ts          // mulberry32
  storage.ts      // save/load with fallback
  input.ts        // keyboard + pointer -> timestamped ring buffer
  audio.ts        // context, sfx, music scheduler
  hero.ts         // hero state + physics step
  world.ts        // pools, templates, generator, collisions
  render.ts       // background, entities, hero, particles
  ui.ts           // HUD, screens, canvas buttons
  game.ts         // state machine, loop, debug API
  hippo-run-client.tsx   // 'use client' React mount (the only file importing React)
app/play/page.tsx        // server component: metadata + <HippoRunClient />
scripts/build-standalone.mjs
public/play.html         // generated, committed
```

### 14.2 Engine API
```ts
export interface GameOptions {
  seed?: number;
  standalone?: boolean;                       // enables Copy score
  onStateChange?: (state: 'title'|'playing'|'paused'|'dying'|'gameover') => void;
}
export interface GameHandle { destroy(): void; pause(): void; resume(): void; setMuted(m: boolean): void; }
export function createGame(canvas: HTMLCanvasElement, opts?: GameOptions): GameHandle;
```
- The engine imports nothing outside its folder: no React, no Next, no `@/` alias, relative imports only (`./config`, no extension).
- `destroy()` is idempotent: cancels rAF and timers, removes every listener and observer, closes the AudioContext, deletes `window.__hippoRun` if it points at this instance. Must survive React StrictMode mount -> destroy -> mount.

### 14.3 Loop
- Fixed step 120 Hz with accumulator; frame dt clamped to 100 ms; max 6 steps per frame; render at rAF with interpolation `alpha` on hero y and world scroll.
- Order per step: drain input -> hero -> world scroll/generator -> entities -> collisions -> scoring -> timers. Particles, shake and popups advance on real dt (so they run during hit-stop).
- Auto-pause on `visibilitychange` (hidden), `window.blur`, resize/orientation change.

### 14.4 Performance rules
- Fixed pools created once: entities 96, mangoes 160, particles 256, popups 16, input events 32. No `new`, array literals, closures, or string concatenation in the per-step/per-frame hot path (HUD strings are rebuilt only when their value changes).
- No `shadowBlur`, no per-frame `createLinearGradient` except via the cache, no `getImageData`. DPR cap 2; if the 2 s average frame time exceeds 20 ms, drop DPR to 1.5 and halve particle spawns (one-way per session).
- Index-based `for` loops over arrays only.

### 14.5 TypeScript constraints (the repo type-checks with `strict`, `isolatedModules`, `target: es5`)
- Use `import type` / `export type` for types. No `const enum`, no namespaces.
- Do not iterate `Map`/`Set`/iterators with `for...of` or spread (fails without `downlevelIteration`). Arrays with index loops only.
- `window.__hippoRun` typed via a local cast (`(window as unknown as { __hippoRun?: DebugApi })`), no global augmentation needed.
- `pnpm build` must pass with zero type errors.

### 14.6 Debug / test API (`window.__hippoRun`, always present while a game is mounted)
```ts
{
  getState(): { state: string; score: number; distance: number /* m */; speed: number;
                time: number; chain: number; multiplier: number; groove: number; fever: boolean;
                shield: boolean; heroY: number; heroVy: number; grounded: boolean;
                seed: number; fps: number; entities: number; deathCause: string | null };
  forceSeed(seed: number): void;     // applies to the next start/restart
  start(): void; restart(): void;    // skips title / summary lockouts
  press(): void; release(): void;    // synthetic ACTION
  slam(): void;
  pause(): void; resume(): void;     // resume() skips the 3-2-1
  advance(seconds: number): void;    // run sim steps synchronously, no rendering, no audio
  setAutopilot(on: boolean): void;   // simple ground-jump-only bot
  setInvincible(on: boolean): void;
}
```
- Autopilot: looks at the next lethal hazard/pit; jumps (full hold) when the time to the hazard's leading edge <= 0.30 s (pits: at the lip minus 12 u; moving hazards: use closing speed); never jumps while a low hornbill would intersect the arc. It doubles as the generator's fairness test.
- URL params (both builds): `?seed=N`, `?debug=1` (draw hitboxes, template id, speed, fps).

### 14.7 React mount
- `app/play/page.tsx` (server component): `export const metadata = { title: 'Hippo Tototo — Play', description: ... }`; renders `<HippoRunClient />`.
- `hippo-run-client.tsx`: `'use client'`; a `div` with `fixed inset-0 z-50 bg-[#0B0B1E]` and `height: 100dvh` (covers the site header from the root layout; do not edit `app/layout.tsx`); a `<canvas className="block h-full w-full touch-none select-none" />`; `useEffect` -> `createGame(canvas, { onStateChange })` -> cleanup `destroy()`.
- Game-page chrome: while state is `title`, `paused` or `gameover`, show a small top-left DOM link "<- Back to site" (`next/link` to `/`) and, on `title` only, a bottom-centre footer line in `text-xs text-indigo-200/60`: "Hippo Tototo · a playable demo" plus a link "Standalone version" to `/play.html`. Hidden while playing so nothing overlaps the HUD.
- Add one "Play the demo" link to `/play` in the landing page hero or header nav if it is a one-line change; do not restructure existing components.

### 14.8 Standalone build (`scripts/build-standalone.mjs`, no new deps)
- Read every `.ts` (not `.tsx`) in `components/hippo-run/`; `ts.transpileModule` each with `{ module: CommonJS, target: ES2019, isolatedModules: true, removeComments: true }`.
- Emit one IIFE with a ~25-line module registry: `const defs = { 'config': function(module, exports, require) {...}, ... }`, `require` normalises `./name`, caches exports. Entry: `require('index').createGame(document.getElementById('game'), { standalone: true })`.
- Escape `</script` in the bundled code. Write `public/play.html`: doctype, `<meta charset>`, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`, `<title>`, inline CSS (`html,body{margin:0;height:100%;background:#0B0B1E;overflow:hidden}` canvas `width:100vw;height:100dvh;display:block;touch-action:none`), one canvas, the inline script. No external URLs of any kind.
- `package.json` scripts: `"build:play": "node scripts/build-standalone.mjs"` and `"prebuild": "node scripts/build-standalone.mjs"`. Commit the generated `public/play.html`.

---

## 15. Acceptance criteria (all testable)

Build
- [ ] `pnpm build` succeeds with zero type errors; `/play` is in the route list.
- [ ] `node scripts/build-standalone.mjs` produces `public/play.html` < 400 KB containing no `http://` or `https://` references, no `<link>`, no `<img>`, no external `<script src>`.
- [ ] No new entries in `dependencies`/`devDependencies`. No image/audio/font files added.
- [ ] `/play` and `/play.html` run the same engine code and both expose `window.__hippoRun`.

Runtime
- [ ] Zero console errors or warnings on load, through a full run, pause/resume, death and 5 consecutive retries, in both builds.
- [ ] `getState().fps` >= 55 average over 30 s at 1280x720 and at 390x844 (DPR 2) in Playwright Chromium; no per-frame allocations visible as a sawtooth in a 30 s heap timeline.
- [ ] Portrait 390x844 and landscape 1366x768 both show the ground, Toto, HUD and >= 593 u of look-ahead; no page scroll, no pinch zoom, no text selection, no context menu.
- [ ] Hidden tab or window blur pauses within one frame; it never auto-resumes; resume shows 3-2-1.
- [ ] Mounting, destroying and re-mounting (StrictMode) leaves exactly one rAF loop, one AudioContext and one set of listeners.
- [ ] Works with localStorage blocked (throws) and with AudioContext unavailable.

Game rules
- [ ] First lethal hazard is never reachable before 5.0 s of run time (assert via `advance` + `getState` on seeds 1–20 with no input: `state === 'playing'` at t = 4.9 s).
- [ ] With no input the run ends on the first bush (state reaches `gameover`), and one `press()` (or Space, or a tap) after the lockout returns to `playing` within 300 ms.
- [ ] Same seed + same scripted inputs through `advance()` produce identical `score` and `distance` twice in a row.
- [ ] `setAutopilot(true)` (ground jumps only, no invincibility) survives >= 90 s on seeds 1–10 using `advance()`. Any failure is a generator fairness bug (or a bot bug) and must be fixed, not waived.
- [ ] `setInvincible(true)` soak: `advance(600)` completes without exceptions; `entities` stays <= pool size; all four day phases were entered.
- [ ] Tap = short hop (apex 60–90 u), hold = full jump (apex 150–160 u), measured via `heroY`.
- [ ] A press less than 0.12 s after takeoff does not slam; a press inside the final 0.11 s of a fall produces a jump on landing, not a slam.
- [ ] Slam -> press -> BOING reaches an apex >= 230 u. Slam onto a drum gives a BOOM bounce and chain +2. Landing on the ground resets `chain` to 0.
- [ ] Slamming into a mud pit bounces Toto out once; falling in without slamming ends the run (or consumes the Mud Coat).
- [ ] Groove meter reaching 100 starts TOTOTO TIME for 6 s, during which no hazard can end the run, and no hazard exists within 500 u ahead at its end.
- [ ] Touch: pointerdown anywhere (outside buttons) jumps on the same sim step it is consumed; pause/mute buttons are >= 48 CSS px and never trigger a jump.
- [ ] Keyboard: Space/ArrowUp/W jump, ArrowDown/S slam, P/Esc pause, M mute, R restart; Space never scrolls the page.
- [ ] Mute state, best score, reduced-motion setting persist across reloads. Reduced motion disables shake, slow-mo and flashing.
- [ ] Best flag appears at the stored best distance and passing it fires the celebration once.

---

## 16. Cut order and never-cut list

Cut in this order if the pass runs long: (1) Fruit Magnet; (2) next-goal line and medals; (3) rolling log; (4) kite drums and the `drumBridge`/`alleyKite` templates; (5) music L3 melody; (6) near-miss slow-mo (keep points); (7) day phases reduced to dusk + night; (8) adaptive DPR.

Never cut: variable jump + coyote + smart buffer; slam, drum bounce chain with scale notes; boing; squash/hit-stop/shake; mud-pit slam rescue; mango arcs from simulated physics; TOTOTO TIME; instant retry; best flag; pause on blur; mute; reduced motion; seeded RNG + `window.__hippoRun`; the autopilot fairness check.
