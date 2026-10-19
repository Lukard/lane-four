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
- Next step: open the Pages URL on a phone and try it with a real body in a real room. Then run it on
  an iPhone and a mid-range Android for 3 minutes in camera mode: pose fps >= 24 and rAF p95 <= 36 ms
  at the settled tier, or an automatic downgrade or 2D fallback with the race still completing (also
  in Low Power Mode). If 3D hurts tracking on a phone, the chip, `V` or `?renderer=2d` switch it off.

## Commands

- `npm run build`: writes `docs/index.html`. Never edit that file; edit `src/` and rebuild.
- `npm install`: three (pinned 0.186.0) and MediaPipe. Needed for the 3D geometry tests and browser
  runs B, C, E; without it those skip and `npm test` still passes.
- `npm test`: unit tests (Node only).
- `npm run serve`: http://localhost:8000. The camera works on localhost or https only.
- `npm run test:browser`: Playwright runs B, C, D, E; strict, any failed check exits 1. B and C run
  twice: `?renderer=3d&tier=3` (SwiftShader) and `?renderer=2d`. It tests `docs/index.html`, so build
  first (it fails if the file is stale). Run A needs local assets, see README.md.
- URL params: `?renderer=2d|3d` overrides the saved choice for that load; `?tier=0..3` locks the 3D
  quality tier. Keys: `V` toggles the view, `D` the signals panel.

## Architecture

- `build.js` inlines `src/style.css`, `core.js`, `geom.js`, `assets3d.js`, `world3d.js`, `actors3d.js`,
  `scene3d.js` and `app.js` (that load order) into `src/page.html`. The result is one self-contained
  page except for three.js. Inlined code must not contain `</script`. It also replaces
  `__THREE_VERSION__` everywhere (import map, `THREE_URLS`) with `package.json` devDependencies.three,
  which must be an exact x.y.z. `require('./build.js').build()` returns the HTML without writing.
- Network deps, all pinned: `@mediapipe/tasks-vision@1.0.1` UMD bundle and wasm from jsDelivr
  (global `Vision`), `pose_landmarker_lite` float16 model from storage.googleapis.com, Google Fonts
  (Barlow, Big Shoulders Display, Doto), and `three@0.186.0` `three.module.min.js`, imported on
  demand from jsDelivr, then cdnjs. An import map in page.html points the module's `./three.core.js`
  at the minified core on each host. Failed imports are cached by the browser, so each URL is tried
  once per page load; reloading is the only retry. The browser tests serve three from `node_modules`.
- `src/core.js` and `src/geom.js` have no DOM access and attach to the global `LaneFour`, so Node
  tests load them directly. `assets3d.js`, `world3d.js`, `actors3d.js` and `scene3d.js` take THREE as
  an argument (classic IIFEs, no imports, no addons). `src/app.js` is the browser IIFE and exposes
  `window.laneFour = { state, settings, view }` for debugging and the browser tests;
  `view.scene` has `stats()`, `project(x, y, z)`, `probe()`, `forceContextLoss()`, `setTier(n)`.
- Phases: intro, setup (calibration), ready (raise both hands, or Enter), countdown, running,
  paused (body out of frame for 1.2 s, or tab hidden), finished, results.
- Pose math runs in a virtual frame 480 units tall (`FRAME_H`), so thresholds don't depend on
  camera resolution. Landmarks pass through a One Euro filter (minCutoff 1.7, beta 0.03).

## 3D view, and why

- Chase camera behind the runner, one of three rigs by aspect (portrait under 1.0, standard under
  1.9, wide) in `Geom.RIGS`. Pitch is re-solved every frame to keep the feet on a fixed screen row.
  Camera x is exactly `r.x - back`, never smoothed, because a hit drops speed to 35% in one step.
- Axes: three X = race x, Y up, Z = minus race z (one negation keeps left on the left, infield on
  screen-left). The mirrored Z is the likeliest place for a bug. Unlit `MeshBasicMaterial`, fog,
  about 20 draw calls and 3 to 4k triangles; no lights, shadows or antialiasing.
- Hurdles in state `up` scale to 1.4x with distance (`Geom.farScale`) so the whole hurdle, ground to
  board top, is at least 24 px at 14 m in all three rigs (browser runs measure it). The wide rig sits
  6.5 m back, not the spec's 6.0, or its hurdle top rose above the HUD line at 14 m.
- Quality tiers T0 to T3 (`Geom.TIERS`: pixel-ratio and megapixel caps, particles, far plane, 30 fps
  at T3). `Geom.QualityController` only steps down, then gives up to 2D. Start tier: coarse pointer
  T1, else T0, stepped from a tier remembered in `lanefour.tier3d` for 14 days.
- `view` in app.js: `mode` ('2d' | '3d', what is on screen) and `status` (idle, loading, ready,
  failed). Fine-pointer desktops fetch three.js in idle time on load; everything else on the first
  Start press; `?renderer=2d`, Save-Data and 2G skip it unless the player picks 3D. A swap into 3D
  happens in intro, setup and ready (the toggle also in paused and finished), never in a race: if
  three arrives after the countdown, that race finishes in 2D. The 3D canvas stays hidden until its
  first frame; 250 ms later the 2D canvas is released (1x1, layers freed) and rebuilt on the way back.
- Failures land in 2D with a toast, never a dead game: no WebGL2, import error or 12 s timeout, or
  `create()` throwing (status failed); too slow (stays in 2D until the player picks 3D again);
  context lost (one retry with the toggle). The saved choice is never changed by a failure.
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
- `test/browser_test.py`: D aborts every three.js URL (race finishes in 2D, toast, status failed); E
  calls `forceContextLoss()` in ready (lands in 2D, race continues, then one retry). The 3D runs
  assert probe pixels, draw calls and triangles, flat geometry and texture counts, camera x, the
  next hurdle's size at 14 m and the wide rig after rotating. The 2D screenshots differ from the
  pre-3D ones by the new `3D` chip in the HUD and the View buttons on the intro card (which now
  needs a small scroll on a 390x844 phone), apart from the usual timing-dependent numbers.

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
  real phone data before adding an absolute rule.
- The View choice made the intro card taller: on a 390x844 phone the privacy note needs a small scroll.
- Only one exercise loop. No music; sound is WebAudio synth plus speechSynthesis.
