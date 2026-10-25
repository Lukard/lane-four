# Lane Four

Camera-tracked hurdles prototype. Jog in place to run, squat to jump.
MediaPipe Pose Landmarker (lite) runs in the browser, and video never leaves the device.

## Layout

- `src/core.js`: pose signals, step/squat/hands-up detectors, race simulation (no DOM)
- `src/geom.js`: runner pose, chase-camera rigs, the chase camera itself, projection, quality tiers and controller (no DOM)
- `src/assets3d.js`, `src/world3d.js`: the 3D stadium: procedural textures (and the check that they survived a lost context), track, stands, hurdles, finish
- `src/actors3d.js`, `src/scene3d.js`: the 3D runner, particles and popups; the WebGL renderer, chase camera, quality tiers, context loss events
- `src/viewlife.js`: the view lifecycle as a state machine (loading, ready, restoring a lost context, hard failure; no DOM)
- `src/app.js`: camera, MediaPipe, game loop, the classic 2D canvas view (hard failure and `?renderer=2d` only), the three.js loader, the page's side of the view lifecycle, UI
- `src/style.css`, `src/page.html`: styles and page template
- `build.js`: inlines everything into `docs/index.html` (the page GitHub Pages serves); three.js itself loads separately from a CDN
- `test/core.test.js`: detector and race tests on synthetic pose sequences (`test/synth.js`)
- `test/geom.test.js`, `test/quality.test.js`, `test/assets3d.test.js`, `test/world3d.test.js`, `test/actors3d.test.js`, `test/scene3d.test.js`, `test/viewlife.test.js` (with `viewlife.fuzz.test.js`), `test/build.test.js`: unit tests for the 3D modules, the quality controller, the view lifecycle and the build (no GPU)
- `test/fake-vision.js`: stand-in for MediaPipe that plays the game with a scripted body
- `test/browser_test.py`, `test/browser_tests/`: headless Chromium runs of the whole page (the runner, and one module per run): 3D, a late three.js, hard failures, context loss including a real GPU process crash, the quality controller under stress (run F), and `?renderer=2d`

## Commands

    npm run build          # writes docs/index.html
    npm test               # unit tests; the three.js geometry tests skip themselves without npm install
    npm run serve          # http://localhost:8000 (camera works on localhost)
    npm run test:browser   # browser runs B, C, D, E and F (about 11 minutes), needs Playwright and npm install

Browser tests need Playwright once: `pip install playwright && python3 -m playwright install chromium`.
The 3D runs (B, C, D2, E, F) also need `npm install` (three.js is pinned in `package.json`; the tests serve it
from `node_modules/three` in place of the CDN). Without it they print SKIP and run D still checks the hard
failure. The runs are strict: any failed check makes the command exit 1. They test `docs/index.html`, so
run `npm run build` first (the test says so if it is stale). Screenshots go to `test/shots/`, suffixed
`_3d`, `_2d` or `_late` where a run has flavours.

Run A loads the real tracking model against a still photo used as the camera. It needs local copies of
what the page normally fetches:

    npm install            # @mediapipe/tasks-vision 1.0.1
    mkdir -p test/assets
    curl -L -o test/assets/pose_landmarker_lite.task \
      https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
    ffmpeg -loop 1 -i person.jpg -t 1 -r 30 -pix_fmt yuv420p \
      -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2" \
      test/assets/fake-camera.y4m
    python3 test/browser_test.py A

Use a full-body photo for `person.jpg` so tracking sees feet as well as the upper body.

## Playing it

The camera needs a secure page: `localhost` or `https://`. Claude's in-app artifact preview blocks
the camera. GitHub Pages works for phones: serve from the `main` branch, `/docs` folder.

## The view: 3D, and when it is not

The game is 3D: a chase camera behind the runner (three.js, loaded from a CDN). There is no player-facing
choice of view, and nothing swaps between 3D and 2D for speed, connection, data saving or a lost context.

- three.js starts loading when the page does, on every device. While it loads nothing is drawn in 2D: the
  intro card sits on the plain night background and both Start buttons say "Loading stadium…" until the 3D
  scene has drawn its first frame, so the first race is already 3D.
- The classic side view shows only after a hard failure, or under `?renderer=2d` (developer and test
  override, never saved). Hard failures: three.js cannot load from either CDN host (or times out), WebGL2 is
  missing, the scene cannot be created after three automatic attempts over a few seconds, or the graphics
  context keeps being lost. The page then says why in a notice that stays, with a Reload button, and the
  Signals panel says why too. The load timeout is 12 s per CDN host and covers the whole three.js module
  graph, so on a link slower than that the page shows "Loading stadium…" for up to about 24 s and then
  takes the hard failure; Reload is the retry.
- A lost graphics context is recovered in place: the scene keeps its canvas, a running race pauses under a
  "Restoring graphics…" notice, and a restore resumes it. If no restore comes within 3 s, or the tab is
  visible with a lost context, the scene is made again on a fresh canvas. Three automatic attempts, then a
  hard failure; the count resets after 30 s of stable drawing.
- A restored context is not trusted until its picture is checked. When the GPU process dies, the browser
  empties the 2D canvases behind the stadium textures along with the WebGL context (measured with a real
  crash in headless Chromium), so a plain restore draws a black track and black stands. The scene paints
  the textures again on every restore and reads them back before it draws; if they are still blank it asks
  for a new scene at once, and the canvas stays faded out until a frame has really been drawn.
- Quality is the only thing that ever changes with speed, and it only goes down. A phone starts at tier T1, a
  computer at T0 (one step above a tier remembered from an earlier visit for 14 days). The controller watches
  the frame rate while you play and steps one tier down when the device slows well below what it did when the
  tier began (or stays under 18 fps), and goes straight to the lowest tier, T3, if the page crawls under 12 fps.
  A steady 30, 24 or 20 fps (Low Power Mode, Energy Saver) is taken as the display's rate, not as slowness, and
  the camera's frame rate never counts. It measures only while you are playing, never behind the intro or results
  sheets, and a step waits for a moment that is not the countdown or the race (an emergency does not wait). A step
  down is silent; reaching the lowest tier shows one small line, "Reduced graphics for smooth play", and a device
  still under 15 fps there for 10 s gets a hint with tips, once; both can be dismissed. There is no switch to
  2D for speed.
- `?tier=0..3` locks the 3D quality tier (3 is the lowest) and keeps the controller out of it (developer and
  test override).
- The Signals panel (`D`) shows the 3D view line (quality tier and where it started, frame rate, the controller's
  target and state), the tracking rate on its own line (the camera's, not the 3D's), and the last few view
  events (loading, loss, restore, re-creation, failure, every tier step with its reason) with their times.

Performance on real phones has not been measured yet, and nothing here has run on a real phone, iOS Safari
or a real GPU reset: context loss is tested in headless Chromium with `WEBGL_lose_context` and with a real GPU
process crash injected over the DevTools protocol, and the quality controller with synthetic frame timelines
and, in the page, a camera that delivers 15 or 20 fps, a cadence cap to 30 fps, and a stalled main thread. Every
quality threshold is a starting value until a real phone has been through it.

## How detection works

- **Calibration**: stand still for 1 s. Records leg length relative to shoulder width and the noise
  floor of each signal; thresholds never drop below about 3x that noise.
- **Steps**: `(left ankle + knee height) - (right ankle + knee height)`, in leg lengths. A step counts
  each time the raised side flips. Squats and hops cancel out.
- **Squat depth**: how much hip-to-planted-ankle distance shrinks, normalized by shoulder width, so
  walking toward the camera doesn't read as a squat. 1.0 is roughly thighs parallel.
- **Start gesture**: both hands above the head for 0.5 s.
