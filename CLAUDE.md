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
  Verified in headless Chromium with SwiftShader: 129 unit tests; browser runs B, C (3D, late three.js, 2D),
  D with D2, and E, 311 checks, all passing, including a real GPU process crash (CDP) at the intro on a
  desktop and in a race on a phone, which fails (5 colours, black track pixel) on a build without the fix.
  A one-off fuzz of 42 random 12-step page sequences (phone, iPad and desktop; three.js on time, late or
  blocked; loss, restore, emptied textures, one real GPU crash, hidden tab, resize, restart; keys mode) with
  a probe of the final picture found no violation, and flagged 15 of the same 42 on a build without the fix.
  The fuzz scripts live in a scratch folder, not in the repo, so that result cannot be reproduced from here.
  Measured in headless Chromium: WebGL2 is gone after the third GPU crash in one browser session (and the
  browser closes after more), so a test may crash the GPU process once per browser. Not verified: a real phone or iOS Safari, a
  real GPU reset on a device (headless SwiftShader only; a null `getContext` is a patched call), camera mode
  with a lost context. Stage 2 (the quality controller) is not done.
- Next step: open the Pages URL on a phone and try it with a real body in a real room. Then run it on
  an iPhone and a mid-range Android for 3 minutes in camera mode: pose fps >= 24 and rAF p95 <= 36 ms
  at the settled tier, or an automatic quality downgrade with the race still completing (also in Low
  Power Mode; on the view-lifecycle branch there is no 2D fallback for speed any more). If 3D hurts
  tracking on a phone, `?renderer=2d` switches it off (the View chip, key `V` and the saved choice are
  gone, see below).

## Commands

- `npm run build`: writes `docs/index.html`. Never edit that file; edit `src/` and rebuild.
- `npm install`: three (pinned 0.186.0) and MediaPipe. Needed for the 3D geometry tests and the 3D
  browser runs (B, C, D2, E); without it those skip and `npm test` still passes.
- `npm test`: unit tests (Node only).
- `npm run serve`: http://localhost:8000. The camera works on localhost or https only.
- `npm run test:browser`: Playwright runs B, C, D, E; strict, any failed check exits 1. B and C run as
  3D (`?tier=3`, SwiftShader) and as `?renderer=2d`; C also with a held-back three.js (`late`); D has a
  second part D2 (WebGL2 missing or never available); E is context loss. It tests `docs/index.html`, so
  build first (it fails if the file is stale). Run A needs local assets, see README.md.
- URL params: `?renderer=2d` shows the classic view (developer and test override, never saved);
  `?tier=0..3` locks the 3D quality tier. Key `D` toggles the signals panel. There is no View chip, no
  View choice on the intro card and no `V` key.

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
- Quality tiers T0 to T3 (`Geom.TIERS`: pixel-ratio and megapixel caps, particles, far plane, 30 fps
  at T3). `Geom.QualityController` only steps down; when it gives up (its 'slow' / 'emergency'
  verdict) the scene tells the app, and the app only logs `speed-fallback-ignored` and stays in 3D:
  slow is never a reason to leave 3D (reworking the controller itself, whose pose-rate rule has no 2D
  baseline any more, is still to do). Start tier: coarse pointer T1, else T0, stepped from a tier
  remembered in `lanefour.tier3d` for 14 days. A scene made again after a context loss starts at the
  tier the old one had reached.
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
- `test/viewlife.test.js` drives the state machine with a fake clock and scenes, including 400 random
  sequences with invariants (3D unless failed, one live scene, ready means drawing, a hard failure
  leaves no timer behind). `test/assets3d.test.js` and `test/world3d.test.js` check `repaintTextures()` and
  `texturesIntact()` with canvases that can be emptied the way a GPU crash empties them.
- `test/browser_test.py` is only the runner; the runs are in `test/browser_tests/` (`run_a.py` to `run_e.py`,
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
- `Geom.QualityController` takes the device's own first 3 s as its frame-rate target, so it cannot
  tell that a phone is slow from the very first frame (a steady 25 fps from the start never steps a
  tier down). It does catch a device that slows later, a slow pose model in camera mode (poseFps
  below 22 and below 0.8x the 2D baseline), and the emergency floor of under 12 fps. Settle this with
  real phone data before adding an absolute rule. On the view-lifecycle branch there is no 2D phase, so
  no 2D baseline is ever learned: the pose rule is the absolute floor alone, and its verdicts only
  lower the tier (a give-up is ignored by the app).
- Only one exercise loop. No music; sound is WebAudio synth plus speechSynthesis.
