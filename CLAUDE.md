# Lane Four

Prototype of a camera-tracked fitness game: Ring Fit Adventure's idea for a broader audience, on web
and mobile, with the device camera replacing the Ring-Con. This spike is one level: jog in place to
run, squat then stand to jump hurdles. 400 m or 200 m hurdles with real spacing (first hurdle 45 m,
then every 35 m).

## Status

- Built and tested in a cloud session on 2026-10-11. Never tried with a real body in a real room,
  and answering that question is what the spike is for.
- Verified: 20 unit tests; the real MediaPipe model loads and tracks a person in headless Chromium;
  a scripted body runs 200 m through the camera code path clearing 5/5 hurdles; keys mode works on
  phone portrait and landscape with no console errors.
- Published 2026-10-12: https://github.com/Lukard/lane-four, Pages serving `main` + `/docs` at
  https://lukard.github.io/lane-four/ (verified byte-identical to `docs/index.html`). Pages redeploys
  on push, so run `npm run build` and commit `docs/index.html` with any `src/` change.
- The repo uses a local git identity (GitHub noreply email), not the global work address, because
  the repo is public. Keep it that way.
- 3D chase view built 2026-10-19 and merged into `main` (fast-forward to d6a83e6), so Pages serves it
  at the same URL (live page verified byte-identical to `docs/index.html`; opened from the real URL
  it comes up as 3D on three.js r186 from jsDelivr, no console errors). The 2D renderer stays as a
  toggle (HUD `3D` chip, key `V`, the intro View choice, or `?renderer=2d`) and as the automatic
  fallback; `src/core.js` (the game rules) is unchanged.
- 3D verified in headless Chromium with SwiftShader: 98 unit tests, browser runs B, C, D and E
  (strict; B and C as 3D at the locked lowest tier and as 2D), and the 2D canvas matching the pre-3D
  build in 89 of 89 checkpoints of a fake-clock keys run at 1280x800 and at 390x844@2. Once on a
  desktop GPU (Apple M1 Pro, in-app browser): tier T0, 60 fps, p95 19 ms, 23 draw calls. Never run on
  a phone or iOS Safari, so frame cost next to MediaPipe, fill rate and every quality-tier number are
  untested starting values. Headless runs stub the fonts; the painted track glyphs (SQUAT, lane
  numbers) were not inspected in the real Big Shoulders Display or Doto.
- View lifecycle fix, stage 1, on branch `fix/view-lifecycle` (local only: not pushed, not merged, so the
  live page still has the old toggle and swaps). The owner saw 2D and 3D switching at random: phones
  fetched three.js only at Start (race 1 in 2D, later races swapped to 3D), the quality controller and
  the scene gave up to 2D on false positives, a lost graphics context was never restored, and the toggle
  saved `2d` with no visible change. Now 3D is the only renderer and the view never swaps (see "3D view,
  and why"). The first review of it found one real defect: after a real GPU process crash the in-place
  restore said `ready` while every textured surface was black, because the crash empties the 2D canvases
  behind the textures and `WEBGL_lose_context` (the emulated loss) does not. Fixed: the textures are painted
  again on every restore and read back before anything is drawn (see "A restore is verified").
  Verified in headless Chromium with SwiftShader (stage 1): browser runs B, C (3D, late three.js, 2D),
  D with D2, and E, 311 checks, all passing, including a real GPU process crash (CDP) at the intro on a
  desktop and in a race on a phone, which fails (5 colours, black track pixel) on a build without the fix.
  A one-off fuzz of 42 random 12-step page sequences (phone, iPad and desktop; three.js on time, late or
  blocked; loss, restore, emptied textures, one real GPU crash, hidden tab, resize, restart; keys mode) with
  a probe of the final picture found no violation, and flagged 15 of the same 42 on a build without the fix.
  The fuzz scripts live in a scratch folder, not in the repo, so that result cannot be reproduced from here.
  Measured in headless Chromium: WebGL2 is gone after the third GPU crash in one browser session (and the
  browser closes after more), so a test may crash the GPU process once per browser. Not verified: a real phone or iOS Safari, a
  real GPU reset on a device (headless SwiftShader only; a null `getContext` is a patched call), camera mode
  with a lost context.
- View lifecycle fix, stage 2, same branch: the quality controller can only lower the tier (see "Quality, and
  why"). The false positives the investigators reproduced are gone: a camera at 15 or 20 fps, Low Power Mode
  or a 30 fps cadence cap switched on mid-session, a target learned under the intro sheet's light load, a
  tier judged against a target learned at another tier, an emergency that went to 2D, and a verdict that
  fired on the first frame of the results screen. Verified in headless Chromium with SwiftShader: 136 unit tests (16 of them the controller,
  one per rule; nine mutants of `geom.js`, each rule switched off in turn, are all caught); browser runs B, C, D, E
  and the new F, 409 checks, all passing in one 10 min 46 s run (F alone about 4 minutes). A mutant of
  `docs/index.html` without the display-rate adoption, or without `idle()` behind sheets, fails F. The
  investigators' scenarios (a camera at 15 and 20 fps, Low Power Mode on at the start, mid-session and in a
  race, a stalled main thread, a stall only in a race, CPU throttling) were run against the new build: 13 sessions,
  none left 3D, none showed a toast, the two with a severe stall in a race went T1 to T3 in one move. CDP CPU
  throttling did not slow rAF in this environment (the GPU process is not throttled), so only the emulated cadence
  and the busy-loop stalls exercise the controller. Not verified: a real phone or iOS Safari.
- Next step: open the Pages URL on a phone and try it with a real body in a real room. Then run it on
  an iPhone and a mid-range Android for 3 minutes in camera mode: pose fps >= 24 and rAF p95 <= 36 ms
  at the settled tier, or a quality step down with the race still completing and the one "Reduced graphics"
  line at the lowest tier (also in Low Power Mode, where the cadence is 30 fps and nothing should step); the
  Signals panel (`D`) shows the tier, fps, the controller's target and state, and the last view events. If 3D
  hurts tracking on a phone, `?renderer=2d` switches it off (the View chip, key `V` and the saved choice are
  gone, see below).

## Commands

- `npm run build`: writes `docs/index.html`. Never edit that file; edit `src/` and rebuild.
- `npm install`: three (pinned 0.186.0) and MediaPipe. Needed for the 3D geometry tests and the 3D
  browser runs (B, C, D2, E); without it those skip and `npm test` still passes.
- `npm test`: unit tests (Node only).
- `npm run serve`: http://localhost:8000. The camera works on localhost or https only.
- `npm run test:browser`: Playwright runs B, C, D, E, F; strict, any failed check exits 1. B, C and E run as
  3D (`?tier=3`, SwiftShader; B and C also as `?renderer=2d`); C also with a held-back three.js (`late`); D has a
  second part D2 (WebGL2 missing or never available); E is context loss; F is the quality controller on an
  unlocked tier (about 4 minutes of it; the whole run about 11). It tests `docs/index.html`, so build first (it fails if the file is
  stale). Run A needs local assets, see README.md.
- URL params: `?renderer=2d` shows the classic view (developer and test override, never saved);
  `?tier=0..3` locks the 3D quality tier (and keeps the quality controller out of it). Key `D` toggles the
  signals panel. There is no View chip, no View choice on the intro card and no `V` key.

## Architecture

- `build.js` inlines `src/style.css`, `core.js`, `geom.js`, `assets3d.js`, `world3d.js`, `actors3d.js`,
  `scene3d.js`, `viewlife.js` and `app.js` (that load order) into `src/page.html`. The result is one
  self-contained page except for three.js. Inlined code must not contain `</script`. It also replaces
  `__THREE_VERSION__` everywhere (import map, `THREE_URLS`) with `package.json` devDependencies.three,
  which must be an exact x.y.z. `require('./build.js').build()` returns the HTML without writing.
- Network deps, all pinned: `@mediapipe/tasks-vision@1.0.1` UMD bundle and wasm from jsDelivr
  (global `Vision`), `pose_landmarker_lite` float16 model from storage.googleapis.com, Google Fonts
  (Barlow, Big Shoulders Display, Doto), and `three@0.186.0` `three.module.min.js`, imported when the
  page loads (every device) from jsDelivr, then cdnjs. An import map in page.html points the module's
  `./three.core.js` at the minified core on each host. Failed imports are cached by the browser, so
  each URL is tried once per page load; reloading is the only retry. The browser tests serve three from
  `node_modules`.
- `src/core.js`, `src/geom.js` and `src/viewlife.js` have no DOM access and attach to the global
  `LaneFour`, so Node tests load them directly (`viewlife.js` is driven there with a fake clock, fake
  three.js and fake scenes). `assets3d.js`, `world3d.js`, `actors3d.js` and `scene3d.js` take THREE as
  an argument (classic IIFEs, no imports, no addons). `src/app.js` is the browser IIFE and exposes
  `window.laneFour = { state, settings, view }` for debugging and the browser tests;
  `view.scene` has `stats()`, `project(x, y, z)`, `probe()`, `forceContextLoss()`,
  `forceContextRestore()`, `setTier(n)`.
- Phases: intro, setup (calibration), ready (raise both hands, or Enter), countdown, running,
  paused (body out of frame for 1.2 s, tab hidden, or graphics being restored), finished, results.
- Pose math runs in a virtual frame 480 units tall (`FRAME_H`), so thresholds don't depend on
  camera resolution. Landmarks pass through a One Euro filter (minCutoff 1.7, beta 0.03).

## 3D view, and why

- Chase camera behind the runner, one of three rigs by aspect (portrait under 1.0, standard under
  1.9, wide) in `Geom.RIGS`; the camera itself is `Geom.ChaseCam` (no THREE; `Scene3D.ChaseCam` re-exports it).
  Pitch is re-solved every frame to keep the feet on a fixed screen row.
  Camera x is exactly `r.x - back`, never smoothed, because a hit drops speed to 35% in one step.
- Axes: three X = race x, Y up, Z = minus race z (one negation keeps left on the left, infield on
  screen-left). The mirrored Z is the likeliest place for a bug. Unlit `MeshBasicMaterial`, fog,
  about 20 draw calls and 3 to 4k triangles; no lights, shadows or antialiasing.
- Hurdles in state `up` scale to 1.4x with distance (`Geom.farScale`) so the whole hurdle, ground to
  board top, is at least 24 px at 14 m in all three rigs (browser runs measure it). The wide rig sits
  6.5 m back, not the spec's 6.0, or its hurdle top rose above the HUD line at 14 m.
- Quality tiers T0 to T3 (`Geom.TIERS`: pixel-ratio and megapixel caps, particles, far plane, 30 fps at T3).
  Start tier: coarse pointer T1, else T0, one step above a tier remembered in `lanefour.tier3d` for 14 days
  (`pickStartTier`; so a stored T3 starts at T2 and steps down once if it must, not from the top). A scene made
  again after a context loss starts at the tier the old one had reached. How the tier moves is the section "Quality, and why".
- The product is 3D only, and the view never swaps. `LaneFour.ViewLife` (`src/viewlife.js`) is the state
  machine, `app.js` its DOM and game side. `view.mode` is '3d' from the first moment ('2d' only after a
  hard failure, or under `?renderer=2d`), `view.status` is `loading` (until the first scene has drawn),
  `ready`, `restoring` (context lost), `failed` (hard failure) or `off` (`?renderer=2d`), `view.lost` says
  the scene's context is down, and `view.events` is a ring of the last 20 (time, event, reason) whose last
  five show in the Signals panel. three.js loads at page load on every device (no pointer, Save-Data or
  connection test; the `lanefour.renderer` key is deleted at boot and never read or written). Until
  the scene has drawn its first frame nothing is drawn in 2D (the classic canvas is `hidden` and its layout
  is built only if the classic view is shown), the intro sits on the night background, and both Start
  buttons are disabled saying "Loading stadium…" (or "Restoring graphics…"). The 3D canvas fades in once
  its first frame has drawn.
- Hard failures, and only these, show the classic view: no WebGL2 API (at once), three.js load error or
  12 s timeout on both hosts (`THREE_TIMEOUT_MS`, per host, around the whole `import()` graph: on a very slow
  link Start says "Loading stadium…" for up to about 24 s before the failure, and Reload is the retry; kept
  as it was, raising it is one constant), `create()` failing on every automatic attempt, or the context lost for the
  fourth time in a stable spell. A hard failure shows `#notice` with the reason and a Reload button (it
  stays), and the race goes on in 2D. One null `getContext` is transient: `create()` swaps in a fresh
  canvas and the machine retries after 0.4 s, 1.2 s and 2.8 s before it counts.
- A lost context is recovered in place: `webglcontextlost` is `preventDefault`ed, the scene keeps its
  canvas and stops drawing (`render()` returns false), `app.js` pauses a running race (reason
  `graphics`; also a race that is paused for another reason, and a countdown that ends while lost) and
  shows "Restoring graphics…". `webglcontextrestored` resumes it (three.js has re-initialised itself).
  No restore in 3 s, or the tab visible with a lost context (and, while hidden, only on return), disposes
  the scene and makes a new one on a fresh canvas: an automatic attempt, three allowed, counters reset
  after 30 s of steady drawing. More than five losses in a stable spell also go the re-creation way,
  so a flapping context cannot loop forever. A scene whose `render()` throws three frames in a row counts
  as lost.
- A restore is verified, not assumed. A real GPU process crash (CDP `Browser.crashGpuProcess`) empties every
  2D canvas behind the `CanvasTexture`s at the instant of the loss (measured: 6 of 6 canvases from 100% to 0%
  non-empty, 4 ms after `webglcontextlost`); `WEBGL_lose_context` never does, which is why the emulated loss
  alone hid this. Left alone, three.js re-uploads blanks and the stadium comes back black while the state says
  `ready`. So `onRestored` in `scene3d.js` calls `Assets3D.repaintTextures(world.textures)` (every painter
  again, `needsUpdate`; each texture keeps its painter in `userData.draw`), `world.rebake()` (the atlas, the LED
  face, the labels) and `Assets3D.texturesIntact(world.textures)` (two 1 px alpha reads per canvas: each canvas is opaque
  over its whole face when painted); blank means the scene stays down and calls `onRestoreFailed`, and the
  same check runs once more on the first frame before it is drawn. `ViewLife.restoreFailed` then re-creates
  the scene at once (an automatic attempt, not the 3 s wait). `app.js` keeps the 3D canvas faded out from
  the loss until `renderWorld` has drawn a frame, so a blank picture is never shown.
- Layout: `resize`, `orientationchange` and `visualViewport.resize` only mark it dirty; `frame()`
  applies it after two stable frames and 250 ms. Popups are six pooled DOM nodes in `#popLayer`.
- `frame()` returns early while the tab is hidden: no pose detection, no drawing.

## Quality, and why

- The quality controller (`Geom.QualityController`, pure, fed by `scene3d.js` `render()`) only ever LOWERS the
  tier. It has no verdict that leaves 3D, and `view.mode` never depends on speed. Frames are grouped into 250 ms
  windows (rate = frames over real elapsed ms), a ring of 10. Verdicts: `'none' | 'down' | 'emergency' | 'unplayable'`.
  - emergency: the newest 7 windows run under 12 fps over their real elapsed time: straight to T3, at once, in any
    phase (mid-race too; it ignores the cooldown and goes ahead of an ordinary step on the same evidence).
  - floor: 7 of 10 windows under 18 fps, whatever the target: one step down.
  - slow: 7 of 10 windows under 0.85 x target: one step down, unless those windows are one steady cadence at 30,
    24 or 20 fps (median within 8%, spread within 12%, one outlier dropped at each end): that is a new display
    rate (Low Power Mode, Energy Saver, a 30 Hz display), so it becomes the target and nothing steps.
  - The target is the median window rate of a tier's first 3 s (capped at 60), learned again after every tier change
    (T3 is never judged against a T1 target); a median 10% above it raises it (Low Power Mode off again).
  - Ordinary steps wait for a phase that is neither the countdown nor the race, and for 8 s since the last step,
    and clear the windows. A slowdown seen in a race is acted on at the finish at the latest (the first frames of
    `finished`, before the results sheet appears 1.8 s later), once.
  - Behind a sheet (intro, results; the scene draws at 15 fps there) `idle()` is called instead: nothing is
    measured, the windows are dropped, the first two windows after it are skipped. So the target is learned under
    the load of play, never under the intro's, and nothing can fire on the results screen or cascade there.
  - At T3 there is nothing to step to: only `unplayable`, once, after 10 s of windows under 15 fps.
  - The pose rate plays no part (a camera at 15 or 20 fps with rAF at 60 is not a 3D problem). `S.poseFps` is a
    display value in the Signals "Tracking:" line; it counts changes of `cam.currentTime`, so it is not a true
    camera frame rate (a `requestVideoFrameCallback` measure is a later task).
- Never silent, never nagging. A step down says nothing on screen, but is a `tier` event with its reason
  ("T1 to T2 · slow: 7 of 10 windows under 0.85 x 53 fps (median 38.0)") in `view.events` and the Signals panel,
  whose View line gives the tier (and where it came from), the measured fps, and the controller's target and state
  ("target 60 fps, watching, 0 of 10 windows slow", "learning the frame rate", "cooldown 5 s", "behind a sheet",
  "lowest tier ..."). Reaching T3 sets `view.reduced`: ONE small line, "Reduced graphics for smooth play"; `unplayable`
  sets `view.unplayable`: the same line becomes a hint with tips (close other tabs, turn off Low Power Mode or Energy
  Saver, plug in, move the camera back). `.qnote` (page.html): under the HUD in setup, ready and paused, the first line
  of the card on the intro and results sheets, hidden in the countdown and the race; an x button dismisses it for good (it
  is not a toast and does not expire). Once per page: a re-created scene does not show it again. No switch to 2D is
  ever offered or done.
- The settled tier is remembered (`lanefour.tier3d`, 14 days, the lowest tier too) once it has held 30 s of racing
  (`runMs`, racing time at that tier, not wall time; `Scene3D.settledRecord`). A healthy default visit writes nothing.

## Detection, and why

- Steps: left minus right (ankle + knee height), divided by leg length. A step counts when the
  raised side flips. Works for jogging, marching, high knees and butt kicks; squats and hops cancel.
  Default threshold 0.045. After a 1 s pause it re-arms only once both feet are down.
- Squat depth: hip to lower-ankle distance over shoulder width, compared with the standing ratio.
  Dividing by shoulder width stops walking toward the camera from reading as a squat. Using the
  lower ankle stops high knees from reading as a squat. Down at 0.40 after 80 ms, up at half that.
- Calibration: 1 s standing still (ratio CV under 7%, hip range under 12% of leg length). These were
  loosened because a jittery, distant camera never calibrated with stricter values. It also records
  each signal's noise floor; effective thresholds are max(setting, 3.2x step noise, 3.5x depth noise).
- Framing check: none, feet, head, far, side or ok, each with an on-screen and spoken prompt,
  because the player stands 2 to 3 m from a small screen.
- Signals panel (button or D key) plots both signals against thresholds, with sliders. Settings
  persist in localStorage under `lanefour.*`.

## Race model (`Race` in core.js)

- Speed follows cadence: 1.9 m per step, max 9.5 m/s. Squatting and flying keep momentum without
  adding to it.
- Squat down charges, standing up jumps; apex 1.0 to 1.8 m by squat depth. Hurdles are 0.914 m but
  feet above 0.72 m clear them (forgiving). Above 1.35 m collects the hurdle's star. A hit slows the
  runner to 35% and tips the hurdle over.
- Holding a squat into a hurdle auto-jumps once the hurdle is `v * 0.42 s` away. This was a fixed
  distance before, which launched too late at sprint speed and clipped every hurdle.

## Tests

- `test/synth.js` generates MediaPipe-shaped landmark sequences: jogging, marching, high knees, butt
  kicks, squats, hands up, noise, camera distance changes. Add a case before changing a detector
  constant.
- `test/fake-vision.js` replaces the MediaPipe bundle in browser runs B and C. Its bot stands still,
  raises both hands, jogs at 170 spm and squats from 5.5 m to 2.9 m before each hurdle.
- `test/viewlife.test.js` drives the state machine with a fake clock and scenes (`test/viewworld.js`);
  `test/viewlife.fuzz.test.js` runs 400 random sequences of events with invariants (3D unless failed, one live
  scene, ready means drawing, `reduced` only after a live scene said so, a hard failure leaves no timer behind).
  `test/quality.test.js` drives the quality controller with synthetic frame timelines the way `render()` feeds it,
  one test per rule: steady 60, no pose input, 30/24/20 fps as a display rate (from the start, mid-session, with
  jitter), regular 38 and irregular 40 fps as slowness, one step then settle, no thrash, never back up, a target
  learned per tier, emergency straight to T3 (real elapsed time), steps deferred in a race, sheets not measured,
  no cascade on the results screen, the lowest tier's hint, a start at a stored tier. `test/assets3d.test.js` and
  `test/world3d.test.js` check `repaintTextures()` and `texturesIntact()` with canvases that can be emptied the way
  a GPU crash empties them.
- `test/browser_test.py` is only the runner; the runs are in `test/browser_tests/` (`run_a.py` to `run_f.py`,
  `common.py`, `probes.py`), each under 500 lines. In them: B and C are 3D at the intro with no 2D phase (C on a phone with a 2g Save-Data
  connection and a stale saved `2d`), no View controls, no storage writes; C `late` holds three.js back
  (Start disabled saying Loading stadium, race 1 and Race again in 3D); D aborts every three.js URL
  (persistent notice with Reload, playable 2D race, Signals line says why), D2 has no WebGL2 or a
  `getContext` that always returns null; E is context loss (in place in every phase, paused and resumed
  in a race, re-created on a fresh canvas, hidden tab, after a speed fallback, one transient
  `getContext` failure, repeated loss ending in the hard failure, texture canvases emptied before a restore
  (repainted in place; or, with the repaint disabled, or blank only on the first frame, re-created at once),
  and a real GPU process crash at the intro on a desktop and in a race on a phone, checked with `probe()`
  for the red track and `Assets3D.texturesIntact()`; a page-side watcher fails any frame where the 3D canvas is
  visible while the context is lost or the scene is gone). The 3D runs assert probe pixels, draw
  calls and triangles, flat geometry and texture counts, camera x, the next hurdle's size at 14 m and
  the wide rig after rotating. E keeps to five losses per page in 30 s (more is re-created by design).
  F has no `?tier` and uses a phone viewport (a coarse pointer starts at T1). `STRESS` (common.py) gives a page a
  main-thread stall, `window.__stall(ms, every)`, and a cadence cap, `window.__cap = fps`; `camera_fps(n)`
  makes the fake camera deliver n fps; `TIERLOG` is an own timeline and rAF meter that every check reads as its
  premise. F covers: a camera at 15 fps (a whole race) and 20 fps with rAF at full rate, a cadence cap to 30 fps
  mid-session (the target follows it, nothing steps, it rises when the cap goes), slowness in a race (no step
  in it, one at the finish, none on the results sheet), a moderate stall (single steps 8 s apart, silent, then
  the one line, then the hint after 10 s at T3, dismissed for good, the Signals text), a severe stall in a race
  (one move T1 to T3, line out of the race and on the results sheet, remembered after 30 s of racing at T3), and a
  stored T3 (starts at T2, no cascade). Each asserts the view never left 3D and the tier only went down.

## Product direction (from the first conversation)

- Proof of demand: Nex Playground, a camera-based family console, passed 1M units and raised over
  $150M in Sept 2026. Its library is family and kids' brands. The opening here is Ring Fit's
  structured workout plus progression, aimed at adults, on devices they already own.
- Camera constraints: no resistance, so design around bodyweight moves, tempo and holds; keep
  detection forgiving; prefer sustained motions over twitch timing because of latency.
- Full-body framing needs 2 to 3 m, where a phone screen is tiny. Idea not built yet: the phone acts
  as the camera and sends only landmarks to a TV or laptop, which also makes the privacy story clear.

## Known gaps

- Real-world tuning: lighting, loose clothes, portrait vs landscape framing, people walking behind.
- iOS Safari untested (wake lock, speech, fullscreen, and the whole 3D path). The GPU delegate falls
  back to CPU on its own.
- 3D on real hardware: frame time next to MediaPipe's synchronous `detectForVideo`, GPU contention,
  thermals. The wide (phone landscape) rig is the tightest: hurdle about 25 px at 14 m. From directly
  behind, the gait reads flat. Late clears can look marginal against the 0.914 m board because
  `core.js` clears at 0.72 m (the rules were left alone on purpose).
- The quality controller is tuned on synthetic timelines and headless Chromium (SwiftShader, CPU throttling, busy
  loops, rAF caps), never on a phone. Every threshold is a starting value: windows 250 ms, 7 of 10, 0.85 x
  target, floor 18 fps, emergency 12 fps, hint under 15 fps for 10 s, 30/24/20 fps as display rates, 8 s cooldown,
  3 s to learn a target. What that leaves open: a device that is slow from its first frame is accepted as its own
  rate (the target is what the tier did in its first 3 s), so it is only caught under the 18 fps floor; a stable
  30 fps from heavy load is indistinguishable from Low Power Mode and is accepted; only an emergency acts in a
  race, so a moderate slowdown (12 to 18 fps) lasts until the race that shows it is over; a false emergency
  (under 12 fps for about 2 s) takes the page to T3 for good (down only; remembered after 30 s of racing, and
  it heals one tier per visit). `S.poseFps` counts `cam.currentTime` changes and is not a true camera frame rate.
- Only one exercise loop. No music; sound is WebAudio synth plus speechSynthesis.
