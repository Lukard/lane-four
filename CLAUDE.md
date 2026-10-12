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
- Not published yet. Next step: public GitHub repo `lane-four` with Pages serving `main` + `/docs`,
  so the game opens on a phone over https. The owner may already have created the repo by hand and
  uploaded an `index.html` at its root; check with `gh repo view` before creating anything.
- Not a git repository yet.

## Commands

- `npm run build`: writes `docs/index.html`. Never edit that file; edit `src/` and rebuild.
- `npm test`: unit tests (Node only, no install needed).
- `npm run serve`: http://localhost:8000. The camera works on localhost or https only.
- `npm run test:browser`: Playwright runs B and C. Run A needs local assets, see README.md.

## Architecture

- `build.js` inlines `src/style.css`, `src/core.js` and `src/app.js` into `src/page.html`. The
  result is one self-contained page. Inlined code must not contain `</script`.
- Network deps, all pinned: `@mediapipe/tasks-vision@1.0.1` UMD bundle and wasm from jsDelivr
  (global `Vision`), `pose_landmarker_lite` float16 model from storage.googleapis.com, Google Fonts
  (Barlow, Big Shoulders Display, Doto).
- `src/core.js` has no DOM access and attaches `LaneFour` to the global object, so Node tests load
  it directly. `src/app.js` is the browser IIFE and exposes `window.laneFour = { state, settings }`
  for debugging and the browser tests.
- Phases: intro, setup (calibration), ready (raise both hands, or Enter), countdown, running,
  paused (body out of frame for 1.2 s, or tab hidden), finished, results.
- Pose math runs in a virtual frame 480 units tall (`FRAME_H`), so thresholds don't depend on
  camera resolution. Landmarks pass through a One Euro filter (minCutoff 1.7, beta 0.03).

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
- iOS Safari untested (wake lock, speech, fullscreen). The GPU delegate falls back to CPU on its own.
- Only one exercise loop. No music; sound is WebAudio synth plus speechSynthesis.
